/**
 * 余额/配额查询适配器 —— 纯函数，不依赖 DSH 运行时。
 *
 * 端点与解析规则照搬 one-proxy 的 `internal/service/balance.go`，结果模型也与
 * 它对齐：一条 `summary` 加若干 `details`；配额型带 `percent`（**已用百分比**）
 * 与 `resetAt`（毫秒时间戳）。前端只需两套画法：金额，或进度条。
 *
 * 三条约定：
 *   - 不抛异常。失败一律 `{ ok:false, error }` ——「没有订阅」「没有余额接口」
 *     都是要原样显示给用户的信息，不是程序错误。
 *   - 不缓存。缓存放 Host 侧，这里每次真打一次上游，便于手动刷新。
 *   - 不换算汇率。上游给什么币种就是什么币种，前端按币种加符号。
 */

/** 可选的查询方式。`label` 是下拉文案，`hint` 说明前提条件。 */
export const VENDORS = [
  { id: 'auto', label: '自动识别（按地址判断）', hint: '根据 baseURL 的域名选择下面的实现' },
  { id: 'deepseek', label: 'DeepSeek 余额', hint: '/user/balance，按量预充值' },
  { id: 'openrouter', label: 'OpenRouter 额度', hint: '/api/v1/credits，剩余 = 总额 - 已用' },
  { id: 'ollama', label: 'Ollama Cloud', hint: '/api/balance，含套餐窗口与剩余额度' },
  { id: 'moonshot', label: 'Kimi 开放平台（按量余额）', hint: '/v1/users/me/balance，不是套餐' },
  { id: 'kimi-coding', label: 'Kimi Coding 套餐', hint: '/coding/v1/usages，5 小时 / 每周窗口' },
  { id: 'zai-coding', label: 'z.ai Coding Plan', hint: '/api/monitor/usage/quota/limit' },
  { id: 'bigmodel-coding', label: '智谱 BigModel Coding Plan', hint: 'bigmodel.cn 根域的配额接口' },
  { id: 'minimax-coding', label: 'MiniMax Token Plan', hint: '/coding_plan/remains' },
  { id: 'commandcode', label: 'Command Code', hint: '/alpha/billing/credits，credits 与窗口' },
  { id: 'grok', label: 'Grok (xAI)', hint: '仅 OAuth 登录态可查，API Key 没有公开接口' },
  { id: 'siliconflow', label: 'SiliconFlow 余额', hint: '/v1/user/info 的 totalBalance' },
  { id: 'novita', label: 'Novita 余额', hint: '/v3/user/balance' },
  { id: 'stepfun', label: '阶跃星辰余额', hint: '/v1/accounts' },
  { id: 'volcano', label: '火山方舟余额', hint: '/api/v3/billing/balance' },
  { id: 'newapi', label: 'New API / One API 网关', hint: '/api/user/self 的 quota（÷500000）' },
  { id: 'sub2api', label: 'Sub2API 网关', hint: '/v1/usage 的 balance' },
  { id: 'none', label: '不查询', hint: '只在列表里显示该供应商，不发请求' },
]

/** 按域名推断。推断不出来交给用户手选，不猜。 */
const DOMAIN_RULES = [
  { vendor: 'deepseek', test: /(^|\.)api\.deepseek\.com$/ },
  { vendor: 'openrouter', test: /(^|\.)openrouter\.ai$/ },
  { vendor: 'ollama', test: /(^|\.)ollama\.(com|ai)$/ },
  { vendor: 'kimi-coding', test: /(^|\.)api\.kimi\.com$/ },
  { vendor: 'moonshot', test: /(^|\.)api\.moonshot\.(cn|ai)$/ },
  { vendor: 'zai-coding', test: /(^|\.)api\.z\.ai$/ },
  { vendor: 'bigmodel-coding', test: /(^|\.)(open\.)?bigmodel\.cn$/ },
  { vendor: 'minimax-coding', test: /(^|\.)api\.minimax\.(io|chat)$/ },
  { vendor: 'commandcode', test: /(^|\.)commandcode\.ai$/ },
  { vendor: 'grok', test: /(^|\.)(api\.x\.ai|grok\.com)$/ },
  { vendor: 'siliconflow', test: /(^|\.)api\.siliconflow\.(cn|com)$/ },
  { vendor: 'novita', test: /(^|\.)api\.novita\.ai$/ },
  { vendor: 'stepfun', test: /(^|\.)api\.stepfun\.(ai|com)$/ },
  { vendor: 'volcano', test: /(^|\.)ark\.[a-z0-9-]+\.volces\.com$/ },
]

