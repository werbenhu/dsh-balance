/**
 * 前端 bundle 冒烟测试：用假的 ModuleLoader + 假 ctx 跑一遍 apply()。
 *
 * 不渲染真实 DOM，主要验证：
 *   1. bundle 的注册契约能与宿主对上（id / exports / inject / apply）；
 *   2. 各座位都注册到了，而且缺右侧栏服务时会安静退化，不抛错；
 *   3. 右侧栏可用时，tab 类型 / tab 身体在**加载期**就注册好，且入口只在
 *      「有会话在屏」时才拦截点击；
 *   4. 卡片能通过拖拽手柄重排，并把完整顺序交给 Host 保存；
 *   5. xAI 的设备码登录挂在「设置 → 模型」的卡片上，余额卡只提示去哪里授权。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))

/**
 * 极简 React 替身。
 *
 * 函数组件当场执行；宿主元素变成带 `closest()` 的假节点，`ref` 直接写回去。
 * `useEffect` 只登记，等渲染返回后再 flush —— 和真实 React「提交后才跑 effect」
 * 的顺序一致，否则 effect 里读 ref 会是空的。
 */
const pendingEffects = []
let currentRow = null
let hookSession

const fakeReact = {
  createElement(type, props, ...children) {
    if (typeof type === 'function') return type(props ?? {})
    const node = {
      type,
      props: props ?? {},
      children,
      closest: () => currentRow,
    }
    if (props !== undefined && props !== null && props.ref !== undefined) props.ref.current = node
    return node
  },
  useState(initial) {
    if (hookSession === undefined) return [typeof initial === 'function' ? initial() : initial, () => {}]
    const session = hookSession
    const index = session.cursor++
    if (!(index in session.values)) session.values[index] = typeof initial === 'function' ? initial() : initial
    const setValue = (next) => {
      const previous = session.values[index]
      session.values[index] = typeof next === 'function' ? next(previous) : next
    }
    return [session.values[index], setValue]
  },
  useEffect: (fn) => {
    pendingEffects.push(fn)
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef(value) {
    if (hookSession === undefined) return { current: value }
    const session = hookSession
    const index = session.cursor++
    if (!(index in session.values)) session.values[index] = { current: value }
    return session.values[index]
  },
}

function createHookRenderer() {
  const session = { values: [], cursor: 0 }
  return (render) => {
    const previous = hookSession
    session.cursor = 0
    hookSession = session
    try {
      return render()
    } finally {
      hookSession = previous
    }
  }
}

function flushEffects() {
  const cleanups = []
  while (pendingEffects.length > 0) {
    const cleanup = pendingEffects.shift()()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return cleanups
}

/** 加载 client.js：把 window.__ModuleLoader__ 换成假的，拿到插件导出。 */
function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let captured

  const fakeWindow = {
    // 宿主浏览器里这些都在：登录态轮询用 setInterval，授权页用 open
    setInterval: () => 0,
    clearInterval: () => {},
    open: () => null,
    __ModuleLoader__: {
      load(options) {
        captured = options
      },
    },
  }

  // 用 Function 包一层，模拟宿主把 bundle 当普通脚本执行
  new Function('window', source)(fakeWindow)

  assert.ok(captured !== undefined, 'bundle 没有调用 __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-balance-panel')
  assert.equal(typeof captured.factory, 'function')

  const require_ = (id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  }

  return captured.factory(require_)
}

/**
 * 假 ctx。
 *
 * `drawer: true` 时 `ctx.inject(['sidebarRightTabs','sidebarRight'])` 会像真宿主
 * 一样立刻回调（服务已在）；`mounted` 用 `session` 控制「有没有会话在屏」。
 */
function makeCtx({ drawer = false, session = 's1', selected = undefined } = {}) {
  const seats = []
  let mounted = session === null ? undefined : session

  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      subscribe: () => () => {},
    },
    slots: {
      inject(name, callback) {
        seats.push({ kind: 'inject', name })
        return callback()
      },
      register(spec, component) {
        seats.push({ kind: 'register', spec, component })
        return () => {}
      },
    },
    inject(names, callback) {
      seats.push({ kind: 'ctx.inject', names })
      if (!drawer) return () => {}
      callback(ctx)
      return () => {}
    },
    get(name) {
      if (drawer) {
        if (name === 'sidebarRightTabs') {
          return {
            register: (spec) => {
              seats.push({ kind: 'tabs', spec })
              return () => {}
            },
          }
        }
        if (name === 'sidebarRight') {
          return {
            mounted: { getSnapshot: () => mounted },
            openTab: (kind) => {
              seats.push({ kind: 'openTab', opened: kind })
            },
          }
        }
        if (name === 'layout') {
          return {
            selectPanel: (id) => {
              seats.push({ kind: 'selectPanel', id })
            },
          }
        }
        if (name === 'uiWorkspace' && selected !== undefined) {
          return {
            selection: { getSnapshot: () => ({ sessionId: selected }) },
          }
        }
      }
      return undefined
    },
  }

  return {
    ctx,
    seats,
    setSession: (value) => {
      mounted = value
    },
  }
}

