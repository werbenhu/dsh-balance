/**
 * 余额面板 —— Host 侧。
 *
 * 做三件事：
 *   1. 从 DSH 的配置里找出已配置的模型供应商（只读公开配置，不碰密钥）；
 *   2. 按每个供应商选定的「余额查询方式」调对应官方接口；
 *   3. 通过插件自己的同源路由把聚合结果交给前端。
 *
 * 密钥只在 Host 侧短暂存在：从凭据服务或环境变量取到后直接用于请求，
 * 不回传给浏览器，也不写进任何文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { detectVendor, queryAccountBalance, queryBalance, VENDORS } from './src/adapters.js'
import { PROXY_MODES, ProxyRouter, normalizeProxyUrl, providerHosts } from './src/proxy.js'
import { XAI_TOKEN_REF, XaiOAuthService } from './src/xai-oauth.js'

export const name = 'dsh-balance-panel'
export const version = '0.2.0'

/** 官方登录余额在内部使用的查询方式 id；不出现在可选列表里。 */
const ACCOUNT_VENDOR = 'deepseek-account'

/** 配置默认值。全部可在 profile 的 cordis.patch.yml 里按同 id 覆盖。 */
const DEFAULTS = {
  /** 服务端结果缓存，避免每次打开抽屉都打一遍上游接口。 */
  cacheMs: 30_000,
  /** 单个请求的超时。慢的是上游，不是本地。 */
  timeoutMs: 10_000,
  /** 按供应商名覆盖查询方式，例如 { glm: 'glm-coding' }。 */
  vendors: {},
  /** 这些供应商不查询（仍然显示，只是不发请求）。 */
  disabled: [],
  /** 自动把 xAI 模型路由写进 llm-pi-ai（走官方 configEditor，用户不用碰 YAML）。 */
  xaiAutoProvider: true,
  /** xAI 令牌文件位置；空串 = $DSH_HOME/xai-oauth.json。 */
  xaiPath: '',
}

const CONFIG_KEYS = Object.keys(DEFAULTS)

function resolveConfig(raw) {
  const out = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object') return out

  if (Number.isFinite(raw.cacheMs) && raw.cacheMs >= 0 && raw.cacheMs <= 600_000) {
    out.cacheMs = Math.trunc(raw.cacheMs)
  }
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs >= 1000 && raw.timeoutMs <= 120_000) {
    out.timeoutMs = Math.trunc(raw.timeoutMs)
  }
  if (raw.vendors !== null && typeof raw.vendors === 'object') {
    const vendors = {}
    for (const [key, value] of Object.entries(raw.vendors)) {
      if (typeof key !== 'string' || typeof value !== 'string') continue
      if (!VENDORS.some((item) => item.id === value)) continue
      vendors[key] = value
    }
    out.vendors = vendors
  }
  if (Array.isArray(raw.disabled)) {
    out.disabled = raw.disabled.filter((item) => typeof item === 'string')
  }
  if (typeof raw.xaiAutoProvider === 'boolean') out.xaiAutoProvider = raw.xaiAutoProvider
  if (typeof raw.xaiPath === 'string') out.xaiPath = raw.xaiPath
  return out
}

/** 界面里的查询方式与卡片顺序存在插件自己的数据目录里，不改进 profile 配置。 */
function settingsPath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'data', 'balance-panel', 'settings.json')
}

/** 代理设置的默认值与清洗：url 只允许 http(s)，每家供应商 direct/proxy，缺省即跟随默认。 */
function sanitizeProxySettings(raw) {
  const out = { url: '', providers: {} }
  if (raw === null || typeof raw !== 'object') return out
  const url = normalizeProxyUrl(raw.url)
  out.url = typeof url === 'string' ? url : ''
  if (raw.providers !== null && typeof raw.providers === 'object') {
    for (const [id, mode] of Object.entries(raw.providers)) {
      if (typeof id === 'string' && id !== '' && (mode === 'direct' || mode === 'proxy')) out.providers[id] = mode
    }
  }
  return out
}

