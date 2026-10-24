/**
 * 余额面板 —— Client 侧。
 *
 * 四个贡献：
 *   1. `settings.models.provider-card` —— 每个供应商卡片里加一行「余额查询」，
 *      就地选查询方式（自动识别 / 指定哪家 / 不查询）。
 *   2. `settings.section` —— 设置页里一个「余额」区块：同一份选择的全宽版本，
 *      带每家的实时余额。
 *   3. `sidebar.panellist` + `main` —— 侧边栏的余额入口。有会话在屏时，点击
 *      会在 capture 阶段被吃掉，直接拉起右侧栏的 tab、主视图一步都不动；
 *      没有会话（或宿主没有右侧栏服务）时才退回整页列表。
 *   4. `sidebar.right.pane.tab` —— 右侧栏的本体。
 *
 * 模型页不再额外挂底部总表：卡片里那一行已经够用，多一张表是重复入口。
 *
 * 为什么入口要拦截点击：右侧栏是**按会话**的，宿主只在「主视图还是对话」时
 * 才认为有会话在屏（`activePanelId === null`）。一旦 `main` 换成插件的整页，
 * `openTab` 就会抛 `no session surface is mounted`。
 *
 * 手写 ModuleLoader bundle，无构建步骤；除 shell 提供的 `react` 外无依赖。
 * 颜色只用半透明灰与状态色，亮/暗色主题都能看。
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-panel',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    /** 与 cordis.patch.yml 里的 id、路由前缀保持一致。 */
    const PANEL_ID = 'balance-panel'
    /** 右侧栏 tab 的两段注册：类型 id / kind，身体槽的 key 用 id。 */
    const DRAWER_ID = 'dsh-balance-panel'
    const DRAWER_KIND = 'balance-panel'
    const NS = 'settings.balancePanel'
    const SUMMARY_ROUTE = '/api/dsh-balance-panel/summary'
    const REFRESH_ROUTE = '/api/dsh-balance-panel/refresh'
    const VENDORS_ROUTE = '/api/dsh-balance-panel/vendors'
    const VENDOR_ROUTE = '/api/dsh-balance-panel/vendor'
    const ORDER_ROUTE = '/api/dsh-balance-panel/order'
    const PROVIDERS_ROUTE = '/api/dsh-balance-panel/providers'
    const XAI_STATUS_ROUTE = '/api/dsh-balance-panel/xai/status'
    const XAI_LOGIN_ROUTE = '/api/dsh-balance-panel/xai/login'
    const XAI_LOGOUT_ROUTE = '/api/dsh-balance-panel/xai/logout'
    const XAI_CANCEL_ROUTE = '/api/dsh-balance-panel/xai/cancel'
    const PROXY_ROUTE = '/api/dsh-balance-panel/proxy'

    /** 查询方式目录只需取一次：模块级缓存，多个组件共用。 */
    let vendorsCache

    function useVendors() {
      const [vendors, setVendors] = useState(vendorsCache ?? [])
      useEffect(() => {
        if (vendorsCache !== undefined) return
        fetch(VENDORS_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : { vendors: [] }))
          .then((payload) => {
            vendorsCache = Array.isArray(payload.vendors) ? payload.vendors : []
            setVendors(vendorsCache)
          })
          .catch(() => {
            vendorsCache = []
          })
      }, [])
      return vendors
    }

    /**
     * 状态色与描边一律走宿主主题 token（`--dsw-alias-*`），亮/暗色自动跟随；
     * 不再硬编码色值，也不去读 `data-ds-dark-theme`。
     */
    const TONE = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-label-tertiary)',
    }

    const toneOf = (percent) => {
      if (percent === undefined) return TONE.idle
      if (percent >= 90) return TONE.bad
      if (percent >= 70) return TONE.warn
      return TONE.ok
    }

    /** 把毫秒时间戳说成人话：3 小时后重置 / 10 月 26 日 08:00 重置。 */
    function formatReset(ms, t) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
      const delta = ms - Date.now()
      if (delta <= 0) return t('reset.now')
      const minutes = Math.round(delta / 60000)
      if (minutes < 60) return t('reset.minutes', String(minutes))
      const hours = Math.round(delta / 3600000)
      if (hours < 48) return t('reset.hours', String(hours))
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return t('reset.at', `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${pad(date.getHours())}:${pad(date.getMinutes())}`)
    }

    const displayNumber = (text) => {
      const value = Number(text)
      if (!Number.isFinite(value)) return text
      return Number.isInteger(value) && !text.includes('.') ? String(value) : value.toFixed(2)
    }

    const displayValue = (value) => String(value).replace(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/gi, displayNumber)

    const money = (value, currency) => {
      if (value === undefined || value === null || value === '') return ''
      const text = displayValue(value)
      if (text.startsWith('$') || text.startsWith('¥')) return text
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
      return `${symbol}${text}`
    }

    /** 一条结果里的可展示明细：带百分比的画进度条，其余画「标签 + 数值」。 */
    function MetricRow({ item, t }) {
      const percent = typeof item.percent === 'number' ? Math.min(100, Math.max(0, item.percent)) : undefined
      const reset = formatReset(item.resetAt, t)

      if (percent === undefined) {
        return h('div', { style: styles.metricLine },
          h('span', { style: styles.metricLabel }, item.label),
          h('span', { style: styles.metricValue }, displayValue(item.value ?? '')),
        )
      }

      return h('div', { style: styles.metricBlock },
        h('div', { style: styles.metricHead },
          h('span', { style: styles.metricLabel }, item.label),
          h('span', { style: { ...styles.metricValue, color: toneOf(percent) } },
            item.value === undefined ? t('used.percent', String(percent)) : displayValue(item.value)),
        ),
        h('div', { style: styles.track },
          h('div', { style: { ...styles.fill, width: `${percent}%`, background: toneOf(percent) } }),
        ),
        reset === undefined ? null : h('div', { style: styles.resetLine }, reset),
      )
    }

    function DragIcon() {
      return h('svg', {
        width: 10,
        height: 14,
        viewBox: '0 0 10 14',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M3 3h.01M7 3h.01M3 7h.01M7 7h.01M3 11h.01M7 11h.01' }))
    }

    /** 卡片右上角那只「只刷这一家」的小图标。 */
    function RefreshIcon({ size = 13 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M13.2 6.6A5.3 5.3 0 1 0 13.3 9.6' }),
        h('path', { d: 'M13.5 3.2v3.5H10' }),
      )
    }

    /** 一张供应商卡片：拖拽手柄 + 状态点 + 名称 + 主数值 + 明细。 */
    function ProviderCard({
      entry, compact, t, onRefresh, refreshing, xai,
      dragging, dragOver, onDragStart, onDragEnd, onDragOver, onDrop, onMove,
    }) {
      const result = entry.result ?? {}
      const failing = result.ok === false
      const needsLogin = result.needsLogin === true
      const idle = result.kind === 'none'
      const isGrok = entry.vendor === 'grok'
      const details = Array.isArray(result.details) ? result.details.slice(0, compact ? 2 : 4) : []

      return h('div', {
        'data-provider-id': entry.id,
        style: {
          ...styles.card,
          ...(compact ? styles.cardCompact : {}),
          ...(dragOver ? styles.cardDragOver : {}),
          opacity: dragging ? 0.45 : 1,
        },
        onDragOver: (event) => {
          event.preventDefault()
          onDragOver(entry.id)
        },
        onDrop: (event) => {
          event.preventDefault()
          onDrop(entry.id)
        },
      },
        h('div', { style: styles.cardHead },
          h('button', {
            type: 'button',
            draggable: true,
            title: t('card.reorder'),
            'aria-label': t('card.reorder'),
            style: { ...styles.dragHandle, cursor: dragging ? 'grabbing' : 'grab' },
            onDragStart: (event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', entry.id)
              onDragStart(entry.id)
            },
            onDragEnd,
            onKeyDown: (event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              onMove(entry.id, event.key === 'ArrowUp' ? -1 : 1)
            },
          }, h(DragIcon, {})),
          h('span', {
            style: {
              ...styles.dot,
              background: needsLogin ? TONE.idle : failing ? TONE.bad : idle ? TONE.idle : result.unavailable === true ? TONE.warn : TONE.ok,
            },
          }),
          h('span', { style: styles.cardName }, entry.label),
          typeof result.planType === 'string' && result.planType !== ''
            ? h('span', { style: styles.badge }, result.planType)
            : null,
          entry.vendorSource === 'auto'
            ? h('span', { style: styles.badge }, t('badge.auto'))
            : null,
          h('button', {
            type: 'button',
            title: t('card.refresh'),
            'aria-label': t('card.refresh'),
            disabled: refreshing,
            style: { ...styles.cardRefresh, opacity: refreshing ? 0.35 : 0.55, cursor: refreshing ? 'default' : 'pointer' },
            onClick: () => onRefresh(),
          }, h(RefreshIcon, {})),
        ),

        idle
          ? h('div', { style: styles.hint }, t('hint.disabled'))
          : failing
            ? h('div', { style: needsLogin ? styles.hint : { ...styles.hint, color: TONE.bad } },
              result.error ?? t('error.unknown'))
            : null,

        !failing && !idle
          ? h('div', { style: styles.summaryLine },
            h('span', { style: styles.summary }, money(result.summary, result.currency)),
            result.currency === undefined ? null : h('span', { style: styles.currency }, result.currency),
          )
          : null,

        details.length === 0 || failing || idle
          ? null
          : h('div', { style: styles.metrics }, details.map((item, index) => h(MetricRow, {
            key: `${entry.id}-${item.label}-${index}`,
            item,
            t,
          }))),

        isGrok ? h(XaiAuth, { xai, compact, t }) : null,
      )
    }

    /** 取聚合数据。`force` 走 refresh=1，绕过 Host 侧缓存。 */
    function useSummary() {
      const [state, setState] = useState({ loading: true, providers: [], error: undefined, fetchedAt: undefined })
      const [busy, setBusy] = useState({})

      const load = useCallback(async (force) => {
        setState((prev) => ({ ...prev, loading: true }))
        try {
          const response = await fetch(
            force === true ? `${SUMMARY_ROUTE}?refresh=1` : SUMMARY_ROUTE,
            { headers: { accept: 'application/json' } },
          )
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const summary = await response.json()
          setState({
            loading: false,
            providers: Array.isArray(summary.providers) ? summary.providers : [],
            error: undefined,
            fetchedAt: summary.fetchedAt,
          })
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: String(error?.message ?? error) }))
        }
      }, [])

      useEffect(() => {
        load(false)
      }, [load])

      const refresh = useCallback(() => {
        load(true)
      }, [load])

      /** 只刷一家：Host 端有单家刷新路由，其它卡片的数字不动。 */
      const refreshProvider = useCallback(async (id) => {
        setBusy((prev) => ({ ...prev, [id]: true }))
        try {
          const response = await fetch(REFRESH_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: id }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (payload?.entry !== undefined) {
            setState((prev) => ({
              ...prev,
              providers: prev.providers.map((item) => (item.id === id ? payload.entry : item)),
            }))
          }
        } catch {
          // 老宿主还没有这条路由：退化成整页刷新，别让按钮变成死键
          load(true)
        } finally {
          setBusy((prev) => ({ ...prev, [id]: false }))
        }
      }, [load])

      return { ...state, refresh, refreshProvider, busy }
    }

    /**
     * xAI 登录态：只在列表里确实有 Grok 卡时才轮询（授权中 2 秒，否则 30 秒）。
     * 状态里永远没有令牌，只有登录流程信息与 csrf。
     */
    function useXai(enabled) {
      const [state, setState] = useState({ status: undefined, error: undefined, busy: false })
      const pending = state.status?.loginPending === true

      const load = useCallback(async () => {
        try {
          const response = await fetch(XAI_STATUS_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const status = await response.json()
          setState((prev) => ({ ...prev, status, error: undefined }))
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }))
        }
      }, [])

      useEffect(() => {
        if (!enabled) return undefined
        void load()
        const timer = window.setInterval(() => { void load() }, pending ? 2000 : 30000)
        return () => window.clearInterval(timer)
      }, [enabled, pending, load])

      const act = useCallback(async (route) => {
        setState((prev) => ({ ...prev, busy: true }))
        try {
          const headers = { 'content-type': 'application/json' }
          if (route === XAI_LOGOUT_ROUTE) {
            const csrf = state.status?.csrf
            if (typeof csrf !== 'string' || csrf === '') return
            headers['x-dsh-csrf'] = csrf
          }
          const response = await fetch(route, { method: 'POST', headers, body: '{}' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          await load()
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }))
        } finally {
          setState((prev) => ({ ...prev, busy: false }))
        }
      }, [load, state.status?.csrf])

      return {
        ...state,
        pending,
        login: () => act(XAI_LOGIN_ROUTE),
        logout: () => act(XAI_LOGOUT_ROUTE),
        cancel: () => act(XAI_CANCEL_ROUTE),
        reload: load,
      }
    }

    /** Grok 卡片里的授权区：登录按钮 / 用户码 + 授权页 / 退出。 */
    function XaiAuth({ xai, compact, t }) {
      if (xai === undefined) return null
      const status = xai.status
      const loginState = status?.loginState
      const waiting = status?.loginPending === true || loginState?.status === 'pending'
      const connected = status?.loggedIn === true

      return h('div', { style: styles.authBlock },
        xai.error === undefined ? null : h('div', { style: { ...styles.hint, color: TONE.bad } },
          t('xai.authError', xai.error)),
        status?.loginError === undefined || status?.loginError === null ? null
          : h('div', { style: { ...styles.hint, color: TONE.bad } }, t('xai.loginFailed', status.loginError)),

        waiting && typeof loginState?.userCode === 'string'
          ? h('div', null,
            h('div', { style: styles.codeRow },
              h('span', { style: styles.codeValue }, loginState.userCode),
              h('button', {
                type: 'button',
                style: styles.primaryButton,
                onClick: () => window.open(loginState.verificationUri, 'dsh-xai-verification', 'noopener,noreferrer'),
              }, t('xai.openAuth')),
            ),
            h('div', { style: styles.hint },
              t('xai.codeHint', String(Math.max(1, Math.round((loginState.expiresInSeconds ?? 900) / 60))))),
          )
          : null,

        h('div', { style: styles.authRow },
          connected
            ? h('span', { style: { ...styles.hint, color: TONE.ok } }, t('xai.loggedIn'))
            : h('button', {
              type: 'button',
              style: styles.primaryButton,
              disabled: xai.busy || waiting,
              onClick: () => { void xai.login() },
            }, waiting ? t('xai.pending') : t('xai.login')),
          waiting
            ? h('button', { type: 'button', style: styles.button, onClick: () => { void xai.cancel() } }, t('xai.cancel'))
            : null,
          connected && !compact
            ? h('button', {
              type: 'button',
              style: styles.button,
              disabled: xai.busy,
              onClick: () => { void xai.logout() },
            }, t('xai.logout'))
            : null,
        ),
        connected || waiting ? null : h('div', { style: styles.hint }, t('xai.loginHint')),
      )
    }

    function arrangeProviders(providers, order) {
      if (order.length === 0) return providers
      const positions = new Map(order.map((id, index) => [id, index]))
      return [...providers].sort((a, b) =>
        (positions.get(a.id) ?? positions.size) - (positions.get(b.id) ?? positions.size))
    }

    /** 整页列表：设置区块、整页面板、右侧栏 tab 共用同一个渲染器。 */
    function BalanceList({ t, compact, showHeader, note }) {
      const { loading, providers, error, refresh, refreshProvider, busy, fetchedAt } = useSummary()
      const [order, setOrder] = useState([])
      const [draggedId, setDraggedId] = useState()
      const [dragOverId, setDragOverId] = useState()
      const [orderError, setOrderError] = useState(false)
      const orderWrites = useRef(Promise.resolve())
      const orderedProviders = arrangeProviders(providers, order)

      // Grok 卡需要登录态：授权完成 / 退出登录时整列重查，数字立刻跟着变
      const hasGrok = providers.some((entry) => entry.vendor === 'grok')
      const xai = useXai(hasGrok)
      const xaiLoggedIn = useRef(undefined)
      useEffect(() => {
        const logged = xai.status?.loggedIn
        if ((logged === true && xaiLoggedIn.current === false)
          || (logged === false && xaiLoggedIn.current === true)) refresh()
        xaiLoggedIn.current = logged
      }, [xai.status?.loggedIn, refresh])

      const reorder = (sourceId, targetId) => {
        const ids = orderedProviders.map((entry) => entry.id)
        const from = ids.indexOf(sourceId)
        const to = ids.indexOf(targetId)
        if (from < 0 || to < 0 || from === to) return

        const next = [...ids]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        setOrder(next)
        setOrderError(false)
        orderWrites.current = orderWrites.current.then(async () => {
          try {
            const response = await fetch(ORDER_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ order: next }),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            setOrderError(false)
          } catch {
            setOrderError(true)
          }
        })
      }

      const finishDrag = () => {
        setDraggedId(undefined)
        setDragOverId(undefined)
      }

      const moveProvider = (id, offset) => {
        const ids = orderedProviders.map((entry) => entry.id)
        const target = ids[ids.indexOf(id) + offset]
        if (target !== undefined) reorder(id, target)
      }

      const hasProviders = orderedProviders.length > 0

      return h('div', { style: { ...styles.page, ...(compact ? styles.pageCompact : {}) } },
        showHeader
          ? h('div', { style: styles.header },
            h('div', null,
              h('div', { style: styles.title }, t('title')),
              h('div', { style: styles.subtitle },
                error === undefined
                  ? t('subtitle.count', String(providers.length))
                  : t('subtitle.error', error)),
            ),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: loading,
              onClick: refresh,
            }, loading ? t('action.loading') : t('action.refresh')),
          )
          : null,

        note === undefined || note === '' ? null : h('div', { style: styles.note }, note),
        orderError ? h('div', { style: { ...styles.note, color: TONE.bad } }, t('order.failed')) : null,

        hasProviders ? null : h('div', { style: styles.empty },
          h('div', { style: styles.emptyTitle }, t('empty.title')),
          h('div', { style: styles.emptyBody }, t('empty.body')),
        ),

        orderedProviders.map((entry) => h(ProviderCard, {
          key: entry.id,
          entry,
          compact,
          t,
          refreshing: busy[entry.id] === true,
          xai: entry.vendor === 'grok' ? xai : undefined,
          dragging: draggedId === entry.id,
          dragOver: dragOverId === entry.id && draggedId !== entry.id,
          onRefresh: () => refreshProvider(entry.id),
          onDragStart: (id) => {
            setDraggedId(id)
            setDragOverId(id)
          },
          onDragEnd: finishDrag,
          onDragOver: setDragOverId,
          onDrop: (targetId) => {
            reorder(draggedId, targetId)
            finishDrag()
          },
          onMove: moveProvider,
        })),

        fetchedAt === undefined
          ? null
          : h('div', { style: styles.footNote },
            t('footer.checked', new Date(fetchedAt).toLocaleTimeString())),
      )
    }

    /** 设置页区块：同样是列表，但更宽松，说明文字更全。 */
    function BalanceSettings({ t }) {
      return h('div', { style: styles.settings },
        h('div', { style: styles.settingsIntro }, t('settings.intro')),
        h(ProxySettings, { t }),
        h(BalanceList, { t, compact: false, showHeader: true }),
      )
    }

    //#region 配置模型页：每个供应商卡片里的一行

    /** `/providers` 的结果缓存：同一屏里多个卡片共用一次请求。 */
    let providersCache

    async function loadProviders() {
      if (providersCache !== undefined && Date.now() - providersCache.at < 5_000) return providersCache.list
      try {
        const response = await fetch(PROVIDERS_ROUTE, { headers: { accept: 'application/json' } })
        const payload = response.ok ? await response.json() : { providers: [] }
        const list = Array.isArray(payload.providers) ? payload.providers : []
        providersCache = { at: Date.now(), list }
        return list
      } catch {
        providersCache = { at: Date.now(), list: [] }
        return []
      }
    }

    /** 保存查询方式。`providerId` 是 DSH 配置里 providers 的键名（glm / kimi / …）。 */
    async function saveVendor(providerId, vendor) {
      providersCache = undefined
      try {
        await fetch(VENDOR_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: providerId, vendor }),
        })
      } catch {
        // 写失败不弹窗：下次打开页面会以服务端为准
      }
    }

    /** 代理设置缓存：模型页多个卡片共用，写操作后失效。 */
    let proxyCache

    async function loadProxy() {
      if (proxyCache !== undefined && Date.now() - proxyCache.at < 5_000) return proxyCache.value
      try {
        const response = await fetch(PROXY_ROUTE, { headers: { accept: 'application/json' } })
        const payload = response.ok ? await response.json() : {}
        const value = {
          url: typeof payload.proxy?.url === 'string' ? payload.proxy.url : '',
          providers: payload.proxy?.providers !== null && typeof payload.proxy?.providers === 'object' ? payload.proxy.providers : {},
        }
        proxyCache = { at: Date.now(), value }
        return value
      } catch {
        const value = { url: '', providers: {} }
        proxyCache = { at: Date.now(), value }
        return value
      }
    }

    /** 模型页每个供应商卡片里的「代理」选择：跟随默认 / 直连 / 走代理。 */
    function ProxyPicker({ t, providerId, compact }) {
      const [mode, setMode] = useState('default')
      const [needsUrl, setNeedsUrl] = useState(false)

      useEffect(() => {
        let alive = true
        loadProxy().then((proxy) => {
          if (!alive) return
          const current = proxy.providers[providerId] ?? 'default'
          setMode(current)
          setNeedsUrl(current === 'proxy' && proxy.url === '')
        })
        return () => {
          alive = false
        }
      }, [providerId])

      const onChange = (next) => {
        setMode(next)
        setNeedsUrl(next === 'proxy' && (proxyCache?.value.url ?? '') === '')
        proxyCache = undefined
        fetch(PROXY_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: providerId, mode: next }),
        }).catch(() => {})
      }

      return h('div', { style: compact ? styles.modelRow : styles.modelBlock },
        h('span', { style: styles.modelLabel }, t('proxy.label')),
        h('select', {
          value: mode,
          title: t('proxy.title'),
          style: styles.select,
          onChange: (event) => onChange(event.target.value),
        },
          h('option', { value: 'default' }, t('proxy.default')),
          h('option', { value: 'direct' }, t('proxy.direct')),
          h('option', { value: 'proxy' }, t('proxy.proxy')),
        ),
        needsUrl ? h('span', { style: styles.modelHint }, t('proxy.needUrl')) : null,
      )
    }

    /** 设置 → 余额顶部的代理地址卡片；每家供应商的出口在模型页卡片里选。 */
    function ProxySettings({ t }) {
      const [url, setUrl] = useState('')
      const [loaded, setLoaded] = useState(false)
      const [state, setState] = useState('')

      useEffect(() => {
        loadProxy().then((proxy) => {
          setUrl(proxy.url)
          setLoaded(true)
        })
      }, [])

      const save = async () => {
        try {
          const response = await fetch(PROXY_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
          })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
          setUrl(payload.proxy?.url ?? url)
          proxyCache = undefined
          setState('saved')
        } catch {
          setState('error')
        }
      }

      return h('div', { style: styles.proxyBox },
        h('div', { style: styles.proxyTitle }, t('proxy.settingsTitle')),
        h('div', { style: styles.proxyIntro }, t('proxy.intro')),
        h('div', { style: styles.authRow },
          h('input', {
            value: url,
            placeholder: t('proxy.urlPlaceholder'),
            style: styles.input,
            onChange: (event) => {
              setUrl(event.target.value)
              setState('')
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') void save()
            },
          }),
          h('button', { type: 'button', style: styles.button, disabled: !loaded, onClick: () => { void save() } }, t('proxy.save')),
          state === 'saved' ? h('span', { style: styles.hint }, t('proxy.saved')) : null,
          state === 'error' ? h('span', { style: { ...styles.hint, color: TONE.bad } }, t('proxy.invalid')) : null,
        ),
      )
    }

    /** 一个下拉 + 一行说明，塞进供应商卡片内部。 */
    function VendorPicker({ t, providerId, compact }) {
      const vendors = useVendors()
      const [vendor, setVendor] = useState('auto')
      const [hint, setHint] = useState('')

      useEffect(() => {
        let alive = true
        loadProviders().then((list) => {
          if (!alive) return
          const hit = list.find((item) => item.id === providerId)
          if (hit !== undefined) {
            setVendor(hit.vendor)
            setHint(hit.vendorSource === 'auto' ? t('badge.auto') : '')
          }
        })
        return () => {
          alive = false
        }
      }, [providerId, t])

      const onChange = (next) => {
        setVendor(next)
        setHint(next === 'auto' ? t('badge.auto') : '')
        saveVendor(providerId, next)
      }

      return h('div', { style: compact ? styles.modelRow : styles.modelBlock },
        h('span', { style: styles.modelLabel }, t('model.label')),
        h('select', {
          value: vendor,
          title: t('picker.title'),
          style: styles.select,
          onChange: (event) => onChange(event.target.value),
        }, vendors.map((item) => h('option', { key: item.id, value: item.id }, item.label))),
        hint === '' ? null : h('span', { style: styles.modelHint }, hint),
      )
    }

    //#endregion

    /** 侧边栏图标。`innerRef` 给入口那只挂原生监听用。 */
    function BalanceIcon({ size = 16, innerRef }) {
      return h('svg', {
        ref: innerRef,
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 1.6, y: 2.6, width: 12.8, height: 10.8, rx: 2 }),
        h('path', { d: 'M4.2 6.4h4.2M4.2 9.1h2.6' }),
        h('path', { d: 'M10.4 6.2v3.6M9.2 7.4l1.2-1.2 1.2 1.2' }),
      )
    }

    const inject = ['slots', 'locale']

    /**
     * 包一层插值：宿主的 `t` 只做词条查找，占位符 `{0}` 得自己替换。
     * 拿不到词条时返回 key 本身，至少不会把界面渲染成 undefined。
     */
    function withInterpolation(t) {
      return (key, ...args) => {
        const raw = t(key)
        const text = typeof raw === 'string' ? raw : key
        if (args.length === 0) return text
        return text.replace(/\{(\d+)\}/g, (match, index) => {
          const value = args[Number(index)]
          return value === undefined ? match : String(value)
        })
      }
    }

    function apply(ctx) {
      let t = (key) => key

      // —— 文案 ——
      try {
        const zh = {
          nav: '余额',
          title: '套餐余额',
          'subtitle.count': '{0} 个已配置的供应商',
          'subtitle.error': '读取失败：{0}',
          'action.refresh': '刷新',
          'action.loading': '查询中…',
          'empty.title': '还没有配置模型供应商',
          'empty.body': '先在设置里添加供应商并填好密钥，这里就会按各自的方式查询余额。',
          'hint.disabled': '已设为「不查询」',
          'hint.disabledHint': '在下方选择查询方式后即可显示余额',
          'error.unknown': '查询失败',
          'badge.auto': '自动识别',
          'picker.title': '选择这个供应商的余额查询方式',
          'used.percent': '已用 {0}%',
          'reset.now': '即将重置',
          'reset.minutes': '{0} 分钟后重置',
          'reset.hours': '{0} 小时后重置',
          'reset.at': '{0} 重置',
          'footer.checked': '查询于 {0}',
          'settings.intro': '各家余额与配额窗口。查询方式在「模型」页对应卡片里选，密钥沿用供应商自己的凭据。',
          'drawer.title': '余额',
          'drawer.desc': '各家套餐余额与配额窗口',
          'entry.needSession': '选中一个会话后，再点侧边栏的「余额」，就会直接在这个会话的右侧栏打开；这里是没有会话时的完整列表。',
          'entry.failed': '右侧栏没能接上（{0}），这里先给你完整列表。',
          'model.label': '余额查询',
          'card.refresh': '只刷新这一家的余额',
          'card.reorder': '拖动调整顺序',
          'order.failed': '顺序保存失败，请重试',
          'xai.login': '登录 xAI',
          'xai.logout': '退出登录',
          'xai.pending': '等待授权…',
          'xai.openAuth': '打开授权页',
          'xai.cancel': '取消',
          'xai.codeHint': '在 xAI 官方页面登录并批准（用户码约 {0} 分钟内有效）',
          'xai.loginHint': '用 SuperGrok / X Premium 订阅登录，无需 API Key；登录后 Grok 模型与余额一起可用',
          'xai.loggedIn': '已连接 xAI 订阅',
          'xai.loginFailed': '登录失败：{0}',
          'xai.authError': 'xAI 状态读取失败：{0}',
          'proxy.label': '网络代理',
          'proxy.title': '这个供应商的网络出口：模型 API 请求与余额查询都按此路由',
          'proxy.default': '跟随默认',
          'proxy.direct': '直连（不走代理）',
          'proxy.proxy': '走代理',
          'proxy.needUrl': '先在「设置 → 余额」填写代理地址',
          'proxy.settingsTitle': '代理设置',
          'proxy.intro': '代理地址统一在这里填。每家供应商是否走代理，在「模型」页对应卡片里选，模型请求和余额查询都按这个走。',
          'proxy.urlPlaceholder': 'http://127.0.0.1:7897',
          'proxy.save': '保存代理',
          'proxy.saved': '已保存，立即生效',
          'proxy.invalid': '代理地址只支持 http(s)://',
        }
        const en = {
          nav: 'Balance',
          title: 'Plan balances',
          'subtitle.count': '{0} configured providers',
          'subtitle.error': 'Failed: {0}',
          'action.refresh': 'Refresh',
          'action.loading': 'Checking…',
          'empty.title': 'No model providers configured',
          'empty.body': 'Add a provider with its key in Settings first; balances show up here.',
          'hint.disabled': 'Not queried',
          'hint.disabledHint': 'Pick a query method below to show the balance',
          'error.unknown': 'Query failed',
          'badge.auto': 'auto',
          'picker.title': 'How to query the balance for this provider',
          'used.percent': '{0}% used',
          'reset.now': 'resetting soon',
          'reset.minutes': 'resets in {0}m',
          'reset.hours': 'resets in {0}h',
          'reset.at': 'resets {0}',
          'footer.checked': 'Checked {0}',
          'settings.intro': 'Balances and quota windows per provider. Pick the query method on the provider card under Settings → Models; the provider’s own credentials are reused.',
          'drawer.title': 'Balance',
          'drawer.desc': 'Plan balances and quota windows',
          'entry.needSession': 'Pick a session, then click Balance in the sidebar — it opens in that session’s right sidebar. This page is the full list for when no session is selected.',
          'entry.failed': 'The right sidebar could not be wired up ({0}); here is the full list instead.',
          'model.label': 'Balance query',
          'card.refresh': 'Refresh this provider only',
          'card.reorder': 'Drag to reorder',
          'order.failed': 'Could not save the card order. Please try again.',
          'xai.login': 'Sign in to xAI',
          'xai.logout': 'Sign out',
          'xai.pending': 'Waiting for approval…',
          'xai.openAuth': 'Open authorization page',
          'xai.cancel': 'Cancel',
          'xai.codeHint': 'Approve on the official xAI page (code valid for about {0} minutes)',
          'xai.loginHint': 'Use a SuperGrok / X Premium subscription — no API key. Signing in enables Grok models and this balance card.',
          'xai.loggedIn': 'xAI subscription connected',
          'xai.loginFailed': 'Sign-in failed: {0}',
          'xai.authError': 'Could not read xAI status: {0}',
          'proxy.label': 'Proxy',
          'proxy.title': 'Egress for this provider — applies to model API calls and balance queries',
          'proxy.default': 'Follow default',
          'proxy.direct': 'Direct (no proxy)',
          'proxy.proxy': 'Use proxy',
          'proxy.needUrl': 'Set the proxy URL under Settings → Balance first',
          'proxy.settingsTitle': 'Proxy',
          'proxy.intro': 'Set the proxy URL here. Choose per provider whether to use it under Settings → Models; model calls and balance queries follow that choice.',
          'proxy.urlPlaceholder': 'http://127.0.0.1:7897',
          'proxy.save': 'Save proxy',
          'proxy.saved': 'Saved — effective immediately',
          'proxy.invalid': 'Only http(s):// proxy URLs are supported',
        }
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'balance-panel: 文案')
        t = withInterpolation(ctx.locale.bind(NS))
      } catch (error) {
        console.error('[balance-panel] 文案注册失败，使用内置文案：', error)
      }

      // —— 设置 → 模型：每个供应商卡片里加一行「余额查询方式」——
      //
      // 这个槽是 keyed 的，派发键是「适配器家族的 settingsNs」而不是 provider
      // 路由名。家族名随宿主版本可能变，所以按已知的几个候选各注册一次：
      // 键不匹配时宿主不会渲染我们，也不会报错；匹配上的那个负责显示。
      for (const family of ['llm-pi-ai', 'llm-deepseek', 'llm-anthropic', 'llm-openai']) {
        try {
          ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
            name: 'settings.models.provider-card',
            key: family,
            order: 40,
            locale: NS,
            inject: () => ({ t }),
          }, (props) => {
            // keyed 槽的 owner props 里有 provider 视图；路由名在 provider.provider
            const providerId = props?.provider?.provider ?? props?.provider?.id
            if (typeof providerId !== 'string' || providerId === '') return null
            // 「添加模型」的草稿卡：目录行还没保存任何配置，配余额方式/代理没有意义，
            // 也会让确认区看起来像多出来的表单。已保存的供应商才显示这两项。
            if (props?.configured === false) return null
            return h('div', null,
              h(VendorPicker, { t: props?.t ?? t, providerId, compact: true }),
              h(ProxyPicker, { t: props?.t ?? t, providerId, compact: true }),
            )
          }))
        } catch (error) {
          console.error(`[balance-panel] 模型卡片注册失败（${family}）：`, error)
        }
      }

      // —— 设置页区块 ——
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: PANEL_ID,
          order: 600,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, BalanceSettings))
      } catch (error) {
        console.error('[balance-panel] 设置区块注册失败：', error)
      }

      /**
       * 右侧栏是可选能力：`sidebarRightTabs` / `sidebarRight` 两个服务都在时，
       * 才用两段注册把 tab 类型与身体挂上去（都放在同一个 effect 里，随插件
       * 卸载）。`mounted()` 是宿主面：只有「主视图还是对话且有选中会话」时才
       * 有值，这时 openTab 才有地方落。
       */
      const drawer = {
        ready: false,
        error: undefined,
        mounted: () => undefined,
        open: () => false,
      }

      const installDrawer = (subCtx) => {
        const tabs = subCtx.get('sidebarRightTabs')
        const ctrl = subCtx.get('sidebarRight')
        if (tabs === undefined || typeof tabs.register !== 'function') return
        if (ctrl === undefined || typeof ctrl.openTab !== 'function') return

        try {
          subCtx.effect(() => {
            const offType = tabs.register({
              id: DRAWER_ID,
              kind: DRAWER_KIND,
              keepMounted: true,
              title: () => t('drawer.title'),
              guide: [{
                id: 'overview',
                order: 120,
                title: () => t('drawer.title'),
                description: () => t('drawer.desc'),
                icon: BalanceIcon,
              }],
            })

            const offBody = ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: DRAWER_ID },
              () => h(BalanceList, { t, compact: true, showHeader: true }),
            )

            drawer.ready = true
            drawer.mounted = () => {
              try {
                const store = ctrl.mounted
                return store !== undefined && typeof store.getSnapshot === 'function'
                  ? store.getSnapshot()
                  : undefined
              } catch {
                return undefined
              }
            }
            drawer.open = () => {
              if (drawer.mounted() === undefined) return false
              try {
                ctrl.openTab(DRAWER_KIND)
                return true
              } catch (error) {
                console.error('[balance-panel] 打开右侧栏失败：', error)
                return false
              }
            }

            return () => {
              drawer.ready = false
              drawer.mounted = () => undefined
              drawer.open = () => false
              try { offBody() } catch { /* 已卸载 */ }
              try { offType() } catch { /* 已卸载 */ }
            }
          }, 'balance-panel: 右侧栏 tab')
        } catch (error) {
          drawer.error = String(error?.message ?? error)
          console.error('[balance-panel] 右侧栏注册失败：', error)
        }
      }

      try {
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (subCtx) => {
          installDrawer(subCtx)
        })
      } catch (error) {
        // 宿主没有 ctx.inject / 右侧栏服务：入口退化成整页列表
        drawer.error = String(error?.message ?? error)
      }

      /** 选中的会话 id：`uiWorkspace.selection` 是那份持久化的「当前会话」。 */
      const selectedSessionId = () => {
        try {
          const workspace = ctx.get('uiWorkspace')
          const snapshot = workspace?.selection?.getSnapshot?.()
          return typeof snapshot?.sessionId === 'string' && snapshot.sessionId !== ''
            ? snapshot.sessionId
            : undefined
        } catch {
          return undefined
        }
      }

      /** 主视图切回对话（右侧栏随之重新有会话面）。 */
      const backToConversation = () => {
        try {
          const layout = ctx.get('layout')
          if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
        } catch (error) {
          console.error('[balance-panel] 切回对话失败：', error)
        }
      }

      /** 回到对话后，会话面是下一帧才挂上的：短轮询等到就开 tab。 */
      let openTimer
      const openWhenReady = (attempt = 0) => {
        if (openTimer !== undefined) {
          clearTimeout(openTimer)
          openTimer = undefined
        }
        const tick = (n) => {
          if (drawer.mounted() !== undefined) {
            drawer.open()
            return
          }
          if (n >= 40) return
          openTimer = setTimeout(() => tick(n + 1), 16)
        }
        tick(attempt)
      }

      /**
       * 整页列表。右侧栏可用时它只是兜底 —— 而且一旦发现会话其实还选着，
       * 就把自己让位：回对话、开右侧栏。没人想在对话中途被换到一张独立页面。
       */
      function BalancePane() {
        useEffect(() => {
          if (!drawer.ready) return
          if (selectedSessionId() === undefined) return
          backToConversation()
          openWhenReady()
        }, [])

        return h(BalanceList, {
          t,
          compact: false,
          showHeader: true,
          note: drawer.ready === true
            ? t('entry.needSession')
            : drawer.error === undefined ? undefined : t('entry.failed', drawer.error),
        })
      }

      /**
       * 侧边栏入口。宿主把图标渲染在一个 `<button>` 里，点它默认会把主视图切到
       * 本插件的整页 —— 而那一刀切下去，会话就离开屏幕，右侧栏随之消失。
       *
       * 所以在 capture 阶段先把点击判掉：
       *   · 右侧栏可用、会话就在屏上 → 吃掉点击，直接 openTab，对话一步不动；
       *   · 右侧栏可用、会话还选着但主视图被别的面板占着 → 吃掉点击，先回对话
       *     再开右侧栏（不然就只能给一张独立页面）；
       *   · 没有会话 → 放行，让宿主切到整页列表（这时右侧栏本来就不存在）。
       * 键盘回车/空格派发的 click 也走这里。
       */
      function BalanceNavEntry({ size }) {
        const ref = useRef(null)

        // 不写依赖数组：宿主重建行按钮（换语言、折叠/展开）时重新挂一次，
        // 免得监听留在被换掉的旧节点上。
        useEffect(() => {
          const node = ref.current
          const row = node === null || node === undefined ? null : node.closest('button')
          if (row === null) return undefined

          const onClick = (event) => {
            if (!drawer.ready) return

            if (drawer.mounted() !== undefined) {
              event.preventDefault()
              event.stopPropagation()
              drawer.open()
              return
            }

            // 主视图被别的面板占着：会话还在，就回对话开右侧栏，别换页
            if (selectedSessionId() === undefined) return
            event.preventDefault()
            event.stopPropagation()
            backToConversation()
            openWhenReady()
          }

          row.addEventListener('click', onClick, true)
          return () => row.removeEventListener('click', onClick, true)
        })

        return h(BalanceIcon, { size: size ?? 16, innerRef: ref })
      }

      // —— 侧边栏入口 ——
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => t('nav'),
          locale: NS,
        }, BalanceNavEntry))
      } catch (error) {
        console.error('[balance-panel] 侧边栏入口注册失败：', error)
      }

      // —— 主面板（没有会话可用时才落到这里） ——
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, BalancePane))
      } catch (error) {
        console.error('[balance-panel] 主面板注册失败：', error)
      }
    }

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '18px 20px 24px',
        height: '100%',
        overflowY: 'auto',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
      },
      pageCompact: { padding: '12px 14px 16px', gap: 8 },
      header: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        paddingBottom: 4,
      },
      title: { fontSize: 15, fontWeight: 600 },
      subtitle: { fontSize: 12, opacity: 0.62, marginTop: 2 },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l3)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      cardCompact: { padding: '8px 10px', gap: 5 },
      cardDragOver: {
        borderColor: 'var(--dsw-alias-label-tertiary)',
        boxShadow: '0 0 0 1px var(--dsw-alias-label-tertiary)',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 7 },
      dragHandle: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.55,
        padding: 2,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        flex: '0 0 auto',
      },
      cardRefresh: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        marginLeft: 'auto',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        lineHeight: 1,
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
      cardName: { fontWeight: 600, fontSize: 13 },
      badge: {
        fontSize: 10,
        padding: '1px 5px',
        borderRadius: 4,
        border: '1px solid var(--dsw-alias-border-l2)',
        opacity: 0.7,
      },
      summaryLine: { display: 'flex', alignItems: 'baseline', gap: 6 },
      summary: { fontSize: 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      currency: { fontSize: 11, opacity: 0.55, letterSpacing: '0.02em' },
      metrics: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 },
      metricLine: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 },
      metricBlock: { display: 'flex', flexDirection: 'column', gap: 3 },
      metricHead: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 },
      metricLabel: { opacity: 0.7 },
      metricValue: { fontVariantNumeric: 'tabular-nums' },
      track: {
        height: 4,
        borderRadius: 2,
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
      },
      fill: { height: '100%', borderRadius: 2 },
      resetLine: { fontSize: 11, opacity: 0.55 },
      hint: { fontSize: 12, opacity: 0.7 },
      select: {
        appearance: 'auto',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 5,
        padding: '2px 4px',
        fontSize: 11,
        maxWidth: 190,
      },
      empty: {
        border: '1px dashed var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '18px 16px',
        textAlign: 'center',
      },
      emptyTitle: { fontWeight: 600, marginBottom: 6 },
      emptyBody: { fontSize: 12, opacity: 0.65, lineHeight: 1.6 },
      footNote: { fontSize: 11, opacity: 0.45, textAlign: 'right' },
      settings: { padding: '16px 20px 24px', display: 'flex', flexDirection: 'column', gap: 10 },
      settingsIntro: { fontSize: 12, opacity: 0.66, lineHeight: 1.7, maxWidth: 620 },
      note: {
        fontSize: 12,
        lineHeight: 1.7,
        opacity: 0.75,
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
      },
      modelBlock: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
        paddingTop: 8,
        borderTop: '1px dashed var(--dsw-alias-border-l1)',
      },
      modelRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 0',
      },
      modelLabel: { fontSize: 12, opacity: 0.7, whiteSpace: 'nowrap' },
      modelHint: { fontSize: 11, opacity: 0.45 },
      authBlock: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 4,
        paddingTop: 8,
        borderTop: '1px dashed var(--dsw-alias-border-l1)',
      },
      authRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
      codeRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
      codeValue: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 18,
        fontWeight: 700,
        letterSpacing: 2,
      },
      primaryButton: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      proxyBox: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 720,
      },
      proxyTitle: { fontSize: 13, fontWeight: 600 },
      proxyIntro: { fontSize: 12, opacity: 0.66, lineHeight: 1.7 },
      input: {
        flex: '1 1 260px',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '6px 8px',
        fontSize: 12,
        color: 'inherit',
      },
    }

    exports.name = 'dsh-balance-panel-client'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