test('bundle 导出 name / inject / apply', () => {
  const exported = loadClient()
  assert.equal(exported.name, 'dsh-balance-panel-client')
  assert.deepEqual(exported.inject, ['slots', 'locale'])
  assert.equal(typeof exported.apply, 'function')
})

test('没有右侧栏服务时：设置区块、侧边栏入口、主面板都注册上，不碰 tab', () => {
  const exported = loadClient()
  const { ctx, seats } = makeCtx({ drawer: false })

  assert.doesNotThrow(() => exported.apply(ctx))

  const names = seats.filter((seat) => seat.kind === 'inject').map((seat) => seat.name)
  assert.ok(names.includes('settings.section'))
  assert.ok(names.includes('settings.models.provider-card'))
  assert.ok(names.includes('sidebar.panellist'))
  assert.ok(names.includes('main'))
  assert.equal(names.includes('settings.models.footer'), false, '模型页底部不该再有总表')

  const specs = seats.filter((seat) => seat.kind === 'register').map((seat) => seat.spec)
  assert.equal(specs.find((spec) => spec.name === 'settings.section').id, 'balance-panel')
  assert.equal(specs.find((spec) => spec.name === 'settings.models.provider-card').key, 'llm-pi-ai')
  assert.equal(specs.find((spec) => spec.name === 'sidebar.panellist').id, 'balance-panel')
  assert.equal(specs.find((spec) => spec.name === 'main').key, 'balance-panel')
  assert.equal(specs.some((spec) => spec.name === 'settings.models.footer'), false)
  assert.equal(seats.some((seat) => seat.kind === 'tabs'), false)
  assert.equal(seats.some((seat) => seat.kind === 'openTab'), false)
})

test('有右侧栏服务时：加载期就注册 tab 类型与身体，身体 key 用类型 id', () => {
  const exported = loadClient()
  const { ctx, seats } = makeCtx({ drawer: true })

  exported.apply(ctx)

  const tabs = seats.find((seat) => seat.kind === 'tabs')
  assert.ok(tabs !== undefined, '没有注册右侧栏 tab 类型')
  assert.equal(tabs.spec.id, 'dsh-balance-panel')
  assert.equal(tabs.spec.kind, 'balance-panel')
  assert.equal(tabs.spec.keepMounted, true)
  assert.equal(typeof tabs.spec.title(), 'string')
  assert.equal(tabs.spec.guide[0].id, 'overview')

  const pane = seats.filter((seat) => seat.kind === 'register').map((seat) => seat.spec)
  assert.ok(
    pane.some((spec) => spec.name === 'sidebar.right.pane.tab' && spec.key === 'dsh-balance-panel'),
    'tab 身体没有挂在 sidebar.right.pane.tab 的 id 上',
  )
  assert.equal(seats.some((seat) => seat.kind === 'openTab'), false, 'apply 不应该自己开 tab')
})

