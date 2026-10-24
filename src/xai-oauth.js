/**
 * xAI（Grok / X 订阅）OAuth 服务 —— Host 侧，只用 Node 内置模块。
 *
 * 设备码（RFC 8628）登录 → 本地保存 access/refresh token → 到期前自动续期 →
 * 把当前 access token 写进 DSH 凭据缝（XAI_OAUTH_TOKEN），模型路由按
 * `apiKeyEnv: XAI_OAUTH_TOKEN` 每次请求解析最新值，余额查询共用同一个令牌。
 *
 * 流程与令牌文件格式继承自 dsh-xai-oauth（MIT，tonylee2022/dsh-xai-oauth），
 * 因此已登录过的用户不需要重新授权；本服务不再单开端口，状态与操作都走
 * dsh-balance-panel 自己的同源路由。
 *
 * 令牌只落在 Host 侧文件（owner-only），浏览器永远拿不到 token 本体。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { fetchGrokUsage } from './xai-usage.js'

/** xAI CLI / 设备流公开 client id（与 pi-ai 一致）。 */
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'
/** 凭据引用名：模型路由与余额查询都从这里取当前访问令牌。 */
export const XAI_TOKEN_REF = 'XAI_OAUTH_TOKEN'
/** 距过期不足 5 分钟就续期，令牌不会死在请求中途。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000
const DEFAULT_TOKEN_LIFETIME_MS = 3600 * 1000
const USAGE_CACHE_MS = 30_000
const REFRESH_POLL_MS = 60_000

export function defaultXaiCredentialPath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'xai-oauth.json')
}

function requiredString(body, field) {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`xAI OAuth 响应缺少字段：${field}`)
  }
  return value
}

function positiveNumber(body, field) {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`xAI OAuth 响应字段非法：${field}`)
  }
  return value
}

/** 授权页要在浏览器里打开，强制 https，避免被响应里的 scheme 钓鱼。 */
function validateVerificationUri(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('xAI 授权页地址不可信')
  }
  if (url.protocol !== 'https:') throw new Error('xAI 授权页地址不是 https')
  return url.href
}

