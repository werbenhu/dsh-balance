/**
 * 适配器离线测试：注入假 fetch，用 one-proxy 仓库里的 fixture 断言解析结果。
 *
 * 跑法：node --test test/
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { detectVendor, queryAccountBalance, queryBalance, VENDORS } from '../src/adapters.js'

/** 造一个假 fetch：按 URL 找响应，记录请求头。 */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} })
    const route = typeof routes === 'function' ? routes(String(url)) : routes[String(url)] ?? routes['*']
    const entry = typeof route === 'function' ? route() : route
    const status = entry?.status ?? 200
    const body = entry?.body === undefined ? '' : JSON.stringify(entry.body)
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
  impl.calls = calls
  return impl
}

test('DeepSeek：解析 balance_infos，主余额和明细最多保留两位小数', async () => {
  const fetchImpl = fakeFetch({
    'https://api.deepseek.com/user/balance': {
      body: {
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '38.9142845400000000', topped_up_balance: '38.9142845400000000', granted_balance: '0' }],
      },
    },
  })

  const result = await queryBalance({ vendor: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.kind, 'balance')
  assert.equal(result.summary, '38.91')
  assert.equal(result.currency, 'CNY')
  assert.deepEqual(result.details.map((item) => item.label), ['可用余额', '充值余额', '赠送余额'])
  assert.deepEqual(result.details.map((item) => item.value), ['38.91', '38.91', '0'])
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer k')
  assert.equal(fetchImpl.calls[0].headers.accept, 'application/json')
})

test('OpenRouter：剩余额度最多保留两位小数，明细给总额与已用', async () => {
  const fetchImpl = fakeFetch({
    'https://openrouter.ai/api/v1/credits': { body: { data: { total_credits: 20, total_usage: 3.25 } } },
  })

  const result = await queryBalance({ vendor: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.summary, '$16.75')
  assert.equal(result.amount, 16.75)
  assert.deepEqual(result.details.map((item) => item.value), ['$20', '$3.25'])
})

test('Ollama：计划内余额定长两位，并带周期重置时间', async () => {
  const fetchImpl = fakeFetch({
    'https://ollama.com/api/balance': {
      body: {
        included: {
          balance_usd: 72.5,
          allowance_usd: 100,
          period: { until: '2026-10-15T09:30:00Z' },
        },
      },
    },
  })

  const result = await queryBalance({ vendor: 'ollama', baseUrl: 'https://ollama.com/v1', apiKey: 'k', fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.summary, '$72.50 / $100.00')
  assert.equal(result.details[0].resetAt, Date.parse('2026-10-15T09:30:00Z'))
})

test('Ollama：旧套餐的 remaining_percent 换算成已用百分比并裁剪到 0..100', async () => {
  const fetchImpl = fakeFetch({
    'https://ollama.com/api/balance': {
      body: {
        included: {
          session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
          weekly: { remaining_percent: 40 },
        },
      },
    },
  })

  const result = await queryBalance({ vendor: 'ollama', baseUrl: 'https://ollama.com/v1', apiKey: 'k', fetchImpl })

  assert.equal(result.kind, 'quota')
  assert.deepEqual(result.details.map((item) => item.percent), [25, 60])
})

test('Kimi Coding：5 小时窗口在前、每周在后，百分比截断', async () => {
  const fetchImpl = fakeFetch({
    'https://api.kimi.com/coding/v1/usages': {
      body: {
        data: [
          { name: '5h', limit: '50000', used: '1000' },
          { model_name: 'all', limit: '500000', used: '120000' },
        ],
      },
    },
  })

  const result = await queryBalance({ vendor: 'kimi-coding', baseUrl: 'https://api.kimi.com/coding/v1', apiKey: 'k', fetchImpl })

  assert.equal(result.ok, true)
  assert.deepEqual(result.details.map((item) => item.label), ['5h', '每周'])
  assert.deepEqual(result.details.map((item) => item.percent), [2, 24])
})

test('Kimi Coding：limits[] 形态按 window.duration 折算窗口名', async () => {
  const fetchImpl = fakeFetch({
    'https://api.kimi.com/coding/v1/usages': {
      body: {
        limits: [
          { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit_amount: '50000', used_amount: '1000' } },
          { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { remaining: '380000', limit: '500000' } },
        ],
      },
    },
  })

  const result = await queryBalance({ vendor: 'kimi-coding', baseUrl: 'https://api.kimi.com/coding', apiKey: 'k', fetchImpl })

  assert.deepEqual(result.details.map((item) => item.label), ['5 小时', '每周'])
  assert.deepEqual(result.details.map((item) => item.percent), [2, 24])
})

test('Kimi Coding：usage 自己是一个窗口时，别把它的数值字段当窗口枚举掉', async () => {
  // 真实响应的形态：每周额度在 usage{}（一个窗口），5 小时在 limits[]。
  const fetchImpl = fakeFetch({
    'https://api.kimi.com/coding/v1/usages': {
      body: {
        usage: { used: '120000', limit: '500000' },
        limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, used: '1000', limit: '50000' }],
      },
    },
  })

  const result = await queryBalance({ vendor: 'kimi-coding', baseUrl: 'https://api.kimi.com/coding', apiKey: 'k', fetchImpl })

  assert.equal(result.ok, true)
  assert.deepEqual(result.details.map((item) => item.label), ['5 小时', '每周'])
  assert.deepEqual(result.details.map((item) => item.percent), [2, 24])
})