test('入口拦截：有会话在屏才吃掉点击，没有会话就放行给整页', () => {
  const exported = loadClient()
  const { ctx, seats, setSession } = makeCtx({ drawer: true })
  exported.apply(ctx)

  const entry = seats.find((seat) => seat.kind === 'register' && seat.spec.name === 'sidebar.panellist')
  assert.equal(typeof entry.component, 'function')

  const listeners = []
  currentRow = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: () => {},
  }

  const element = entry.component({ size: 16 })
  assert.equal(element.type, 'svg')
  flushEffects()

  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].type, 'click')
  assert.equal(listeners[0].capture, true, '必须用 capture，抢在宿主 onClick 之前')

  const onClick = listeners[0].fn
  const stopped = []
  const event = { preventDefault: () => stopped.push('prevent'), stopPropagation: () => stopped.push('stop') }

  // 有会话在屏：吃掉点击，开右侧栏的 tab
  onClick(event)
  assert.deepEqual(stopped, ['prevent', 'stop'])
  assert.equal(seats.find((seat) => seat.kind === 'openTab')?.opened, 'balance-panel')

  // 没有会话在屏：放行，让宿主切到整页；不 prevent、不自己开 tab
  setSession(undefined)
  const openedBefore = seats.filter((seat) => seat.kind === 'openTab').length
  stopped.length = 0
  onClick(event)
  assert.deepEqual(stopped, [])
  assert.equal(seats.filter((seat) => seat.kind === 'openTab').length, openedBefore)
  assert.equal(seats.some((seat) => seat.kind === 'selectPanel'), false)
  currentRow = null
})

test('主视图被别的面板占着但会话还选着：先回对话，再开右侧栏', async () => {
  const exported = loadClient()
  const { ctx, seats, setSession } = makeCtx({ drawer: true, session: null, selected: 's1' })
  exported.apply(ctx)

  const entry = seats.find((seat) => seat.kind === 'register' && seat.spec.name === 'sidebar.panellist')
  const listeners = []
  currentRow = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: () => {},
  }

  entry.component({ size: 16 })
  flushEffects()

  const onClick = listeners[0].fn
  const stopped = []
  onClick({
    preventDefault: () => stopped.push('prevent'),
    stopPropagation: () => stopped.push('stop'),
  })

  assert.deepEqual(stopped, ['prevent', 'stop'])
  assert.deepEqual(seats.filter((seat) => seat.kind === 'selectPanel').map((seat) => seat.id), [null])

  // 对话挂回来，会话面出现 —— 轮询应该把 tab 打开
  setSession('s1')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(seats.find((seat) => seat.kind === 'openTab')?.opened, 'balance-panel')
  currentRow = null
})

test('卡片展示与拖拽：长小数保留两位，放下后重排并保存顺序', async () => {
  const exported = loadClient()
  const { ctx, seats } = makeCtx({ drawer: false })
  exported.apply(ctx)

  const originalFetch = globalThis.fetch
  const writes = []
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === '/api/dsh-balance-panel/summary') {
      const providers = ['first', 'second', 'third'].map((id) => ({
        id,
        label: id,
        vendorSource: 'auto',
        result: id === 'first'
          ? {
            ok: true,
            kind: 'balance',
            summary: '38.9142845400000000',
            currency: 'CNY',
            details: [{ label: '充值余额', value: '¥38.9142845400000000' }],
          }
          : id === 'second'
            ? {
              ok: true,
              kind: 'balance',
              summary: '68.0409584558',
              details: [{ label: '月度额度', value: '68.0409584558' }],
            }
            : { ok: true, kind: 'balance', summary: '1', details: [] },
      }))
      return new Response(JSON.stringify({ providers }), { status: 200 })
    }
    if (String(url) === '/api/dsh-balance-panel/order' && init.method === 'POST') {
      writes.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }

  const render = createHookRenderer()
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const visit = (node, found = []) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, found)
      return found
    }
    if (node === null || typeof node !== 'object') return found
    found.push(node)
    return visit(node.children ?? [], found)
  }
  const textOf = (node) => {
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    return textOf(node.children ?? [])
  }
  const cards = (tree) => visit(tree).filter((node) => node.props?.['data-provider-id'] !== undefined)
  const card = (tree, id) => cards(tree).find((node) => node.props['data-provider-id'] === id)
  const ids = (tree) => cards(tree).map((node) => node.props['data-provider-id'])

  try {
    const registration = seats.find((seat) => seat.kind === 'register' && seat.spec.name === 'settings.section')
    const renderSettings = () => render(() => registration.component({ t: (key) => key }))
    let tree = renderSettings()
    flushEffects()
    await settle()
    tree = renderSettings()
    assert.deepEqual(ids(tree), ['first', 'second', 'third'])
    const displayed = textOf(card(tree, 'first'))
    assert.equal(displayed.match(/¥38\.91/g)?.length, 2)
    assert.doesNotMatch(displayed, /38\.914284/)
    const quotaDisplayed = textOf(card(tree, 'second'))
    assert.equal(quotaDisplayed.match(/68\.04/g)?.length, 2)
    assert.doesNotMatch(quotaDisplayed, /68\.040958/)

    const handle = visit(card(tree, 'first')).find((node) => node.props?.draggable === true)
    assert.ok(handle !== undefined, '没有找到拖拽手柄')
    let draggedId
    handle.props.onDragStart({
      dataTransfer: {
        effectAllowed: '',
        setData: (type, value) => {
          assert.equal(type, 'text/plain')
          draggedId = value
        },
      },
    })
    assert.equal(draggedId, 'first')

    tree = renderSettings()
    assert.equal(card(tree, 'first').props.style.opacity, 0.45)
    card(tree, 'third').props.onDragOver({ preventDefault() {} })
    tree = renderSettings()
    assert.ok(card(tree, 'third').props.style.boxShadow !== undefined)

    card(tree, 'third').props.onDrop({ preventDefault() {} })
    tree = renderSettings()
    assert.deepEqual(ids(tree), ['second', 'third', 'first'])
    assert.equal(card(tree, 'first').props.style.opacity, 1)

    await settle()
    assert.deepEqual(writes, [{ order: ['second', 'third', 'first'] }])
  } finally {
    globalThis.fetch = originalFetch
    pendingEffects.length = 0
  }
})