/** 按 baseURL 推断查询方式；推断不出来返回 undefined。 */
export function detectVendor(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined
  let host
  try {
    host = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
  for (const rule of DOMAIN_RULES) {
    if (rule.test.test(host)) return rule.vendor
  }
  return undefined
}

//#region 工具

const num = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 四舍五入（Go 的 int(x+0.5)），用于各类百分比。 */
const round = (value) => Math.round(value)

/** 美元金额：给定小数位就定长，否则按最短表示。 */
const usd = (value, digits) => {
  if (value === undefined) return undefined
  if (digits === undefined) return `$${value}`
  return `$${value.toFixed(digits)}`
}

/** 取 origin：配置里的 baseURL 常带 /v1、/anthropic 之类的子路径。 */
function originOf(baseUrl) {
  const raw = String(baseUrl ?? '')
  if (raw === '') throw new Error('该供应商没有配置 baseURL')
  return new URL(raw.includes('://') ? raw : `https://${raw}`).origin
}

/**
 * 重置时间统一成毫秒时间戳。
 *
 * 上游三种写法都见过：RFC3339 字符串、epoch 数字（秒或毫秒）、`reset_in` 秒数。
 * 统一后前端直接 `new Date(ms)` 按本地时区渲染，不必猜时区。
 */
function resetAtOf(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  const text = String(value)
  if (/^-?\d+$/.test(text)) {
    const parsed = Number(text)
    if (parsed <= 0) return undefined
    return parsed > 1e12 ? parsed : parsed * 1000
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** 从一条明细里挖重置时间：字段名五花八门。 */
function pickResetAt(source) {
  if (source === null || typeof source !== 'object') return undefined
  for (const key of ['resetTime', 'reset_at', 'resets_at', 'reset_time', 'nextResetTime', 'resetAt', 'until', 'end']) {
    const value = resetAtOf(source[key])
    if (value !== undefined) return value
  }
  const seconds = num(source.reset_in)
  if (seconds !== undefined) return Date.now() + seconds * 1000
  return undefined
}

/**
 * 带超时的 GET，返回 { status, body, error }。
 *
 * 响应体上限 1 MiB：余额接口都是小 JSON，超了多半是 HTML 错误页 —— 直接丢弃
 * 并只保留状态码，避免把错误页塞进界面。
 */
async function getJson(url, apiKey, { fetchImpl, timeoutMs = 15_000 } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      signal: controller.signal,
    })
    const text = await response.text()
    const clipped = text.length > 1024 * 1024 ? text.slice(0, 1024 * 1024) : text

    if (response.status < 200 || response.status >= 300) {
      const fragment = clipped.trimStart().startsWith('<') ? '' : clipped.slice(0, 300)
      return {
        status: response.status,
        body: undefined,
        error: `接口返回 HTTP ${response.status}${fragment === '' ? '' : `：${fragment}`}`,
      }
    }

    try {
      return { status: response.status, body: clipped === '' ? undefined : JSON.parse(clipped), error: undefined }
    } catch {
      return { status: response.status, body: undefined, error: '返回值不是合法 JSON' }
    }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      status: 0,
      body: undefined,
      error: aborted ? `请求超时（${timeoutMs}ms）` : String(error?.message ?? error),
    }
  } finally {
    clearTimeout(timer)
  }
}

const displayNumber = (text) => {
  const value = Number(text)
  if (!Number.isFinite(value)) return text
  return Number.isInteger(value) && !text.includes('.') ? String(value) : value.toFixed(2)
}