function loadSettings() {
  try {
    const path = settingsPath()
    if (!existsSync(path)) return { vendors: {}, order: [], proxy: sanitizeProxySettings() }
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { vendors: {}, order: [], proxy: sanitizeProxySettings() }
    const vendors = {}
    if (parsed.vendors !== null && typeof parsed.vendors === 'object') {
      for (const [key, value] of Object.entries(parsed.vendors)) {
        if (typeof value === 'string' && VENDORS.some((item) => item.id === value)) vendors[key] = value
      }
    }
    const order = Array.isArray(parsed.order)
      ? [...new Set(parsed.order.filter((item) => typeof item === 'string'))]
      : []
    return { vendors, order, proxy: sanitizeProxySettings(parsed.proxy) }
  } catch {
    return { vendors: {}, order: [], proxy: sanitizeProxySettings() }
  }
}

function saveSettings(settings) {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * 列出 DSH 已配置的供应商。
 *
 * 读 `configEditor.configuration()` 而不是猜配置文件位置：那里同时有用户
 * override 与继承值，两层都要看，否则会漏掉写在 profile 里的 providers。
 */
export function discoverProviders(ctx) {
  const out = []
  const seen = new Set()
  try {
    const editor = ctx.get('configEditor')
    if (editor === undefined) return out
    for (const row of editor.configuration()) {
      const rowId = row?.entry?.options?.id ?? ''
      for (const layer of [row?.override, row?.inherited]) {
        if (layer === null || typeof layer !== 'object') continue

        const providers = layer.providers
        if (providers !== null && typeof providers === 'object') {
          for (const [id, entry] of Object.entries(providers)) {
            if (seen.has(id)) continue
            const baseUrl = entry?.baseURL ?? entry?.baseUrl ?? entry?.base_url
            if (typeof baseUrl !== 'string' || baseUrl === '') continue
            seen.add(id)
            out.push({
              id,
              label: String(entry?.displayName ?? entry?.display_name ?? id),
              baseUrl,
              apiKeyEnv: typeof entry?.apiKeyEnv === 'string' ? entry.apiKeyEnv : undefined,
            })
          }
        }

        // 单 provider 形态：baseURL 挂在配置顶层
        const direct = layer.baseURL ?? layer.baseUrl ?? layer.base_url
        if (typeof direct === 'string' && direct !== '' && rowId !== '' && !seen.has(rowId)) {
          seen.add(rowId)
          out.push({
            id: rowId,
            label: String(layer.displayName ?? rowId),
            baseUrl: direct,
            apiKeyEnv: typeof layer.apiKeyEnv === 'string' ? layer.apiKeyEnv : undefined,
          })
        }
      }
    }
  } catch {
    // configEditor 不可用就返回空列表：抽屉会显示「没有找到已配置的供应商」
  }
  return out
}

/**
 * DSH 里登录的 DeepSeek 官方账号。
 *
 * 它是「账号级」余额，不挂在任何 provider 上：只要本地存着登录凭据就补一张卡。
 * `getState()` 只读本地凭据（不发网络请求），所以每次聚合都能廉价地问一次。
 */
export async function discoverAccountProvider(ctx) {
  try {
    const account = ctx.get('deepseekAccount')
    if (account === undefined || account === null) return undefined
    if (typeof account.getState !== 'function' || typeof account.getBalance !== 'function') return undefined
    const state = await account.getState()
    if (state?.status !== 'credential-stored') return undefined
    return {
      id: ACCOUNT_VENDOR,
      label: 'DeepSeek 账号',
      baseUrl: 'https://api.deepseek.com',
      account: true,
    }
  } catch {
    // 凭据存储不可用 / 记录损坏：不显示，不影响其它供应商
    return undefined
  }
}

/**
 * 取供应商的 API Key。
 *
 * 顺序：凭据服务（DSH 里填过的）→ 进程环境变量。取不到返回空串，让适配器
 * 给出「没有可用密钥」而不是抛异常。
 */
export async function resolveApiKey(ctx, apiKeyEnv) {
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') return ''

  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const info = await credentials.describe?.(apiKeyEnv)
      if (info?.configured === true) {
        const resolved = await credentials.resolve?.(apiKeyEnv)
        if (typeof resolved?.value === 'string' && resolved.value !== '') return resolved.value
      }
    }
  } catch {
    // 凭据服务不可用时继续看环境变量
  }

  const fromEnv = process.env[apiKeyEnv]
  return typeof fromEnv === 'string' ? fromEnv : ''
}