test('xAI 授权在「设置 → 模型」：草稿卡也给出登录入口，余额卡只提示去授权', async () => {
  const exported = loadClient()
  const { ctx, seats } = makeCtx({ drawer: false })
  exported.apply(ctx)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const route = String(url)
    if (route === '/api/dsh-balance-panel/xai/status') {
      return new Response(JSON.stringify({ loggedIn: false, loginPending: false }), { status: 200 })
    }
    if (route === '/api/dsh-balance-panel/summary') {
      return new Response(JSON.stringify({
        providers: [{ id: 'xai', label: 'xAI (Grok)', vendor: 'grok', vendorSource: 'auto', result: { ok: false, needsLogin: true } }],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }

  const render = createHookRenderer()
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const visit = (node, found = []) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, found)
      return found
    }
    if (node === null || typeof node !== 'object') return found
    found.push(node)
    return visit(node.children ?? [], found)
  }
  const textOf = (node) => {
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    return textOf(node.children ?? [])
  }
  const buttons = (tree) => visit(tree).filter((node) => node.type === 'button')
  const buttonLabels = (tree) => buttons(tree).map((node) => textOf(node.children))

  try {
    const cell = seats.find((seat) => seat.kind === 'register' && seat.spec.name === 'settings.models.provider-card').component
    const draft = (providerId, displayName) => render(() => cell({
      provider: { provider: providerId, displayName },
      configured: false,
      t: (key) => key,
    }))

    let tree = draft('xai', 'xAI (Grok)')
    flushEffects()
    await settle()
    tree = draft('xai', 'xAI (Grok)')
    assert.ok(textOf(tree).includes('xai.authLabel'), 'xAI 卡片上没有授权区')
    assert.deepEqual(buttonLabels(tree), ['xai.login'], '未登录时应给出登录按钮（不加余额方式的草稿卡也一样）')

    // 别的供应商不该冒出 xAI 授权
    flushEffects()
    await settle()
    assert.equal(textOf(draft('deepseek', 'DeepSeek')), '')

    // 余额卡：只提示去模型页授权，不再自带登录/退出
    const registration = seats.find((seat) => seat.kind === 'register' && seat.spec.name === 'settings.section')
    const renderSettings = () => render(() => registration.component({ t: (key) => key }))
    let panel = renderSettings()
    flushEffects()
    await settle()
    panel = renderSettings()
    const card = visit(panel).find((node) => node.props?.['data-provider-id'] === 'xai')
    assert.ok(card !== undefined, '没有渲染 Grok 卡')
    assert.ok(textOf(card).includes('xai.signInOnModels'), '余额卡应指路到「设置 → 模型」')
    assert.equal(textOf(card).includes('xai.login'), false, '余额卡不该再放登录按钮')
    assert.equal(buttonLabels(card).includes('xai.logout'), false, '余额卡不该再放退出按钮')
  } finally {
    globalThis.fetch = originalFetch
    pendingEffects.length = 0
  }
})