const displayValue = (value) => {
  if (value === undefined || value === null) return value
  return String(value).replace(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/gi, displayNumber)
}

const result_ = (kind, summary, details, extra = {}) => ({
  ok: true,
  kind,
  summary: displayValue(summary),
  details: details.map((item) => ({
    ...item,
    value: item.value === undefined ? undefined : displayValue(item.value),
  })),
  ...extra,
})

//#endregion

//#region 余额型

/** DeepSeek：`/user/balance` 的 balance_infos[]，金额字符串统一限制到两位小数。 */
async function probeDeepseek({ apiKey, fetchImpl, timeoutMs }) {
  const result = await getJson('https://api.deepseek.com/user/balance', apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const infos = Array.isArray(result.body.balance_infos) ? result.body.balance_infos : []
  const picked = infos[0]
  if (picked === undefined) return { ok: false, error: '响应里没有 balance_infos' }

  const currency = String(picked.currency ?? '').toUpperCase()
  const details = [
    { label: '可用余额', value: String(picked.total_balance ?? '') },
    { label: '充值余额', value: String(picked.topped_up_balance ?? '') },
    { label: '赠送余额', value: String(picked.granted_balance ?? '') },
  ].filter((item) => item.value !== '' && item.value !== 'undefined')

  return result_('balance', details[0]?.value ?? '', details, {
    currency: currency === 'USD' ? 'USD' : currency === 'CNY' ? 'CNY' : undefined,
    unavailable: result.body.is_available === false,
  })
}

/** OpenRouter：剩余 = total_credits - total_usage，展示金额最多保留两位小数。 */
async function probeOpenrouter({ apiKey, fetchImpl, timeoutMs }) {
  const result = await getJson('https://openrouter.ai/api/v1/credits', apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const data = result.body.data ?? result.body
  const total = num(data?.total_credits)
  const used = num(data?.total_usage)
  if (total === undefined || used === undefined) {
    return { ok: false, error: '响应里缺少 total_credits 或 total_usage' }
  }

  const remaining = total - used
  return result_('balance', usd(remaining.toFixed(4)), [
    { label: '总额度', value: usd(total) },
    { label: '已用', value: usd(used) },
  ], { currency: 'USD', amount: remaining })
}

/**
 * Ollama Cloud：`/api/balance`。
 *
 * 新套餐是 included.balance_usd / allowance_usd 两个金额，旧套餐给 session /
 * weekly 的 remaining_percent。两者都可能有，一起返回；一条都没有才回退
 * purchased 余额。
 */
async function probeOllama({ apiKey, fetchImpl, timeoutMs }) {
  const result = await getJson('https://ollama.com/api/balance', apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const body = result.body
  const included = body.included ?? {}
  const details = []

  const balanceUsd = num(included.balance_usd)
  const allowanceUsd = num(included.allowance_usd)
  if (balanceUsd !== undefined) {
    const text = allowanceUsd === undefined
      ? usd(balanceUsd, 2)
      : `${usd(balanceUsd, 2)} / ${usd(allowanceUsd, 2)}`
    details.push({ label: '套餐内余额', value: text, resetAt: pickResetAt(included.period) })
  }

  for (const [key, label] of [['session', '会话窗口'], ['weekly', '每周窗口']]) {
    const window = included[key]
    if (window === null || typeof window !== 'object') continue
    const remaining = num(window.remaining_percent)
    if (remaining === undefined) continue
    details.push({
      label,
      percent: Math.min(100, Math.max(0, 100 - round(remaining))),
      resetAt: pickResetAt(window),
    })
  }

  if (details.length === 0) {
    const purchased = num(body.purchased?.balance_usd)
    if (purchased === undefined) return { ok: false, error: '响应里没有可识别的额度字段' }
    details.push({ label: '购买余额', value: usd(purchased, 2) })
  }

  const first = details[0]
  return result_(details.some((item) => item.percent !== undefined) ? 'quota' : 'balance',
    first.value ?? `已用 ${first.percent}%`,
    details,
    { currency: 'USD' })
}

/** Kimi 开放平台（Moonshot）：按量现金余额，与 Coding 套餐无关。 */
async function probeMoonshot({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const origin = originOf(baseUrl)
  const result = await getJson(`${origin}/v1/users/me/balance`, apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const data = result.body.data ?? result.body
  const details = [
    { label: '可用余额', value: String(data.available_balance ?? '') },
    { label: '现金余额', value: String(data.cash_balance ?? '') },
    { label: '代金券', value: String(data.voucher_balance ?? '') },
  ].filter((item) => item.value !== '' && item.value !== 'undefined')
  if (details.length === 0) return { ok: false, error: '响应里没有余额字段' }

  return result_('balance', details[0].value, details, { currency: 'CNY' })
}

/** SiliconFlow：`/v1/user/info` 的 totalBalance。 */
async function probeSiliconflow({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const origin = originOf(baseUrl)
  for (const path of ['/v1/user/info', '/user/info']) {
    const result = await getJson(`${origin}${path}`, apiKey, { fetchImpl, timeoutMs })
    const data = result.body?.data ?? result.body
    const total = num(data?.totalBalance ?? data?.balance)
    if (total !== undefined) {
      return result_('balance', String(total), [{ label: '余额', value: String(total) }], { currency: 'CNY' })
    }
  }
  return { ok: false, error: '没有找到余额字段' }
}

/** Novita：`/v3/user/balance`。 */
async function probeNovita({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const origin = originOf(baseUrl)
  for (const path of ['/v3/user/balance', '/v1/user/balance']) {
    const result = await getJson(`${origin}${path}`, apiKey, { fetchImpl, timeoutMs })
    const body = result.body
    if (body === undefined) continue
    const infos = Array.isArray(body.balance_infos) ? body.balance_infos : []
    const total = num(infos[0]?.total_balance ?? body.balance ?? body.total_balance)
    if (total !== undefined) {
      return result_('balance', String(total), [{ label: '余额', value: String(total) }], { currency: 'USD' })
    }
  }
  return { ok: false, error: '没有找到余额字段' }
}

/** 阶跃星辰：`/v1/accounts`。 */
async function probeStepfun({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const origin = originOf(baseUrl)
  for (const path of ['/v1/accounts', '/v1/user/balance']) {
    const result = await getJson(`${origin}${path}`, apiKey, { fetchImpl, timeoutMs })
    const data = result.body?.data ?? result.body
    const total = num(data?.balance ?? data?.total_balance)
    if (total !== undefined) {
      return result_('balance', String(total), [{ label: '余额', value: String(total) }], { currency: 'CNY' })
    }
  }
  return { ok: false, error: '没有找到余额字段' }
}

/** 火山方舟：`/api/v3/billing/balance`，字段名未公开，按候选试。 */
async function probeVolcano({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const origin = originOf(baseUrl)
  for (const path of ['/api/v3/billing/balance', '/api/v3/account/balance']) {
    const result = await getJson(`${origin}${path}`, apiKey, { fetchImpl, timeoutMs })
    if (result.body === undefined) continue
    const data = result.body?.data ?? result.body?.result ?? result.body
    const total = num(data?.balance ?? data?.available_balance ?? data?.total_balance ?? data?.remain)
    if (total !== undefined) {
      return result_('balance', String(total), [{ label: '余额', value: String(total) }], { currency: 'CNY' })
    }
  }
  return { ok: false, error: '没有找到余额字段' }
}

//#endregion

//#region 订阅套餐

/**
 * z.ai / 智谱 BigModel / MiniMax 共用的一套解析。
 *
 * 三家都往 `data.limits[]`、`data.remains[]`、`data.packages[]` 里塞窗口，字段
 * 名各写各的，按候选依次试。注意这几个平台给的多是「剩余量」，所以百分比要
 * 反算成「已用」—— 与界面上进度条的语义保持一致。
 */
function parsePlanDetails(payload) {
  const data = payload?.data ?? payload
  const details = []

  const limitLabel = (entry) => {
    const raw = String(entry?.name ?? entry?.type ?? entry?.model ?? entry?.resource_name ?? '')
    if (raw === 'TIME_LIMIT') return '5 小时限额'
    if (raw === 'TOKENS_LIMIT') return 'Token 限额'
    return raw === '' ? '限额' : raw
  }

  for (const key of ['limits', 'remains', 'packages']) {
    const list = Array.isArray(data?.[key]) ? data[key] : []
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue

      const limit = num(entry.limit ?? entry.total ?? entry.max ?? entry.usageLimit)
      const remaining = num(entry.remaining ?? entry.remain ?? entry.available ?? entry.left ?? entry.currentValue ?? entry.usage ?? entry.value)
      const rawPercent = num(entry.percentage ?? entry.percent)

      let percent = rawPercent === undefined ? undefined : round(rawPercent)
      if (percent === undefined && limit !== undefined && remaining !== undefined && limit > 0) {
        percent = Math.min(100, Math.max(0, round(((limit - remaining) / limit) * 100)))
      }

      const label = limitLabel(entry)
      const valueText = limit !== undefined && remaining !== undefined
        ? `${remaining} / ${limit}`
        : remaining === undefined ? undefined : String(remaining)

      if (valueText === undefined && percent === undefined) continue
      details.push({ label, value: valueText, percent, resetAt: pickResetAt(entry) })
    }
  }

  const availableBalance = num(data?.available_balance ?? data?.balance ?? data?.remaining ?? data?.remain ?? data?.total)
  if (availableBalance !== undefined) details.push({ label: '可用余额', value: String(availableBalance) })

  return details
}

/** z.ai Coding Plan：配额头在 api.z.ai 根下。 */
async function probeZaiCoding({ apiKey, fetchImpl, timeoutMs }) {
  const result = await getJson('https://api.z.ai/api/monitor/usage/quota/limit', apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const body = result.body
  if (body.success === false || (body.code !== undefined && body.code !== 0 && body.code !== 200)) {
    const message = String(body.msg ?? body.message ?? '')
    return { ok: false, error: message || `平台返回 code=${body.code}`, noPlan: /coding plan|不存在|not found/i.test(message) }
  }

  const details = parsePlanDetails(body)
  if (details.length === 0) return { ok: false, error: '响应里没有配额字段' }
  const first = details[0]
  return result_('quota', first.value ?? `已用 ${first.percent}%`, details)
}

/** 智谱 BigModel Coding Plan：配额接口在 bigmodel.cn 根域，不是 open.bigmodel.cn。 */
async function probeBigmodelCoding({ apiKey, fetchImpl, timeoutMs }) {
  for (const url of [
    'https://bigmodel.cn/api/monitor/usage/quota/limit',
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  ]) {
    const result = await getJson(url, apiKey, { fetchImpl, timeoutMs })
    if (result.body === undefined) continue

    const body = result.body
    if (body.success === false || (body.code !== undefined && body.code !== 0 && body.code !== 200)) {
      const message = String(body.msg ?? body.message ?? '')
      if (/coding plan|不存在|not found/i.test(message)) return { ok: false, error: message, noPlan: true }
      continue
    }

    const details = parsePlanDetails(body)
    if (details.length === 0) continue
    const first = details[0]
    return result_('quota', first.value ?? `已用 ${first.percent}%`, details)
  }
  return { ok: false, error: '两个配额端点都没有返回可识别的数据' }
}

/** MiniMax Token Plan：`/v1/api/openplatform/coding_plan/remains`。 */
async function probeMinimaxCoding({ apiKey, fetchImpl, timeoutMs }) {
  const result = await getJson('https://api.minimax.io/v1/api/openplatform/coding_plan/remains', apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const body = result.body
  const statusCode = num(body?.base_resp?.status_code)
  if (statusCode !== undefined && statusCode !== 0) {
    return { ok: false, error: String(body?.base_resp?.status_msg ?? `status_code=${statusCode}`) }
  }

  const details = parsePlanDetails(body)
  if (details.length === 0) return { ok: false, error: '响应里没有配额字段（接口结构可能与 z.ai 不同）' }
  const first = details[0]
  return result_('quota', first.value ?? `已用 ${first.percent}%`, details)
}

/**
 * Kimi Coding 套餐：`/coding/v1/usages`。
 *
 * 两种形态：`data[]` 数组（每项一个窗口，model_name 为 all 时是每周），或
 * `usage{}` / `limits[]` 平铺。窗口时长按 duration × timeUnit 折算成分钟再
 * 映射，避免把 300 分钟和 10080 分钟都笼统叫「窗口」。
 */
async function probeKimiCoding({ apiKey, fetchImpl, timeoutMs }) {
  const result = await getJson('https://api.kimi.com/coding/v1/usages', apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const body = result.body
  const payload = body.data !== undefined && body.data !== null && !Array.isArray(body.data) ? body.data : body
  const details = []

  const windowLabelOf = (duration, timeUnit) => {
    const unit = String(timeUnit ?? '').toUpperCase()
    const minutes = unit.includes('HOUR') ? duration * 60 : unit.includes('DAY') ? duration * 1440 : duration
    if (minutes === 300) return '5 小时'
    if (minutes === 10080) return '每周'
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天`
    return `${minutes} 分钟`
  }

  const pushWindow = (entry, label) => {
    const detail = entry?.detail ?? entry
    const limit = num(detail?.limit ?? detail?.limit_amount)
    const used = num(detail?.used ?? detail?.used_amount)
    const remaining = num(detail?.remaining)
    const resolvedUsed = used ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
    const percent = resolvedUsed !== undefined && limit !== undefined && limit > 0
      ? Math.trunc((resolvedUsed / limit) * 100)
      : undefined

    if (percent === undefined && remaining === undefined) return
    details.push({
      label,
      percent,
      value: percent === undefined ? String(remaining) : undefined,
      resetAt: pickResetAt(detail) ?? pickResetAt(entry),
    })
  }

  // 形态 A：data[] 数组
  if (Array.isArray(body.data)) {
    for (const entry of body.data) {
      const modelName = String(entry?.model_name ?? '')
      const label = modelName === 'all' ? '每周' : String(entry?.name ?? entry?.title ?? (modelName === '' ? '限额' : modelName))
      pushWindow(entry, label)
    }
  }

  // 形态 B：平铺的 usage{} / limits[]
  if (details.length === 0) {
    const isWindow = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
      && (num(value.limit ?? value.limit_amount) !== undefined
        || num(value.used ?? value.used_amount) !== undefined
        || num(value.remaining) !== undefined)

    // 形态 B1：`usage` 自己就是一个窗口（Kimi 的每周额度就在这里）。
    // 早先把它当成「窗口的集合」逐个枚举字段，字段都是标量，于是一个都取不到。
    if (isWindow(payload.usage)) {
      pushWindow(payload.usage, '每周')
    } else if (payload.usage !== null && typeof payload.usage === 'object' && !Array.isArray(payload.usage)) {
      // 形态 B2：`usage` 是 { fiveHour: {...}, weekly: {...} } 这种窗口字典
      for (const [key, entry] of Object.entries(payload.usage)) {
        if (!isWindow(entry)) continue
        pushWindow(entry, key === 'weekly' ? '每周' : key)
      }
    } else if (details.length === 0 && payload !== null && typeof payload === 'object') {
      // 形态 B3：data 本身直接挂着 fiveHour / weekly
      for (const [key, entry] of Object.entries(payload)) {
        if (!isWindow(entry)) continue
        pushWindow(entry, key === 'weekly' ? '每周' : key)
      }
    }
    for (const entry of Array.isArray(payload.limits) ? payload.limits : []) {
      const window = entry?.window ?? {}
      const duration = num(window.duration)
      const label = duration === undefined ? '限额' : windowLabelOf(duration, window.timeUnit ?? window.time_unit)
      pushWindow(entry, label)
    }
  }

  if (details.length === 0) {
    const message = String(body.msg ?? body.message ?? '')
    return { ok: false, error: message || '响应里没有配额字段', noPlan: /coding plan/i.test(message) }
  }

  // 长周期排最后：5 小时这种短期窗口更该被先看到
  details.sort((a, b) => (a.label === '每周' ? 1 : 0) - (b.label === '每周' ? 1 : 0))
  const first = details[0]
  return result_('quota', first.percent === undefined ? first.value ?? '' : `${first.percent}%`, details)
}

/**
 * Command Code：`/alpha/billing/credits`。
 *
 * 一份响应里同时有 credits（金额）与 windowLimits（百分比），两种都返回，
 * 前端按 details 逐条画。
 */
async function probeCommandCode({ apiKey, fetchImpl, timeoutMs }) {
  const result = await getJson('https://api.commandcode.ai/alpha/billing/credits', apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const body = result.body
  const credits = body.credits ?? {}
  const details = []

  for (const [key, label] of [['monthlyCredits', '月度额度'], ['purchasedCredits', '购买额度'], ['freeCredits', '免费额度']]) {
    const value = num(credits[key])
    if (value !== undefined) details.push({ label, value: String(value) })
  }

  for (const [key, label] of [['fiveHour', '5 小时'], ['weekly', '每周']]) {
    const window = body.windowLimits?.[key]
    if (window === null || typeof window !== 'object') continue
    const used = num(window.used)
    const cap = num(window.cap)
    if (used === undefined || cap === undefined || cap <= 0) continue
    details.push({ label, value: `${used} / ${cap}`, percent: Math.trunc((used / cap) * 100), resetAt: pickResetAt(window) })
  }

  if (details.length === 0) return { ok: false, error: '响应里没有 credits 或窗口字段' }
  return result_(details.some((item) => item.percent !== undefined) ? 'quota' : 'balance', details[0].value ?? '', details)
}

/**
 * Grok (xAI)：`{base}/billing?format=credits`。
 *
 * 只有 OAuth 登录态能查（one-proxy 从会话里取 access token）。DSH 里的供应商
 * 是 API Key 形态，没有 OAuth 会话，所以直接说明原因 —— 拿 API Key 去打一个
 * 必然 401 的接口只会让人以为密钥填错了。
 */
async function probeGrok() {
  return {
    ok: false,
    error: 'Grok 的额度接口只认 OAuth 登录态，API Key 形态查不到',
    unsupported: true,
  }
}

//#endregion

//#region 宿主账号（DSH 登录态）

/**
 * DeepSeek 官方登录（DSH 账号）的余额。
 *
 * 不走 API Key，也不自己发 HTTP：宿主已经登录了账号，`deepseekAccount` 服务
 * 会把本地凭据送到 Platform 的 `/api/v0/users/get_user_summary`，插件只读结果，
 * 全程不碰 token。
 *
 * @returns `{ status:'ready', value:[{currency,balance}], bonusWallets:[…] }`；
 *          未登录是 null，查询失败是 `{ status:'failed' }`。
 */
export async function queryAccountBalance({ account, client }) {
  if (account === undefined || account === null || typeof account.getBalance !== 'function') {
    return { ok: false, error: '宿主没有 DeepSeek 账号服务' }
  }

  let outcome
  try {
    outcome = await account.getBalance(client)
  } catch (error) {
    return { ok: false, error: `账号余额查询失败：${String(error?.message ?? error)}` }
  }

  if (outcome === null || outcome === undefined) return { ok: false, error: 'DeepSeek 账号未登录' }
  if (outcome.status === 'failed') return { ok: false, error: '账号余额查询失败（Platform 接口没返回有效数据）' }

  const wallets = Array.isArray(outcome.value) ? outcome.value : []
  const bonuses = Array.isArray(outcome.bonusWallets) ? outcome.bonusWallets : []
  if (wallets.length === 0 && bonuses.length === 0) return { ok: false, error: '账号里没有余额钱包' }

  const shown = (wallet) => {
    const symbol = wallet?.currency === 'USD' ? '$' : wallet?.currency === 'CNY' ? '¥' : ''
    return `${symbol}${wallet?.balance ?? ''}`
  }
  const details = []
  if (wallets.length > 0) details.push({ label: '充值余额', value: wallets.map(shown).join(' / ') })
  if (bonuses.length > 0) details.push({ label: '赠送余额', value: bonuses.map(shown).join(' / ') })

  const main = wallets[0] ?? bonuses[0]
  return result_('balance', String(main.balance ?? ''), details, {
    currency: main.currency === 'USD' || main.currency === 'CNY' ? main.currency : undefined,
  })
}

//#endregion

//#region 网关

/** New API / One API：`/api/user/self` 的 quota 单位是 $0.000002。 */
async function probeNewApi({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const origin = originOf(baseUrl)
  const result = await getJson(`${origin}/api/user/self`, apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const data = result.body?.data ?? result.body
  const quota = num(data?.quota)
  if (quota === undefined) return { ok: false, error: '响应里没有 quota 字段' }

  const remaining = quota / 500000
  const details = [{ label: '可用余额', value: usd(remaining.toFixed(4)) }]
  const usedQuota = num(data?.used_quota)
  if (usedQuota !== undefined) details.push({ label: '已用', value: usd((usedQuota / 500000).toFixed(4)) })
  return result_('balance', details[0].value, details, { currency: 'USD', amount: remaining })
}

/** Sub2API：`/v1/usage` 的 balance 直接是美元。 */
async function probeSub2Api({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const origin = originOf(baseUrl)
  const result = await getJson(`${origin}/v1/usage`, apiKey, { fetchImpl, timeoutMs })
  if (result.body === undefined) return { ok: false, error: result.error ?? `HTTP ${result.status}` }

  const data = result.body?.data ?? result.body
  const total = num(data?.balance ?? data?.remaining ?? data?.credits)
  if (total === undefined) return { ok: false, error: '响应里没有 balance 字段' }
  return result_('balance', String(total), [{ label: '余额', value: String(total) }], { currency: 'USD', amount: total })
}

//#endregion

/** 查询方式 → 实现。`none` 不在这里：调用方看到它就不发请求。 */
const IMPLEMENTATIONS = {
  deepseek: probeDeepseek,
  openrouter: probeOpenrouter,
  ollama: probeOllama,
  moonshot: probeMoonshot,
  'kimi-coding': probeKimiCoding,
  'zai-coding': probeZaiCoding,
  'bigmodel-coding': probeBigmodelCoding,
  'minimax-coding': probeMinimaxCoding,
  commandcode: probeCommandCode,
  grok: probeGrok,
  siliconflow: probeSiliconflow,
  novita: probeNovita,
  stepfun: probeStepfun,
  volcano: probeVolcano,
  newapi: probeNewApi,
  sub2api: probeSub2Api,
}

/**
 * 统一入口。
 *
 * `vendor` 为 auto 时先按 baseURL 推断；推断不出来返回 needsVendor，让前端
 * 提示用户去下拉里指定，而不是拿错适配器打一次无意义的请求。
 */
export async function queryBalance({ vendor, baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const resolved = vendor === 'auto' || vendor === undefined || vendor === ''
    ? detectVendor(baseUrl)
    : vendor

  if (resolved === undefined) {
    return { ok: false, error: '无法从地址判断是哪家，请指定查询方式', needsVendor: true }
  }
  if (resolved === 'none') return { ok: true, kind: 'none', summary: '', details: [] }

  const implementation = IMPLEMENTATIONS[resolved]
  if (implementation === undefined) {
    return { ok: false, error: `未知的查询方式：${resolved}`, needsVendor: true }
  }

  try {
    const result = await implementation({ baseUrl, apiKey, fetchImpl, timeoutMs })
    return { ...result, vendor: resolved }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), vendor: resolved }
  }
}