test('z.ai：remaining/limit 组合显示为剩余/上限，并反算已用百分比', async () => {
  const fetchImpl = fakeFetch({
    'https://api.z.ai/api/monitor/usage/quota/limit': {
      body: { success: true, data: { limits: [{ type: 'TIME_LIMIT', remaining: 1200, limit: 5000 }] } },
    },
  })

  const result = await queryBalance({ vendor: 'zai-coding', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'k', fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.details[0].label, '5 小时限额')
  assert.equal(result.details[0].value, '1200 / 5000')
  assert.equal(result.details[0].percent, 76)
})

test('智谱：优先打 bigmodel.cn 根域，成功即返回', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.startsWith('https://bigmodel.cn/')) {
      return { body: { success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 3, usage: 337430 }] } } }
    }
    return { status: 404, body: { success: false, msg: 'not found' } }
  })

  const result = await queryBalance({ vendor: 'bigmodel-coding', baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'k', fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.details[0].percent, 3)
  assert.match(fetchImpl.calls[0].url, /^https:\/\/bigmodel\.cn\//)
})

test('Command Code：credits 与窗口一起返回，额度最多保留两位小数', async () => {
  const fetchImpl = fakeFetch({
    'https://api.commandcode.ai/alpha/billing/credits': {
      body: {
        credits: { monthlyCredits: 68.0409584558, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: { limited: false, fiveHour: { used: 1.5, cap: 14 }, weekly: { used: 1.5, cap: 35 } },
      },
    },
  })

  const result = await queryBalance({ vendor: 'commandcode', baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'k', fetchImpl })

  assert.equal(result.kind, 'quota')
  assert.equal(result.summary, '68.04')
  assert.deepEqual(result.details.map((item) => item.label), ['月度额度', '购买额度', '免费额度', '5 小时', '每周'])
  assert.deepEqual(result.details.slice(0, 3).map((item) => item.value), ['68.04', '0', '0'])
  assert.deepEqual(result.details.slice(3).map((item) => item.percent), [10, 4])
})

test('New API：quota ÷ 500000，按两位小数展示', async () => {
  const fetchImpl = fakeFetch({
    'https://gateway.example.com/api/user/self': { body: { data: { quota: 30000000, used_quota: 5000000 } } },
  })

  const result = await queryBalance({ vendor: 'newapi', baseUrl: 'https://gateway.example.com/v1', apiKey: 'k', fetchImpl })

  assert.equal(result.summary, '$60.00')
  assert.equal(result.details[1].value, '$10.00')
})

test('非 2xx：报状态码，不把 HTML 错误页塞进界面', async () => {
  const fetchImpl = async () => new Response('<html>401 Unauthorized</html>', { status: 401 })
  const result = await queryBalance({ vendor: 'deepseek', apiKey: 'k', fetchImpl })

  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 401$/)
})

test('auto：推断不出来时返回 needsVendor，而不是瞎打一个地址', async () => {
  const result = await queryBalance({ vendor: 'auto', baseUrl: 'https://my-gateway.internal/v1', apiKey: 'k' })

  assert.equal(result.ok, false)
  assert.equal(result.needsVendor, true)
})

test('Grok：没有令牌时返回 needsLogin，不打无谓的上游请求', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return new Response('{}', { status: 200 })
  }
  const result = await queryBalance({ vendor: 'grok', baseUrl: 'https://api.x.ai/v1', apiKey: '', fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.needsLogin, true)
  assert.equal(called, false)
})

