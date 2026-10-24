/**
 * xAI 集成测试：OAuth 服务（离线假 fetch）+ 面板路由 + 模型路由自动配置。
 *
 * 不碰真实 ~/.dsh：令牌文件都放在临时目录；不打真实网络。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply, ensureXaiProvider } from '../index.js'
import { XAI_TOKEN_REF, XaiOAuthService } from '../src/xai-oauth.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'balance-xai-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function seedCredential(dir, { expires = Date.now() + 3600_000, access = 'oauth-token' } = {}) {
  const file = join(dir, 'xai-oauth.json')
  writeFileSync(file, JSON.stringify({ version: 1, credential: { access, refresh: 'refresh-token', expires } }))
  return file
}

const TOKEN_OK = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }

/** 凭据缝的内存版，记录 set/unset。 */
function fakeCredentials() {
  const store = new Map()
  return {
    store,
    async set(key, value) { store.set(key, value) },
    async unset(key) { store.delete(key) },
    async describe(key) { return { configured: store.has(key) } },
    async resolve(key) { return store.has(key) ? { value: store.get(key) } : undefined },
  }
}

test('restore：读已有令牌文件并发布到凭据缝，状态里不含令牌', async (t) => {
  const dir = tempDir(t)
  const file = seedCredential(dir)
  const credentials = fakeCredentials()
  const xai = new XaiOAuthService({ ctx: { get: () => credentials }, filename: file })

  assert.equal(await xai.restore(), true)
  assert.equal(credentials.store.get(XAI_TOKEN_REF), 'oauth-token')

  const status = await xai.status()
  assert.equal(status.loggedIn, true)
  assert.equal(JSON.stringify(status).includes('oauth-token'), false)
  assert.equal(typeof status.csrf, 'string')
})

test('过期令牌：用 refresh token 续期、写盘并发布新令牌', async (t) => {
  const dir = tempDir(t)
  const file = seedCredential(dir, { expires: Date.now() - 1000 })
  const credentials = fakeCredentials()
  const calls = []
  const xai = new XaiOAuthService({
    ctx: { get: () => credentials },
    filename: file,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: String(init.body) })
      return new Response(JSON.stringify(TOKEN_OK), { status: 200 })
    },
  })

  assert.equal(await xai.bearerToken(), 'new-access')
  assert.equal(calls.length, 1)
  assert.match(calls[0].body, /grant_type=refresh_token/)
  assert.match(calls[0].body, /refresh_token=refresh-token/)
  assert.equal(credentials.store.get(XAI_TOKEN_REF), 'new-access')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).credential.access, 'new-access')
})

test('设备码登录：pending → complete，写令牌并回调 onLogin', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'xai-oauth.json')
  const credentials = fakeCredentials()
  let tokenPolls = 0
  let loggedIn = 0
  const xai = new XaiOAuthService({
    ctx: { get: () => credentials },
    filename: file,
    onLogin: () => { loggedIn += 1 },
    fetchImpl: async (url) => {
      const target = String(url)
      if (target.endsWith('/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'device-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://x.ai/device',
          interval: 0.05,
          expires_in: 900,
        }), { status: 200 })
      }
      tokenPolls += 1
      if (tokenPolls === 1) return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
      return new Response(JSON.stringify(TOKEN_OK), { status: 200 })
    },
  })

  const started = await xai.startLogin()
  assert.equal(started.started, true)
  assert.equal(started.loginState.userCode, 'ABCD-1234')
  assert.equal(started.loginState.verificationUri, 'https://x.ai/device')

  await new Promise((resolve) => setTimeout(resolve, 250))
  const status = await xai.status()
  assert.equal(status.loggedIn, true)
  assert.equal(loggedIn, 1)
  assert.ok(tokenPolls >= 2)
  assert.equal(credentials.store.get(XAI_TOKEN_REF), 'new-access')

  await xai.logout()
  assert.equal(existsSync(file), false)
  assert.equal(credentials.store.has(XAI_TOKEN_REF), false)
  assert.equal((await xai.status()).loggedIn, false)
})

test('未登录时 fetchUsage 抛 XAI_NOT_LOGGED_IN', async (t) => {
  const dir = tempDir(t)
  const xai = new XaiOAuthService({ filename: join(dir, 'missing.json') })
  await assert.rejects(() => xai.fetchUsage(), (error) => error.code === 'XAI_NOT_LOGGED_IN')
})

