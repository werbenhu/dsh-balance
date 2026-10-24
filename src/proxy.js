/**
 * 按供应商分流的出站代理 —— 模型 API 请求与余额/OAuth 查询共用。
 *
 * 两边的请求最终都落到 Node 内置 fetch（pi-ai 如此，本插件的适配器也如此），
 * 所以在 undici 全局 dispatcher 这一层按 origin 分流即可同时覆盖：
 *   - 「走代理」：ProxyAgent(用户填的代理地址)；
 *   - 「直连」：Pool(origin)，连 DSH 环境变量里的代理也一并绕过；
 *   - 「跟随默认」：把请求原样转交给安装前的 dispatcher（通常是 DSH 按
 *     HTTPS_PROXY 等环境变量安装的策略），行为与没装本插件完全一致。
 *
 * 没有任何非默认规则时不触碰全局 dispatcher；卸载时恢复原 dispatcher。
 * 代理地址只允许 http(s)://；SOCKS/PAC 不支持，避免半通不通的静默失败。
 */

import { Agent, Dispatcher, Pool, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

export const PROXY_MODES = ['default', 'direct', 'proxy']

/**
 * 「跟随默认」的转发器：Agent 要求工厂产物是完整 Dispatcher（要有 .on 等），
 * 所以继承 Dispatcher 而不是给个裸对象。close/destroy 是空操作——
 * 原 dispatcher 属于 DSH，不能随本插件的路由重建被关掉。
 */
class FallbackDispatcher extends Dispatcher {
  constructor(origin, fallback) {
    super()
    this.origin = origin
    this.fallback = fallback
  }

  dispatch(opts, handler) {
    return this.fallback.dispatch({ ...opts, origin: this.origin }, handler)
  }

  close() {
    return Promise.resolve()
  }

  destroy() {
    return Promise.resolve()
  }
}

/**
 * 归一化代理地址。
 * @returns 空串（未设置）/ 规范化后的 URL / undefined（非法，调用方应报错）
 */
export function normalizeProxyUrl(value) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw === '') return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.hostname === '') return undefined
    return url.href
  } catch {
    return undefined
  }
}

/**
 * 一个供应商关联的域名：baseURL 的主机名 + 该厂商的辅助端点。
 * xAI 的授权与计费在 api.x.ai 之外，选「走代理」时这三个域必须一起走，
 * 否则模型通了、登录和余额还是失败。
 */
export function providerHosts(provider) {
  const hosts = new Set()
  const base = provider?.baseUrl ?? provider?.baseURL
  if (typeof base === 'string' && base !== '') {
    try {
      hosts.add(new URL(base.includes('://') ? base : `https://${base}`).hostname.toLowerCase())
    } catch { /* 地址非法就没有 baseURL 域，只留辅助域 */ }
  }
  if (provider?.id === 'xai' || provider?.vendor === 'grok') {
    hosts.add('api.x.ai')
    hosts.add('auth.x.ai')
    hosts.add('cli-chat-proxy.grok.com')
  }
  hosts.delete('')
  return [...hosts]
}

export class ProxyRouter {
  constructor({ logger } = {}) {
    this.logger = logger
    this.previous = undefined
    this.agent = undefined
    this.installed = false
    this.signature = undefined
  }

  /**
   * 让全局路由与设置一致；签名没变就什么都不做。
   * @param {{proxyUrl?: string, rules?: Map<string, 'direct'|'proxy'>}} desired
   */
  async sync({ proxyUrl = '', rules = new Map() } = {}) {
    // 没填代理地址时「走代理」规则不生效（UI 会提示去填地址），直连规则仍有效
    const active = proxyUrl === ''
      ? new Map([...rules].filter(([, mode]) => mode === 'direct'))
      : rules
    const signature = JSON.stringify([proxyUrl, [...active.entries()].sort(([a], [b]) => a.localeCompare(b))])
    if (signature === this.signature) return
    this.signature = signature

    if (active.size === 0) {
      await this.dispose()
      return
    }

    if (!this.installed) {
      this.previous = getGlobalDispatcher()
      this.installed = true
    }
    const previousAgent = this.agent
    const fallback = this.previous
    this.agent = new Agent({
      factory: (origin, options) => {
        const host = new URL(origin.toString()).hostname.toLowerCase()
        const mode = active.get(host) ?? 'default'
        if (mode === 'proxy') return new ProxyAgent({ ...options, uri: proxyUrl })
        if (mode === 'direct') return new Pool(origin, options)
        // 跟随默认：转发给原 dispatcher；close/destroy 不能连带关掉它
        return new FallbackDispatcher(origin, fallback)
      },
    })
    setGlobalDispatcher(this.agent)
    if (previousAgent !== undefined) {
      try { await previousAgent.close() } catch { /* 旧连接的清理失败不影响新路由 */ }
    }
    this.logger?.info?.(`[balance-panel] 代理路由已更新：${[...active.entries()].map(([host, mode]) => `${host}=${mode}`).join(', ')}`)
  }

  /** 恢复原 dispatcher；之后所有流量回到插件介入之前的状态。 */
  async dispose() {
    if (!this.installed) return
    this.installed = false
    if (getGlobalDispatcher() === this.agent) setGlobalDispatcher(this.previous)
    const agent = this.agent
    this.agent = undefined
    this.previous = undefined
    if (agent !== undefined) {
      try { await agent.close() } catch { /* 忽略关闭异常 */ }
    }
  }
}
