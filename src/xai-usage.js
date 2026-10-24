/**
 * xAI（Grok / X 订阅）用量查询 —— 纯 HTTP + 解析，不依赖 DSH 运行时。
 *
 * 数据来自 Grok CLI 的计费代理，而不是 Console 的按量付费 API：
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *   GET https://cli-chat-proxy.grok.com/v1/settings
 *   GET https://api.x.ai/v1/me
 * 这三个端点只认 OAuth 订阅令牌（SuperGrok / X Premium），API Key 查不了。
 *
 * 归一化逻辑与 dsh-xai-oauth（MIT，tonylee2022/dsh-xai-oauth）保持一致：
 * 订阅账号的权威用量是 creditUsagePercent + currentPeriod，used/monthlyLimit
 * 可能缺席或 0/0，那不代表「没有数据」。
 */

import { brotliDecompressSync, gunzipSync } from 'node:zlib'

export const XAI_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
export const XAI_SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings'
export const XAI_ME_URL = 'https://api.x.ai/v1/me'

/** 上游可能直接回 gzip / brotli 压缩体（即使声明了 identity），这里兼容三种形态。 */
export async function readJsonResponse(response) {
  const buf = Buffer.from(await response.arrayBuffer())
  const encoding = (response.headers.get('content-encoding') || '').toLowerCase()
  const candidates = [buf]
  if (encoding.includes('gzip') || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
    try { candidates.unshift(gunzipSync(buf)) } catch { /* 保留原始字节 */ }
  }
  if (encoding.includes('br')) {
    try { candidates.unshift(brotliDecompressSync(buf)) } catch { /* 保留原始字节 */ }
  }
  if (!encoding) {
    try { candidates.push(brotliDecompressSync(buf)) } catch { /* 不是 brotli */ }
  }
  let lastError
  for (const body of candidates) {
    try { return JSON.parse(body.toString('utf8')) } catch (error) { lastError = error }
  }
  throw lastError
}

function moneyVal(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'object' && typeof value.val === 'number' && Number.isFinite(value.val)) return value.val
  return undefined
}

function percentVal(value) {
  const number = moneyVal(value)
  return Number.isFinite(number) ? number : undefined
}

function stringVal(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function objectVal(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** 把 billing + settings + me 三份响应压成稳定的用量字段。 */
export function normalizeUsage(billing, settings, me) {
  const raw = objectVal(billing) ?? {}
  const config = objectVal(raw.config) ?? raw
  const settingsObj = objectVal(settings) ?? {}
  const meObj = objectVal(me) ?? {}

  const creditUsagePercent = percentVal(config.creditUsagePercent)
  const used = moneyVal(config.used)
  const monthlyLimit = moneyVal(config.monthlyLimit)
  const onDemandCap = moneyVal(config.onDemandCap)
  const onDemandUsed = moneyVal(config.onDemandUsed)
  const prepaidBalance = moneyVal(config.prepaidBalance)
  const isUnifiedBillingUser = config.isUnifiedBillingUser === true
  const period = objectVal(config.currentPeriod) ?? {}
  const periodTypeRaw = stringVal(period.type)
  const periodType = periodTypeRaw === undefined
    ? undefined
    : periodTypeRaw.includes('WEEKLY') ? 'weekly'
      : periodTypeRaw.includes('MONTHLY') ? 'monthly' : undefined
  const periodStart = stringVal(period.start) ?? stringVal(config.billingPeriodStart)
  const periodEnd = stringVal(period.end) ?? stringVal(config.billingPeriodEnd)
  const planType = stringVal(raw.subscription_tier) ?? stringVal(config.subscription_tier)
    ?? stringVal(settingsObj.subscription_tier_display)
  const onDemandEnabled = raw.on_demand_enabled === true || config.on_demand_enabled === true
    ? true
    : raw.on_demand_enabled === false || config.on_demand_enabled === false
      ? false
      : typeof settingsObj.on_demand_enabled === 'boolean' ? settingsObj.on_demand_enabled : undefined
  const userId = stringVal(meObj.user_id)
  const teamId = stringVal(meObj.team_id)

  let usedPercent
  if (creditUsagePercent !== undefined) {
    usedPercent = Math.max(0, Math.min(100, creditUsagePercent))
  } else if (used !== undefined && monthlyLimit !== undefined && monthlyLimit > 0) {
    usedPercent = Math.max(0, Math.min(100, (used / monthlyLimit) * 100))
  }

  const productUsage = Array.isArray(config.productUsage)
    ? config.productUsage.flatMap((row) => {
      const rowObj = objectVal(row)
      if (rowObj === undefined) return []
      const product = stringVal(rowObj.product)
      const usagePercent = percentVal(rowObj.usagePercent)
      if (product === undefined || usagePercent === undefined) return []
      return [{ product, usagePercent: Math.max(0, Math.min(100, usagePercent)) }]
    })
    : []

  return {
    ...planType === undefined ? {} : { planType },
    ...creditUsagePercent === undefined ? {} : { creditUsagePercent },
    ...used === undefined ? {} : { used },
    ...monthlyLimit === undefined ? {} : { monthlyLimit },
    ...onDemandCap === undefined ? {} : { onDemandCap },
    ...onDemandUsed === undefined ? {} : { onDemandUsed },
    ...prepaidBalance === undefined ? {} : { prepaidBalance },
    ...isUnifiedBillingUser ? { isUnifiedBillingUser } : {},
    ...onDemandEnabled === undefined ? {} : { onDemandEnabled },
    ...usedPercent === undefined ? {} : { usedPercent },
    ...periodType === undefined ? {} : { periodType },
    ...periodStart === undefined ? {} : { periodStart },
    ...periodEnd === undefined ? {} : { periodEnd },
    ...userId === undefined ? {} : { userId },
    ...teamId === undefined ? {} : { teamId },
    productUsage,
    fetchedAt: Date.now(),
  }
}

/** 拉一次完整用量。`apiKey` 必须是 OAuth 访问令牌；失败抛错，由调用方转成卡片错误。 */
export async function fetchGrokUsage({ apiKey, fetchImpl, timeoutMs = 15_000 } = {}) {
  if (typeof apiKey !== 'string' || apiKey === '') {
    const error = new Error('尚未登录 xAI')
    error.code = 'XAI_NOT_LOGGED_IN'
    throw error
  }
  const doFetch = fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const headers = {
      accept: 'application/json',
      'accept-encoding': 'identity',
      authorization: `Bearer ${apiKey}`,
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-client-mode': 'cli',
      'user-agent': 'dsh-balance-panel/0.2',
    }
    const [billingResponse, settingsResponse, meResponse] = await Promise.all([
      doFetch(XAI_BILLING_URL, { headers, signal: controller.signal }),
      doFetch(XAI_SETTINGS_URL, { headers, signal: controller.signal }),
      doFetch(XAI_ME_URL, {
        headers: { accept: 'application/json', 'accept-encoding': 'identity', authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      }),
    ])
    if (!billingResponse.ok) {
      throw new Error(`xAI 额度接口返回 HTTP ${billingResponse.status}`)
    }
    const billing = await readJsonResponse(billingResponse)
    const settings = settingsResponse.ok ? await readJsonResponse(settingsResponse) : {}
    const me = meResponse.ok ? await readJsonResponse(meResponse) : {}
    return normalizeUsage(billing, settings, me)
  } finally {
    clearTimeout(timer)
  }
}
