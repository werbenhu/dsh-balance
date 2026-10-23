/**
 * 宿主端冒烟测试：用假 ctx 跑一遍 apply()，然后直接调路由处理器。
 *
 * 覆盖在真实 DSH 里不好观察的行为：
 *   1. 能不能从 configEditor 里把 providers 读出来；
 *   2. 密钥是不是只从凭据服务/环境变量取，取不到时给的是「读不到密钥」而不是崩；
 *   3. 换查询方式的 POST 会不会落盘并回带新结果；
 *   4. 卡片顺序会不会校验、落盘，并在重载后恢复。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply, discoverProviders, isTrustedRequest } from '../index.js'

function makeCtx({ providers, keys = {}, rowId = 'llm-pi-ai', account }) {
  const routes = []
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) {
      fn()
    },
    get(name) {
      if (name === 'deepseekAccount') return account
      if (name === 'configEditor') {
        return { configuration: () => [{ entry: { options: { id: rowId } }, override: { providers }, inherited: {} }] }
      }
      if (name === 'credentials') {
        return {
          describe: async (key) => ({ configured: Object.prototype.hasOwnProperty.call(keys, key) }),
          resolve: async (key) => ({ value: keys[key] }),
        }
      }
      return undefined
    },
    inject(deps, fn) {
      fn({
        webServer: {
          register(spec) {
            routes.push(spec)
            return () => {}
          },
        },
        effect(inner) {
          inner()
        },
      })
    },
  }
  return { ctx, routes }
}

function fakeRes() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? {}
    },
    end(body) {
      captured.body = body ?? ''
    },
  }
}

function fakeReq({ url = '/api/dsh-balance-panel/summary', method = 'GET', headers = {}, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.url = url
  stream.method = method
  stream.headers = headers
  return stream
}

const PROVIDERS = {
  deepseek: { displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  internal: { displayName: '内部网关', baseURL: 'https://gw.internal/v1', apiKeyEnv: 'GW_KEY' },
}

test('discoverProviders：从 configEditor 读出 id / 地址 / 密钥名', () => {
  const { ctx } = makeCtx({ providers: PROVIDERS })
  const providers = discoverProviders(ctx)

  assert.deepEqual(providers.map((item) => item.id), ['deepseek', 'internal'])
  assert.equal(providers[0].baseUrl, 'https://api.deepseek.com')
  assert.equal(providers[0].apiKeyEnv, 'DEEPSEEK_API_KEY')
})

test('GET /summary：按 auto 识别打对应接口，取不到密钥时给明确错误', async () => {
  const { ctx, routes } = makeCtx({ providers: PROVIDERS, keys: { DEEPSEEK_API_KEY: 'sk-deepseek' } })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('api.deepseek.com')) {
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '38.94', topped_up_balance: '30', granted_balance: '8.94' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('unexpected url ' + url)
  }

  try {
    apply(ctx, { timeoutMs: 5000 })
    const route = routes.find((item) => item.path === '/api/dsh-balance-panel')
    assert.ok(route !== undefined, '路由没注册')

    const res = fakeRes()
    await route.handler(fakeReq(), res)
    const payload = JSON.parse(res.captured.body)

    assert.equal(res.captured.status, 200)
    assert.equal(payload.providers.length, 2)

    const deepseek = payload.providers.find((item) => item.id === 'deepseek')
    assert.equal(deepseek.result.summary, '38.94')
    assert.equal(deepseek.vendor, 'deepseek')
    assert.equal(deepseek.vendorSource, 'auto')
    assert.equal(calls[0].init.headers.authorization, 'Bearer sk-deepseek')

    const internal = payload.providers.find((item) => item.id === 'internal')
    assert.equal(internal.result.ok, false)
    assert.match(internal.result.error, /GW_KEY/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST /vendor：换查询方式后立刻用新实现查一次', async () => {
  const { ctx, routes } = makeCtx({ providers: { gw: { displayName: '网关', baseURL: 'https://gw.example.com/v1', apiKeyEnv: 'GW_KEY' } }, keys: { GW_KEY: 'k' } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/user/self')) {
      return new Response(JSON.stringify({ data: { quota: 30000000 } }), { status: 200 })
    }
    return new Response('nope', { status: 404 })
  }

  try {
    apply(ctx, { timeoutMs: 5000 })
    const route = routes.find((item) => item.path === '/api/dsh-balance-panel')

    const res = fakeRes()
    await route.handler(fakeReq({
      url: '/api/dsh-balance-panel/vendor',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { provider: 'gw', vendor: 'newapi' },
    }), res)

    const payload = JSON.parse(res.captured.body)
    assert.equal(res.captured.status, 200)
    assert.equal(payload.entry.vendor, 'newapi')
    assert.equal(payload.entry.result.summary, '$60.00')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('非法 vendor 被拒绝', async () => {
  const { ctx, routes } = makeCtx({ providers: PROVIDERS })
  apply(ctx, {})
  const route = routes.find((item) => item.path === '/api/dsh-balance-panel')
  const res = fakeRes()
  await route.handler(fakeReq({
    url: '/api/dsh-balance-panel/vendor',
    method: 'POST',
    body: { provider: 'deepseek', vendor: 'not-a-vendor' },
  }), res)
  assert.equal(res.captured.status, 400)
})

test('已登录 DeepSeek 账号：聚合里多一张账号卡，走宿主账号服务', async () => {
  const account = {
    getState: async () => ({ status: 'credential-stored' }),
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '42.50' }],
      bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
    }),
  }
  const { ctx, routes } = makeCtx({ providers: {}, account })
  apply(ctx, { cacheMs: 0 })
  const route = routes.find((item) => item.path === '/api/dsh-balance-panel')

  const res = fakeRes()
  await route.handler(fakeReq(), res)
  const payload = JSON.parse(res.captured.body)

  assert.equal(payload.providers.length, 1)
  const card = payload.providers[0]
  assert.equal(card.id, 'deepseek-account')
  assert.equal(card.label, 'DeepSeek 账号')
  assert.equal(card.vendor, 'deepseek-account')
  assert.equal(card.result.summary, '42.50')
  assert.equal(card.result.currency, 'CNY')
  assert.deepEqual(card.result.details.map((item) => item.label), ['充值余额', '赠送余额'])
})

test('未登录 DeepSeek 账号：不出现账号卡', async () => {
  const account = {
    getState: async () => ({ status: 'signed-out' }),
    getBalance: async () => null,
  }
  const { ctx, routes } = makeCtx({ providers: {}, account })
  apply(ctx, { cacheMs: 0 })
  const route = routes.find((item) => item.path === '/api/dsh-balance-panel')

  const res = fakeRes()
  await route.handler(fakeReq(), res)
  assert.deepEqual(JSON.parse(res.captured.body).providers, [])
})

test('POST /refresh：只重查指定的那一家，其它家的请求不重发', async () => {
  const { ctx, routes } = makeCtx({ providers: PROVIDERS, keys: { DEEPSEEK_API_KEY: 'sk' } })
  const originalFetch = globalThis.fetch
  let deepseekCalls = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.deepseek.com')) {
      deepseekCalls += 1
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '1.00' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('nope', { status: 404 })
  }

  try {
    apply(ctx, { cacheMs: 60_000 })
    const route = routes.find((item) => item.path === '/api/dsh-balance-panel')

    // 先聚合一次，把两家都算进缓存
    await route.handler(fakeReq(), fakeRes())
    assert.equal(deepseekCalls, 1)

    // 单刷 internal：不该再去打 deepseek
    const res = fakeRes()
    await route.handler(fakeReq({
      url: '/api/dsh-balance-panel/refresh',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { provider: 'internal' },
    }), res)

    const payload = JSON.parse(res.captured.body)
    assert.equal(res.captured.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.provider, 'internal')
    assert.equal(payload.entry.id, 'internal')
    assert.equal(deepseekCalls, 1, '单刷不该连带重查别家')

    // 不存在的供应商：404
    const missing = fakeRes()
    await route.handler(fakeReq({
      url: '/api/dsh-balance-panel/refresh',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { provider: 'nope' },
    }), missing)
    assert.equal(missing.captured.status, 404)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('跨站请求被门卫拒绝', async () => {
  const { ctx, routes } = makeCtx({ providers: PROVIDERS })
  apply(ctx, {})
  const route = routes.find((item) => item.path === '/api/dsh-balance-panel')
  const res = fakeRes()
  await route.handler(fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(res.captured.status, 403)
  assert.equal(isTrustedRequest({ headers: { origin: 'http://evil.example' } }), false)
  assert.equal(isTrustedRequest({ headers: { origin: 'http://127.0.0.1:64168' } }), true)
})

test('POST /order：校验并保存卡片顺序，重载后恢复且新卡片排在后面', async () => {
  const home = mkdtempSync(join(process.cwd(), '.tmp-balance-order-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const account = {
    getState: async () => ({ status: 'credential-stored' }),
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '1.00' }] }),
  }
  const providers = {
    first: { displayName: '第一家', baseURL: 'https://first.example.com' },
    second: { displayName: '第二家', baseURL: 'https://second.example.com' },
  }
  const setup = (configured = providers) => {
    const { ctx, routes } = makeCtx({ providers: configured, account })
    apply(ctx, { cacheMs: 0 })
    return routes.find((item) => item.path === '/api/dsh-balance-panel')
  }

  try {
    const route = setup()
    const invalid = fakeRes()
    await route.handler(fakeReq({
      url: '/api/dsh-balance-panel/order',
      method: 'POST',
      body: { order: ['second', 1] },
    }), invalid)
    assert.equal(invalid.captured.status, 400)

    const saved = fakeRes()
    await route.handler(fakeReq({
      url: '/api/dsh-balance-panel/order',
      method: 'POST',
      body: { order: ['second', 'deepseek-account', 'first', 'second', 'removed'] },
    }), saved)
    assert.equal(saved.captured.status, 200)
    assert.deepEqual(JSON.parse(saved.captured.body).order, ['second', 'deepseek-account', 'first'])

    const stored = JSON.parse(readFileSync(join(home, 'data', 'balance-panel', 'settings.json'), 'utf8'))
    assert.deepEqual(stored, { vendors: {}, order: ['second', 'deepseek-account', 'first'] })

    const reloaded = fakeRes()
    await setup().handler(fakeReq(), reloaded)
    assert.deepEqual(
      JSON.parse(reloaded.captured.body).providers.map((item) => item.id),
      ['second', 'deepseek-account', 'first'],
    )

    const withNewProvider = fakeRes()
    await setup({
      ...providers,
      third: { displayName: '第三家', baseURL: 'https://third.example.com' },
    }).handler(fakeReq(), withNewProvider)
    assert.deepEqual(
      JSON.parse(withNewProvider.captured.body).providers.map((item) => item.id),
      ['second', 'deepseek-account', 'first', 'third'],
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