test('Grok：OAuth 令牌查询订阅用量，主数值是周期已用百分比', async () => {
  const fetchImpl = fakeFetch({
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits': {
      body: {
        subscription_tier: 'SuperGrok',
        config: {
          creditUsagePercent: 21,
          currentPeriod: { type: 'WEEKLY', start: '2026-10-20T08:10:12+00:00', end: '2026-10-27T08:10:12+00:00' },
          productUsage: [{ product: 'GrokBuild', usagePercent: 20 }, { product: 'GrokChat', usagePercent: 1 }],
          isUnifiedBillingUser: true,
        },
      },
    },
    'https://cli-chat-proxy.grok.com/v1/settings': { body: { subscription_tier_display: 'SuperGrok' } },
    'https://api.x.ai/v1/me': { body: { user_id: 'u-1', team_id: 't-1' } },
  })

  const result = await queryBalance({ vendor: 'grok', baseUrl: 'https://api.x.ai/v1', apiKey: 'xai-oauth-token', fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.vendor, 'grok')
  assert.equal(result.kind, 'quota')
  assert.equal(result.summary, '21%')
  assert.equal(result.planType, 'SuperGrok')
  assert.equal(result.details[0].label, '本周额度')
  assert.equal(result.details[0].percent, 21)
  assert.equal(typeof result.details[0].resetAt, 'number')
  assert.deepEqual(result.details.slice(1, 3).map((item) => [item.label, item.percent]), [['Grok Build', 20], ['Grok 聊天', 1]])
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer xai-oauth-token')
  assert.equal(fetchImpl.calls[0].headers['x-xai-token-auth'], 'xai-grok-cli')
})

test('Grok：只有 used/monthlyLimit 时反算百分比，产品用量缺失也不报错', async () => {
  const fetchImpl = fakeFetch({
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits': {
      body: { config: { used: 250, monthlyLimit: 1000, currentPeriod: { type: 'MONTHLY' } } },
    },
    '*': { body: {} },
  })

  const result = await queryBalance({ vendor: 'grok', apiKey: 'token', fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.summary, '25%')
  assert.equal(result.details[0].label, '本月额度')
  assert.equal(result.details[0].value, '250 / 1000')
})

test('detectVendor：覆盖各家的典型 baseURL', () => {
  const cases = [
    ['https://api.deepseek.com', 'deepseek'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://ollama.com/v1', 'ollama'],
    ['https://api.kimi.com/coding/v1', 'kimi-coding'],
    ['https://api.moonshot.cn/anthropic', 'moonshot'],
    ['https://api.z.ai/api/anthropic', 'zai-coding'],
    ['https://open.bigmodel.cn/api/anthropic', 'bigmodel-coding'],
    ['https://api.minimax.io/anthropic', 'minimax-coding'],
    ['https://api.commandcode.ai/provider/v1', 'commandcode'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'volcano'],
  ]
  for (const [url, vendor] of cases) {
    assert.equal(detectVendor(url), vendor, url)
  }
  assert.equal(detectVendor('https://internal.example.com/v1'), undefined)
  assert.equal(detectVendor(''), undefined)
})

test('VENDORS：id 唯一，且 auto/none 都在列表里', () => {
  const ids = VENDORS.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('auto'))
  assert.ok(ids.includes('none'))
})

test('官方登录：充值 / 赠送钱包各占一条明细，不碰 token', async () => {
  const clients = []
  const account = {
    getBalance: async (client) => {
      clients.push(client)
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '42.50' }],
        bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
      }
    },
  }

  const result = await queryAccountBalance({ account, client: { version: '0.2.1', locale: 'zh-CN', timezoneOffsetSeconds: 28800 } })

  assert.equal(result.ok, true)
  assert.equal(result.kind, 'balance')
  assert.equal(result.summary, '42.50')
  assert.equal(result.currency, 'CNY')
  assert.deepEqual(result.details, [
    { label: '充值余额', value: '¥42.50' },
    { label: '赠送余额', value: '¥5.00' },
  ])
  assert.equal(clients.length, 1)
  assert.equal(clients[0].version, '0.2.1')
})

test('官方登录：未登录 / 查询失败 / 没有账号服务都给明确原因', async () => {
  const signedOut = await queryAccountBalance({ account: { getBalance: async () => null } })
  assert.equal(signedOut.ok, false)
  assert.match(signedOut.error, /未登录/)

  const failed = await queryAccountBalance({ account: { getBalance: async () => ({ status: 'failed' }) } })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /Platform/)

  const missing = await queryAccountBalance({ account: undefined })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /账号服务/)

  const thrown = await queryAccountBalance({ account: { getBalance: async () => { throw new Error('boom') } } })
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /boom/)
})