/**
 * xAI 模型路由的默认字段。
 *
 * 不写 models：llm-pi-ai 会用内置目录里 xai 的全部模型（grok-4.x 系列），
 * 新型号随宿主目录升级自动出现，插件不用跟着发版。
 */
export const XAI_PROVIDER_DEFAULTS = {
  displayName: 'xAI (Grok)',
  api: 'openai-responses',
  baseURL: 'https://api.x.ai/v1',
  apiKeyEnv: XAI_TOKEN_REF,
}

function withXaiDefaults(existing) {
  const source = existing !== null && typeof existing === 'object' ? existing : {}
  const next = { ...source }
  for (const key of ['displayName', 'api', 'baseURL']) {
    if (next[key] === undefined) next[key] = XAI_PROVIDER_DEFAULTS[key]
  }
  // 凭据来源固定是 OAuth 服务发布的引用，这是插件的本职，必须覆盖旧值
  next.apiKeyEnv = XAI_TOKEN_REF
  return next
}

/**
 * 确保 `llm-pi-ai` 里有可用的 xai 路由 —— 用户不需要手工编辑任何配置文件。
 *
 * 走 DSH 官方的 configEditor（和「设置 → 模型」页同一条写入路径）：校验、
 * 落盘、Loader 热重载一次完成，插件重启后也不会重复写（字段齐了就直接返回）。
 * 用户已有的 models / 其它自定义字段原样保留。
 */
export async function ensureXaiProvider(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    return { ok: false, reason: 'config-editor-unavailable' }
  }
  const entry = (editor.entries() ?? []).find((item) =>
    item?.options?.name === '@deepseek-ai/dsh-llm-pi-ai' || item?.options?.id === 'llm-pi-ai')
  if (entry === undefined) return { ok: false, reason: 'llm-pi-ai-not-mounted' }

  const existing = entry.options?.config?.providers?.xai
  const merged = withXaiDefaults(existing)
  const before = existing ?? {}
  const changed = Object.keys(merged).some((key) => merged[key] !== before[key])
  if (!changed) return { ok: true, changed: false }

  await editor.edit(entry, (current) => ({
    ...current,
    providers: {
      ...(current?.providers ?? {}),
      xai: withXaiDefaults(current?.providers?.xai),
    },
  }))
  return { ok: true, changed: true }
}