test('ensureXaiProvider：自动补齐路由并保留其它供应商与 models，二次调用不再写', async () => {
  const entry = {
    options: {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          deepseek: { displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com' },
          xai: { models: [{ id: 'grok-4.7', name: 'Grok 4.7' }] },
        },
      },
    },
  }
  const edits = []
  const editor = {
    entries: () => [entry],
    configuration: () => [],
    async edit(target, change) {
      assert.equal(target, entry)
      entry.options.config = change(entry.options.config, {})
      edits.push(entry.options.config)
    },
  }
  const ctx = { get: (name) => (name === 'configEditor' ? editor : undefined) }

  const first = await ensureXaiProvider(ctx)
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  const providers = edits[0].providers
  assert.equal(providers.deepseek.displayName, 'DeepSeek')
  assert.deepEqual(providers.xai.models, [{ id: 'grok-4.7', name: 'Grok 4.7' }])
  assert.equal(providers.xai.apiKeyEnv, XAI_TOKEN_REF)
  assert.equal(providers.xai.api, 'openai-responses')
  assert.equal(providers.xai.baseURL, 'https://api.x.ai/v1')

  const second = await ensureXaiProvider(ctx)
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
  assert.equal(edits.length, 1)
})

// —— 面板路由级：OAuth 令牌直接喂给余额聚合，退出后卡片变成待登录 ——

function fakeRes() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(body) { captured.body = body ?? '' },
  }
}

function fakeReq({ url, method = 'GET', headers = {} }) {
  const stream = Readable.from([Buffer.from('{}')])
  stream.url = url
  stream.method = method
  stream.headers = headers
  return stream
}

test('面板路由：Grok 卡走 OAuth 令牌，退出登录后转为 needsLogin', async (t) => {
  const dir = tempDir(t)
  const file = seedCredential(dir)
  const credentials = fakeCredentials()
  const routes = []
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) { fn() },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'configEditor') {
        return {
          configuration: () => [{
            entry: { options: { id: 'llm-pi-ai' } },
            override: {
              providers: {
                xai: { displayName: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', apiKeyEnv: XAI_TOKEN_REF },
              },
            },
            inherited: {},
          }],
        }
      }
      return undefined
    },
    inject(_deps, fn) {
      fn({ webServer: { register(spec) { routes.push(spec); return () => {} } }, effect(inner) { inner() } })
    },
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/v1/billing')) {
      return new Response(JSON.stringify({
        subscription_tier: 'SuperGrok',
        config: { creditUsagePercent: 21, currentPeriod: { type: 'WEEKLY', end: '2026-10-27T08:10:12+00:00' } },
      }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }

  try {
    apply(ctx, { xaiPath: file, xaiAutoProvider: false, cacheMs: 0 })
    const route = routes.find((item) => item.path === '/api/dsh-balance-panel')
    assert.ok(route !== undefined)

    const summaryRes = fakeRes()
    await route.handler(fakeReq({ url: '/api/dsh-balance-panel/summary' }), summaryRes)
    const summary = JSON.parse(summaryRes.captured.body)
    const grok = summary.providers.find((item) => item.id === 'xai')
    assert.equal(grok.result.ok, true)
    assert.equal(grok.result.summary, '21%')
    assert.equal(grok.result.planType, 'SuperGrok')
    assert.equal(JSON.stringify(summary).includes('oauth-token'), false)

    const statusRes = fakeRes()
    await route.handler(fakeReq({ url: '/api/dsh-balance-panel/xai/status' }), statusRes)
    const status = JSON.parse(statusRes.captured.body)
    assert.equal(status.loggedIn, true)

    const forbidden = fakeRes()
    await route.handler(fakeReq({ url: '/api/dsh-balance-panel/xai/logout', method: 'POST' }), forbidden)
    assert.equal(forbidden.captured.status, 403)

    const logoutRes = fakeRes()
    await route.handler(fakeReq({
      url: '/api/dsh-balance-panel/xai/logout',
      method: 'POST',
      headers: { 'x-dsh-csrf': status.csrf },
    }), logoutRes)
    assert.equal(logoutRes.captured.status, 200)
    assert.equal(existsSync(file), false)

    const afterRes = fakeRes()
    await route.handler(fakeReq({ url: '/api/dsh-balance-panel/summary' }), afterRes)
    const after = JSON.parse(afterRes.captured.body)
    assert.equal(after.providers.find((item) => item.id === 'xai').result.needsLogin, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
