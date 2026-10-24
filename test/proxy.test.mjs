/**
 * 代理分流测试：用本地目标服务器 + 本地假代理验证真实 fetch 的去向，
 * 以及「跟随默认」确实把请求交给安装前的 dispatcher。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { apply } from '../index.js'
import { ProxyRouter, normalizeProxyUrl, providerHosts } from '../src/proxy.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'balance-proxy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return server.address().port
}

test('normalizeProxyUrl：补 scheme、拒绝 SOCKS 与非法值', () => {
  assert.equal(normalizeProxyUrl(''), '')
  assert.equal(normalizeProxyUrl('  '), '')
  assert.equal(normalizeProxyUrl('127.0.0.1:7897'), 'http://127.0.0.1:7897/')
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7897'), 'http://127.0.0.1:7897/')
  assert.equal(normalizeProxyUrl('https://proxy.example.com:8443'), 'https://proxy.example.com:8443/')
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), undefined)
  assert.equal(normalizeProxyUrl('not a url'), undefined)
  assert.equal(normalizeProxyUrl(42), undefined)
})

test('providerHosts：xAI 的授权与计费域跟着供应商一起走', () => {
  const hosts = providerHosts({ id: 'xai', baseUrl: 'https://api.x.ai/v1', vendor: 'grok' })
  for (const host of ['api.x.ai', 'auth.x.ai', 'cli-chat-proxy.grok.com']) {
    assert.ok(hosts.includes(host), host)
  }
  assert.deepEqual(providerHosts({ id: 'glm', baseUrl: 'https://open.bigmodel.cn/api/anthropic' }), ['open.bigmodel.cn'])
})

test('真实路由：走代理 / 直连 / 清空规则后恢复原状', async (t) => {
  const previous = getGlobalDispatcher()
  t.after(() => setGlobalDispatcher(previous))

  const targetPort = await listen(t, (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ route: 'direct' }))
  })
  const proxyPort = await listen(t, (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ route: 'proxy' }))
  })
  const origin = `http://127.0.0.1:${targetPort}`
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const router = new ProxyRouter({})
  t.after(() => router.dispose())

  assert.equal((await (await fetch(origin)).json()).route, 'direct')

  await router.sync({ proxyUrl, rules: new Map([['127.0.0.1', 'proxy']]) })
  assert.equal((await (await fetch(origin)).json()).route, 'proxy')

  await router.sync({ proxyUrl, rules: new Map([['127.0.0.1', 'direct']]) })
  assert.equal((await (await fetch(origin)).json()).route, 'direct')

  await router.sync({ proxyUrl, rules: new Map() })
  assert.equal((await (await fetch(origin)).json()).route, 'direct')
  assert.equal(getGlobalDispatcher(), previous)
})

test('跟随默认：请求原样转交安装前的 dispatcher', async (t) => {
  const previous = getGlobalDispatcher()
  const mock = new MockAgent()
  mock.disableNetConnect()
  const origin = 'http://egress.test'
  mock.get(origin).intercept({ path: '/x', method: 'GET' }).reply(200, { route: 'previous' })
  setGlobalDispatcher(mock)
  const router = new ProxyRouter({})
  t.after(async () => {
    await router.dispose()
    setGlobalDispatcher(previous)
    await mock.close()
  })

  // 装了路由，但 egress.test 没有任何显式规则 → 必须仍由 mock 回答
  await router.sync({ proxyUrl: 'http://127.0.0.1:9', rules: new Map([['other.test', 'direct']]) })
  assert.equal((await (await fetch(`${origin}/x`)).json()).route, 'previous')
})

// —— 设置路由：校验、落盘、按规则安装/恢复全局 dispatcher ——

function fakeRes() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(body) { captured.body = body ?? '' },
  }
}

function fakeReq(body) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))])
  stream.url = '/api/dsh-balance-panel/proxy'
  stream.method = 'POST'
  stream.headers = {}
  return stream
}

test('代理设置路由：校验地址、按供应商保存、清空后恢复 dispatcher', async (t) => {
  const dir = tempDir(t)
  const home = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const previous = getGlobalDispatcher()
  t.after(() => {
    process.env.DSH_HOME = home
    setGlobalDispatcher(previous)
  })

  const routes = []
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) { fn() },
    get(name) {
      if (name === 'configEditor') {
        return {
          configuration: () => [{
            entry: { options: { id: 'llm-pi-ai' } },
            override: { providers: { xai: { displayName: 'xAI', baseURL: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_OAUTH_TOKEN' } } },
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
  apply(ctx, { xaiPath: join(dir, 'none.json'), xaiAutoProvider: false })
  const route = routes.find((item) => item.path === '/api/dsh-balance-panel')
  assert.equal(getGlobalDispatcher(), previous, '没有规则时不应动全局 dispatcher')

  const bad = fakeRes()
  await route.handler(fakeReq({ url: 'socks5://127.0.0.1:1080' }), bad)
  assert.equal(bad.captured.status, 400)

  const savedUrl = fakeRes()
  await route.handler(fakeReq({ url: '127.0.0.1:7897' }), savedUrl)
  assert.equal(savedUrl.captured.status, 200)
  assert.equal(JSON.parse(savedUrl.captured.body).proxy.url, 'http://127.0.0.1:7897/')

  const savedMode = fakeRes()
  await route.handler(fakeReq({ provider: 'xai', mode: 'proxy' }), savedMode)
  assert.equal(savedMode.captured.status, 200)
  assert.equal(JSON.parse(savedMode.captured.body).proxy.providers.xai, 'proxy')
  assert.notEqual(getGlobalDispatcher(), previous, '有 proxy 规则后应安装路由')
  const onDisk = JSON.parse(readFileSync(join(dir, 'data', 'balance-panel', 'settings.json'), 'utf8'))
  assert.equal(onDisk.proxy.url, 'http://127.0.0.1:7897/')
  assert.equal(onDisk.proxy.providers.xai, 'proxy')

  const cleared = fakeRes()
  await route.handler(fakeReq({ provider: 'xai', mode: 'default' }), cleared)
  assert.equal(cleared.captured.status, 200)
  assert.equal(getGlobalDispatcher(), previous, '清空规则后要恢复原 dispatcher')
})