/** 同源校验：插件路由不经过 DSH 自己的来源检查，这里自己补一道。 */
export function isTrustedRequest(req) {
  const headers = req?.headers ?? {}
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined || origin === '') return true
  // DSH Desktop 的特权 Web 源；本机控制服务同源路由，等同于本地页面
  if (String(origin) === 'dsh-app://app') return true
  try {
    const host = new URL(String(origin)).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx, rawConfig) {
  const logger = ctx.logger ?? console
  const config = resolveConfig(rawConfig)
  const settings = loadSettings()

  /** 生效的查询方式：手动设置 > 配置覆盖 > 按地址自动识别。 */
  const vendorOf = (provider) => {
    // 官方登录是账号级的，不挂在任何 provider 上，选择器里也不会出现
    if (provider.account === true) return { vendor: ACCOUNT_VENDOR, source: 'account' }
    const manual = settings.vendors[provider.id]
    if (manual !== undefined) return { vendor: manual, source: 'manual' }
    const configured = config.vendors[provider.id]
    if (configured !== undefined) return { vendor: configured, source: 'config' }
    const detected = detectVendor(provider.baseUrl)
    if (detected !== undefined) return { vendor: detected, source: 'auto' }
    return { vendor: 'auto', source: 'unknown' }
  }

  /** 账号服务要的客户端标识，只进请求头：版本 / 语言 / 时区偏移（秒，东为正）。 */
  const accountClient = {
    version: process.env.DSH_CLIENT_VERSION ?? '0.0.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }

  /** 结果缓存：key 是 `${id}:${vendor}`，换查询方式后自然失效。 */
  const cache = new Map()

  // —— xAI：OAuth 登录 + 自动续期 + 模型路由自动配置 ——

  /** 登录/退出后余额立刻可刷新；登录成功顺手把模型路由补齐。 */
  function ensureWithRetry(attempt = 0) {
    if (!config.xaiAutoProvider) return
    void (async () => {
      try {
        const outcome = await ensureXaiProvider(ctx)
        if (outcome.ok) {
          logger?.info?.(`[balance-panel] xAI 模型路由已就绪${outcome.changed ? '（已自动写入，无需手改配置）' : ''}`)
          return
        }
      } catch (error) {
        logger?.warn?.(`[balance-panel] xAI 路由自动配置失败：${String(error?.message ?? error)}`)
      }
      if (attempt < 4) {
        const retry = setTimeout(() => ensureWithRetry(attempt + 1), 3000)
        retry.unref?.()
      }
    })()
  }

  const xai = new XaiOAuthService({
    ctx,
    filename: config.xaiPath === '' ? undefined : config.xaiPath,
    logger,
    onLogin: () => {
      cache.clear()
      ensureWithRetry()
    },
    onLogout: () => cache.clear(),
  })

  // —— 按供应商的代理分流：模型 API 与余额/OAuth 共用同一个全局路由 ——

  const proxyRouter = new ProxyRouter({ logger })

  /** 让路由与「providers 配置 × 代理设置」一致；规则没变化时内部直接返回。 */
  const syncProxy = async () => {
    const discovered = discoverProviders(ctx)
    const byId = new Map(discovered.map((provider) => [provider.id, provider]))
    // 还没出现在配置里的供应商也允许预设（例如先给 xai 配代理再登录）
    const ids = new Set([...byId.keys(), ...Object.keys(settings.proxy.providers)])
    const rules = new Map()
    for (const id of ids) {
      const mode = settings.proxy.providers[id] ?? 'default'
      if (mode === 'default') continue
      const provider = byId.get(id) ?? { id, baseUrl: id === 'xai' ? XAI_PROVIDER_DEFAULTS.baseURL : undefined }
      const vendor = byId.has(id) ? vendorOf(provider).vendor : id === 'xai' ? 'grok' : undefined
      for (const host of providerHosts({ ...provider, vendor })) rules.set(host, mode)
    }
    await proxyRouter.sync({ proxyUrl: settings.proxy.url, rules })
  }

  ctx.effect(() => {
    void xai.restore().catch((error) => {
      logger?.warn?.(`[balance-panel] xAI 登录态恢复失败：${String(error?.message ?? error)}`)
    })
    const stopTimer = xai.startRefreshTimer()
    const deferred = setTimeout(() => ensureWithRetry(), 1500)
    deferred.unref?.()
    const proxyDeferred = setTimeout(() => {
      void syncProxy().catch((error) => {
        logger?.warn?.(`[balance-panel] 代理路由初始化失败：${String(error?.message ?? error)}`)
      })
    }, 100)
    proxyDeferred.unref?.()
    return () => {
      clearTimeout(deferred)
      clearTimeout(proxyDeferred)
      stopTimer()
      void proxyRouter.dispose()
    }
  }, 'balance-panel: xAI')

  const probe = async (provider) => {
    const { vendor, source } = vendorOf(provider)
    const key = `${provider.id}:${vendor}`
    const cached = cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < config.cacheMs) return cached

    if (config.disabled.includes(provider.id)) {
      const entry = {
        ...provider, vendor, vendorSource: source,
        result: { ok: true, kind: 'none' },
        fetchedAt: cached?.at ?? Date.now(),
        cached: true,
      }
      cache.set(key, { at: entry.fetchedAt, entry })
      return { at: entry.fetchedAt, entry }
    }

    let result
    if (provider.account === true) {
      result = await queryAccountBalance({
        account: ctx.get('deepseekAccount'),
        client: accountClient,
      })
    } else {
      const apiKey = await resolveApiKey(ctx, provider.apiKeyEnv)
      // Grok 走 OAuth 服务自己持有的令牌，没有 apiKeyEnv 也能查
      result = apiKey === '' && vendor !== 'grok'
        ? {
          ok: false,
          error: provider.apiKeyEnv === undefined
            ? '该供应商没有配置 apiKeyEnv，读不到密钥'
            : `读不到密钥：凭据与环境变量里都没有 ${provider.apiKeyEnv}`,
        }
        : await queryBalance({
          vendor,
          baseUrl: provider.baseUrl,
          apiKey,
          timeoutMs: config.timeoutMs,
          xai,
        })
    }

    const entry = {
      ...provider,
      vendor,
      vendorSource: source,
      result,
      fetchedAt: Date.now(),
    }
    const at = entry.fetchedAt
    cache.set(key, { at, entry })
    return { at, entry }
  }

  /** 当前要展示的全部供应商：配置里的 + （登录了的话）官方账号，按界面保存的顺序排列。 */
  const allProviders = async () => {
    const configured = discoverProviders(ctx)
    const account = await discoverAccountProvider(ctx)
    const providers = account === undefined ? configured : [account, ...configured]
    const positions = new Map(settings.order.map((id, index) => [id, index]))
    return providers.sort((a, b) =>
      (positions.get(a.id) ?? positions.size) - (positions.get(b.id) ?? positions.size))
  }

  const snapshot = async (force) => {
    // 供应商可能刚改过配置，查询前先让代理规则跟上（没变化时零开销）
    await syncProxy().catch((error) => {
      logger?.warn?.(`[balance-panel] 代理路由同步失败：${String(error?.message ?? error)}`)
    })
    const providers = await allProviders()
    if (force) {
      for (const provider of providers) cache.delete(`${provider.id}:${vendorOf(provider).vendor}`)
    }
    const results = await Promise.all(providers.map((provider) => probe(provider).catch((error) => ({
      at: Date.now(),
      entry: {
        ...provider,
        vendor: 'auto',
        vendorSource: 'unknown',
        result: { ok: false, error: String(error?.message ?? error) },
        fetchedAt: Date.now(),
      },
    }))))
    return {
      fetchedAt: Date.now(),
      providers: results.map((item) => item.entry),
    }
  }

  /** 只刷一家：删掉它的缓存再查一次，其它家的结果不动。 */
  const refreshOne = async (id) => {
    const provider = (await allProviders()).find((item) => item.id === id)
    if (provider === undefined) return undefined
    cache.delete(`${provider.id}:${vendorOf(provider).vendor}`)
    const result = await probe(provider)
    return result.entry
  }

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer
    webCtx.effect(() => server.register({
      kind: 'prefix',
      path: '/api/dsh-balance-panel',
      handler: async (req, res) => {
        try {
          if (!isTrustedRequest(req)) {
            sendJson(res, 403, { error: 'forbidden' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const isGet = req.method === 'GET'

          if (url.pathname === '/api/dsh-balance-panel/summary') {
            if (!isGet) {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const force = url.searchParams.get('refresh') === '1'
            sendJson(res, 200, await snapshot(force))
            return
          }

          if (url.pathname === '/api/dsh-balance-panel/vendors') {
            if (!isGet) {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            sendJson(res, 200, { vendors: VENDORS })
            return
          }

          /**
           * 只列 id / 名称 / 生效的查询方式，不查余额、不碰密钥。
           *
           * 给「设置 → 模型」里的供应商卡片用：那里只需要知道有哪些
           * provider、当前选的是哪家，不必为每张卡片都打一次上游接口。
           */
          if (url.pathname === '/api/dsh-balance-panel/providers') {
            if (!isGet) {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            sendJson(res, 200, {
              providers: discoverProviders(ctx).map((provider) => {
                const { vendor, source } = vendorOf(provider)
                return { id: provider.id, label: provider.label, vendor, vendorSource: source }
              }),
            })
            return
          }

          if (url.pathname === '/api/dsh-balance-panel/vendor' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const provider = String(body?.provider ?? '')
            const vendor = String(body?.vendor ?? '')
            if (provider === '' || !VENDORS.some((item) => item.id === vendor)) {
              sendJson(res, 400, { error: 'provider 或 vendor 不合法' })
              return
            }
            settings.vendors[provider] = vendor
            saveSettings(settings)
            // 换方式后立刻用新实现查一次，用户不必再点刷新
            const entry = discoverProviders(ctx).find((item) => item.id === provider)
            const result = entry === undefined ? undefined : await probe(entry)
            sendJson(res, 200, {
              ok: true,
              provider,
              vendor,
              entry: result?.entry,
            })
            return
          }

          if (url.pathname === '/api/dsh-balance-panel/order' && req.method === 'POST') {
            const body = await readJsonBody(req)
            if (!Array.isArray(body?.order) || body.order.some((id) => typeof id !== 'string' || id === '')) {
              sendJson(res, 400, { error: 'order 必须是供应商 id 数组' })
              return
            }
            const known = new Set((await allProviders()).map((provider) => provider.id))
            settings.order = [...new Set(body.order.filter((id) => known.has(id)))]
            saveSettings(settings)
            sendJson(res, 200, { ok: true, order: settings.order })
            return
          }

          /**
           * 单家刷新：只清这一家的缓存再查一次，其它卡片的数字不动。
           *
           * 卡片标题栏右边那颗刷新就是打这里；整页的「刷新」走 summary?refresh=1。
           */
          if (url.pathname === '/api/dsh-balance-panel/refresh' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const provider = String(body?.provider ?? '')
            if (provider === '') {
              sendJson(res, 400, { error: 'provider 不合法' })
              return
            }
            const entry = await refreshOne(provider)
            if (entry === undefined) {
              sendJson(res, 404, { error: '没有这个供应商' })
              return
            }
            sendJson(res, 200, { ok: true, provider, entry })
            return
          }

          // —— 代理设置：全局代理地址 + 每家供应商的出口选择 ——

          if (url.pathname === '/api/dsh-balance-panel/proxy') {
            if (isGet) {
              sendJson(res, 200, { proxy: settings.proxy })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req)
            if (Object.hasOwn(body, 'url')) {
              const normalized = normalizeProxyUrl(body.url)
              if (normalized === undefined) {
                sendJson(res, 400, { error: '代理地址只支持 http(s)://，例如 http://127.0.0.1:7897' })
                return
              }
              settings.proxy.url = normalized
            }
            if (Object.hasOwn(body, 'provider') || Object.hasOwn(body, 'mode')) {
              const provider = String(body?.provider ?? '')
              const mode = String(body?.mode ?? '')
              if (provider === '' || !PROXY_MODES.includes(mode)) {
                sendJson(res, 400, { error: 'provider 或代理模式不合法' })
                return
              }
              if (mode === 'default') delete settings.proxy.providers[provider]
              else settings.proxy.providers[provider] = mode
            }
            saveSettings(settings)
            // 路由变了，旧结果可能来自另一条网络路径，全部重查
            cache.clear()
            await syncProxy()
            sendJson(res, 200, { ok: true, proxy: settings.proxy })
            return
          }

          // —— xAI 登录态与设备码授权（同源路由，不再单开端口）——

          if (url.pathname === '/api/dsh-balance-panel/xai/status') {
            if (!isGet) {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            sendJson(res, 200, await xai.status())
            return
          }

          if (url.pathname === '/api/dsh-balance-panel/xai/login' && req.method === 'POST') {
            sendJson(res, 200, await xai.startLogin())
            return
          }

          if (url.pathname === '/api/dsh-balance-panel/xai/cancel' && req.method === 'POST') {
            xai.cancelLogin()
            sendJson(res, 200, { ok: true })
            return
          }

          if (url.pathname === '/api/dsh-balance-panel/xai/logout' && req.method === 'POST') {
            if (req.headers['x-dsh-csrf'] !== xai.csrf) {
              sendJson(res, 403, { error: 'CSRF token 不正确' })
              return
            }
            await xai.logout()
            sendJson(res, 200, { ok: true })
            return
          }

          sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          logger?.warn?.(`[balance-panel] 请求失败：${String(error?.message ?? error)}`)
          sendJson(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }), 'balance-panel: 路由')
  })

  // 配置里写了不认识的键时提个醒，避免用户改了没生效还在找原因
  if (rawConfig !== null && typeof rawConfig === 'object') {
    for (const key of Object.keys(rawConfig)) {
      if (!CONFIG_KEYS.includes(key)) {
        logger?.warn?.(`[balance-panel] 未知配置项：${key}`)
      }
    }
  }
}