function credentialFromTokenResponse(body, previousRefreshToken) {
  const access = requiredString(body, 'access_token')
  // 续期时 xAI 可能不轮换 refresh token
  const refresh = body.refresh_token === undefined && previousRefreshToken !== undefined
    ? previousRefreshToken
    : requiredString(body, 'refresh_token')
  const expiresInMs = body.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_MS : positiveNumber(body, 'expires_in') * 1000
  return { access, refresh, expires: Date.now() + expiresInMs - REFRESH_SKEW_MS }
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(new Error('Login cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class XaiOAuthService {
  /**
   * @param {{ctx?: object, filename?: string, logger?: object, fetchImpl?: Function,
   *          onLogin?: () => void, onLogout?: () => void}} options
   */
  constructor({ ctx, filename, logger, fetchImpl, onLogin, onLogout } = {}) {
    this.ctx = ctx
    this.filename = resolve(filename ?? defaultXaiCredentialPath())
    this.logger = logger ?? console
    this.fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
    this.onLogin = onLogin
    this.onLogout = onLogout
    this.csrf = randomBytes(24).toString('base64url')
    this.credential = undefined
    this.loaded = false
    this.fileMtime = undefined
    this.refreshing = undefined
    this.loginSession = undefined
    this.lastLoginError = undefined
    this.usageCache = undefined
    this.usageError = undefined
  }

  // —— 凭据缝：写当前令牌，读由模型路由自己完成 ——

  async publishToken(token) {
    const credentials = this.ctx?.get?.('credentials')
    if (typeof credentials?.set === 'function') await credentials.set(XAI_TOKEN_REF, token)
  }

  async retractToken() {
    const credentials = this.ctx?.get?.('credentials')
    if (typeof credentials?.unset === 'function') await credentials.unset(XAI_TOKEN_REF)
  }

  // —— 令牌文件 ——

  async readCredential() {
    let text
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    const value = JSON.parse(text)
    const credential = value?.credential
    if (value?.version !== 1 || credential === undefined
      || typeof credential.access !== 'string' || typeof credential.refresh !== 'string'
      || typeof credential.expires !== 'number') {
      throw new Error(`xAI 凭据文件格式不正确：${this.filename}`)
    }
    return { access: credential.access, refresh: credential.refresh, expires: credential.expires }
  }

  async loadFromDisk() {
    this.credential = await this.readCredential()
    this.loaded = true
    this.fileMtime = this.credential === undefined ? undefined : (await stat(this.filename)).mtimeMs
    return this.credential
  }

  /** 内存里的令牌可能被别的进程轮换过：mtime 变了就重读。 */
  async currentCredential() {
    if (!this.loaded) return this.loadFromDisk()
    try {
      const info = await stat(this.filename)
      if (this.fileMtime !== undefined && info.mtimeMs !== this.fileMtime) return this.loadFromDisk()
    } catch {
      // 文件暂时不可读（例如正在被替换）：先用内存里的副本
    }
    return this.credential
  }

  async writeCredential(credential) {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    const temp = `${this.filename}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify({ version: 1, credential }, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.filename)
    this.credential = credential
    this.loaded = true
    this.fileMtime = (await stat(this.filename)).mtimeMs
  }

  /** 当前有效令牌；快过期时用 refresh token 续期并重新发布。 */
  async bearerToken() {
    const current = await this.currentCredential()
    if (current === undefined) return undefined
    if (current.expires > Date.now()) return current.access
    if (this.refreshing === undefined) {
      this.refreshing = (async () => {
        const next = await this.refreshTokenRequest(current.refresh)
        await this.writeCredential(next)
        await this.publishToken(next.access)
        return next.access
      })().finally(() => {
        this.refreshing = undefined
      })
    }
    return this.refreshing
  }

  /** 启动时恢复：读文件、必要时续期、把令牌发布到凭据缝。 */
  async restore() {
    const credential = await this.loadFromDisk()
    if (credential === undefined) return false
    const token = await this.bearerToken()
    if (token !== undefined) await this.publishToken(token)
    return token !== undefined
  }

  /** 60 秒一次的续期巡检；返回停止函数。 */
  startRefreshTimer() {
    const timer = setInterval(() => {
      void this.bearerToken().catch((error) => {
        this.logger?.warn?.(`[balance-panel] xAI 令牌续期失败：${String(error?.message ?? error)}`)
      })
    }, REFRESH_POLL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  // —— 设备码登录 ——

  async postForm(url, fields, signal) {
    let response
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw new Error('Login cancelled')
      throw error
    }
    let body
    try {
      const parsed = await response.json()
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      if (signal?.aborted) throw new Error('Login cancelled')
      throw new Error(`xAI OAuth 返回的不是合法 JSON（HTTP ${response.status}）`)
    }
    return { ok: response.ok, status: response.status, body }
  }

  requestFailure(action, response) {
    const error = typeof response.body.error === 'string' ? response.body.error : undefined
    const description = typeof response.body.error_description === 'string' ? response.body.error_description : undefined
    const detail = [error, description].filter(Boolean).join(': ')
    return new Error(`xAI ${action} 失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
  }

  async refreshTokenRequest(refreshToken, signal) {
    const response = await this.postForm(TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }, signal)
    if (!response.ok) throw this.requestFailure('令牌续期', response)
    return credentialFromTokenResponse(response.body, refreshToken)
  }

  async startLogin() {
    if (this.loginSession !== undefined && this.loginSession.status === 'pending') {
      return { started: false, loginState: this.publicLoginState() }
    }
    this.lastLoginError = undefined
    const response = await this.postForm(DEVICE_CODE_URL, {
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: 'deepseek-harness',
    })
    if (!response.ok) throw this.requestFailure('设备授权申请', response)
    const device = this.parseDeviceCode(response.body)
    const session = {
      status: 'pending',
      device,
      startedAt: Date.now(),
      controller: new AbortController(),
      error: undefined,
    }
    this.loginSession = session
    void this.pollForTokens(session).catch(() => {})
    return { started: true, loginState: this.publicLoginState() }
  }

  parseDeviceCode(body) {
    const interval = body.interval
    const intervalSeconds = typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : undefined
    const verificationUriComplete = typeof body.verification_uri_complete === 'string' && body.verification_uri_complete.length > 0
      ? validateVerificationUri(body.verification_uri_complete)
      : undefined
    return {
      deviceCode: requiredString(body, 'device_code'),
      userCode: requiredString(body, 'user_code'),
      verificationUri: validateVerificationUri(requiredString(body, 'verification_uri')),
      verificationUriComplete,
      intervalSeconds,
      expiresInSeconds: positiveNumber(body, 'expires_in'),
    }
  }

  publicLoginState() {
    const session = this.loginSession
    if (session === undefined) return undefined
    if (session.status !== 'pending') return { status: session.status, error: session.error }
    return {
      status: 'pending',
      userCode: session.device.userCode,
      verificationUri: session.device.verificationUriComplete ?? session.device.verificationUri,
      expiresInSeconds: session.device.expiresInSeconds,
    }
  }

  async pollForTokens(session) {
    const device = session.device
    let intervalMs = (device.intervalSeconds ?? 5) * 1000
    try {
      for (;;) {
        if (session.controller.signal.aborted) {
          this.finishLogin(session, { status: 'cancelled' })
          return
        }
        await sleep(intervalMs, session.controller.signal)
        if (Date.now() - session.startedAt >= device.expiresInSeconds * 1000) {
          this.finishLogin(session, { status: 'failed', error: 'xAI 设备码已过期，请重新登录' })
          return
        }
        const response = await this.postForm(TOKEN_URL, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
        }, session.controller.signal)
        if (response.ok) {
          const credential = credentialFromTokenResponse(response.body)
          await this.writeCredential(credential)
          await this.publishToken(credential.access)
          this.finishLogin(session, { status: 'complete' })
          try { this.onLogin?.() } catch { /* 登录已成功，后续动作失败不影响 */ }
          return
        }
        const error = response.body.error
        if (error === 'authorization_pending') {
          intervalMs = (device.intervalSeconds ?? 5) * 1000
          continue
        }
        if (error === 'slow_down') {
          const interval = response.body.interval
          intervalMs = typeof interval === 'number' && Number.isFinite(interval) && interval > 0
            ? interval * 1000
            : intervalMs + 5000
          continue
        }
        if (error === 'access_denied' || error === 'authorization_denied') {
          this.finishLogin(session, { status: 'failed', error: 'xAI 设备授权被拒绝' })
          return
        }
        if (error === 'expired_token') {
          this.finishLogin(session, { status: 'failed', error: 'xAI 设备码已过期，请重新登录' })
          return
        }
        this.finishLogin(session, { status: 'failed', error: this.requestFailure('设备令牌轮询', response).message })
        return
      }
    } catch (error) {
      const cancelled = error instanceof Error && error.message === 'Login cancelled'
      if (!cancelled && this.loginSession === session) {
        this.logger?.warn?.('[balance-panel] xAI 令牌轮询失败')
        this.logger?.warn?.(error)
      }
      this.finishLogin(session, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
      })
    }
  }

  finishLogin(session, next) {
    if (this.loginSession !== session) return
    session.status = next.status
    session.error = next.error
    if (next.status === 'failed') this.lastLoginError = next.error
    if (next.status !== 'pending') session.controller.abort()
  }

  cancelLogin() {
    this.loginSession?.controller.abort()
    this.loginSession = undefined
  }

  async logout() {
    this.cancelLogin()
    this.lastLoginError = undefined
    this.usageCache = undefined
    this.usageError = undefined
    try {
      await unlink(this.filename)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    this.credential = undefined
    this.loaded = true
    this.fileMtime = undefined
    await this.retractToken()
    try { this.onLogout?.() } catch { /* 忽略后续动作失败 */ }
  }

  /** 前端状态：只有登录态与流程信息，绝不包含令牌。 */
  async status() {
    let credential
    try {
      credential = await this.currentCredential()
      if (credential !== undefined) {
        const token = await this.bearerToken()
        credential = this.credential ?? credential
        if (token === undefined) credential = undefined
      }
    } catch (error) {
      this.logger?.warn?.(`[balance-panel] xAI 状态读取失败：${String(error?.message ?? error)}`)
      credential = this.credential
    }
    const loginState = this.publicLoginState()
    return {
      loggedIn: credential !== undefined,
      ...(credential === undefined ? {} : { expiresAt: credential.expires }),
      loginPending: loginState?.status === 'pending',
      loginState,
      loginError: this.lastLoginError,
      csrf: this.csrf,
    }
  }

  /** 余额查询共用的用量快照，30 秒内复用。 */
  async fetchUsage({ refresh = false } = {}) {
    if (!refresh && this.usageCache !== undefined && Date.now() - this.usageCache.fetchedAt < USAGE_CACHE_MS) {
      return this.usageCache
    }
    const access = await this.bearerToken()
    if (access === undefined) {
      const error = new Error('尚未登录 xAI')
      error.code = 'XAI_NOT_LOGGED_IN'
      throw error
    }
    try {
      this.usageCache = await fetchGrokUsage({ apiKey: access, fetchImpl: this.fetch })
      this.usageError = undefined
      return this.usageCache
    } catch (error) {
      this.usageError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
}

export default XaiOAuthService
