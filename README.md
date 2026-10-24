# dsh-balance-panel

DeepSeek Harness 插件：为每个已配置的模型供应商选一个「余额查询方式」，在侧边栏点「余额」就能看到各家套餐余额与配额窗口。

**支持 Grok（xAI）订阅的网页授权登录与额度查询**：在面板里用 SuperGrok / X Premium 走设备码授权，无需 API Key；授权后直接查询套餐、周期配额与分项用量，并自动配好可用的 Grok 模型路由。也支持按供应商分流代理（模型请求与额度查询共用）。

余额接口的实现照搬 [one-proxy](https://github.com/) 的 `internal/service/balance.go`（端点、字段、百分比口径都一致），但**不依赖 one-proxy 运行**：插件自己发 HTTP 请求。

## 主要能力

- **Grok 授权登录**：设备码（RFC 8628）网页授权，SuperGrok / X Premium 订阅即可，不需要 xAI API Key；令牌本地加密存放、临近过期自动续期。
- **Grok 额度查询**：显示套餐档位（如 SuperGrok）、周期配额（`WEEKLY` → 本周额度 / `MONTHLY` → 本月额度）的已用百分比、Grok Build / Grok Chat 等产品分项，以及重置倒计时。
- **模型路由自动配置**：通过 DSH 官方配置通道自动补齐 `xai` 供应商（`apiKeyEnv: XAI_OAUTH_TOKEN` 等），Grok 模型即装即用，不需要手改 YAML。
- **按供应商代理**：每家供应商可选「跟随默认 / 直连 / 走代理」，模型 API 与余额、登录查询统一按该路由走。
- **其它供应商余额**：DeepSeek、OpenRouter、Ollama、Kimi、智谱、MiniMax、Command Code、New API 等十余种查询方式，详见[支持的查询方式](#支持的查询方式)。

## 它长什么样

- **设置 → 模型**：每个供应商卡片里多一行「余额查询」下拉（自动识别 / DeepSeek 余额 / Kimi Coding 套餐 / 智谱 Coding Plan / … / 不查询）。**这是唯一配置查询方式的地方。**
- **设置 → 余额**：全部供应商的余额总览，可拖动卡片调整顺序。
- **侧边栏 → 余额**：点图标直接在右侧栏打开余额 tab，**对话留在原地**、不换页；主视图正被别的面板占着时，也会先回到对话再开。只有确实没有选中会话（新会话页）时才退化成整页列表。
- **DSH 登录了 DeepSeek 账号**时，还会多一张「DeepSeek 账号」卡：充值余额与赠送余额，不用填任何 Key。
- **xAI（Grok / X 订阅）直接集成**：Grok 卡片上点「登录 xAI」走设备码授权（SuperGrok / X Premium，无需 API Key），卡片显示套餐、本周/本月已用百分比、Grok Build / 聊天等分项与重置倒计时。登录后令牌自动续期，**Grok 模型路由也会自动配好**（见下节），不需要手工编辑任何配置文件。
- **按供应商的代理分流**：「设置 → 余额」里填一次代理地址，「设置 → 模型」每张供应商卡片上选「跟随默认 / 直连 / 走代理」。**模型 API 请求与余额、OAuth 登录查询都按同一路由走**，例如 xAI 选「走代理」后，模型调用、余额查询、登录续期都会走代理（`api.x.ai`、`auth.x.ai`、`cli-chat-proxy.grok.com` 三个域一起覆盖）。
- 每张卡片：状态灯、主数值（金额或百分比）、明细进度条（≥70% 黄、≥90% 红）、重置倒计时。卡片不再放查询方式下拉；标题行左侧的手柄可拖动排序（也支持上下方向键），右侧的小刷新按钮**只重查这一家**（整页顶部的「刷新」才是全部重查）。

## 安装

插件已装进当前 profile（`~/.dsh/profiles/desktop`），装完**重启 DSH** 生效。手工装到别处：

```bash
cd ~/.dsh/profiles/desktop
# 开发态用 link:（改代码立刻生效）；分发用 file:（拷贝一份，需重装才更新）
pnpm add link:D:/workspace/dsh-balance
```

然后在该目录的 `package.json` 里把 `dsh-balance-panel` 加进 `dsh.profile.bundles`（两处都要有），重启 DSH。插件自己的 `cordis.patch.yml` 只负责 `insert` 那一条，profile 的 `cordis.patch.yml` 不用动。

## 支持的查询方式

| 查询方式 | 端点 | 类型 | 凭据 |
| --- | --- | --- | --- |
| DeepSeek 账号（官方登录） | 宿主 `deepseekAccount` → Platform `/api/v0/users/get_user_summary` | 金额（充值 + 赠送） | **DSH 里已登录的账号**，不需要 Key |
| DeepSeek 余额 | `api.deepseek.com/user/balance` | 金额 | 普通 API Key |
| OpenRouter 额度 | `openrouter.ai/api/v1/credits` | 金额（剩余 = 总额 − 已用） | API Key |
| Ollama Cloud | `ollama.com/api/balance` | 金额 + 窗口 | API Key |
| Kimi 开放平台（按量） | `{origin}/v1/users/me/balance` | 金额 | API Key |
| Kimi Coding 套餐 | `api.kimi.com/coding/v1/usages` | 5 小时 / 每周窗口 | 订阅后的 Key |
| z.ai Coding Plan | `api.z.ai/api/monitor/usage/quota/limit` | 订阅限额 | 订阅后的 Key |
| 智谱 BigModel Coding Plan | `bigmodel.cn/api/monitor/usage/quota/limit` | 订阅限额 | 订阅后的 Key |
| MiniMax Token Plan | `api.minimax.io/v1/api/openplatform/coding_plan/remains` | 订阅限额 | 订阅后的 Key |
| Command Code | `api.commandcode.ai/alpha/billing/credits` | credits + 5 小时 / 每周窗口 | API Key |
| SiliconFlow / Novita / 阶跃星辰 / 火山方舟 | 各家 `/v1/user/info` 等 | 金额 | API Key |
| New API / One API 网关 | `/api/user/self` 的 `quota`（÷ 500000） | 金额 | 网关令牌 |
| Sub2API 网关 | `/v1/usage` 的 `balance` | 金额 | 网关令牌 |
| Grok (xAI 订阅) | `cli-chat-proxy.grok.com/v1/billing?format=credits` + `/v1/settings` + `api.x.ai/v1/me` | 套餐 + 周期配额 + 产品分项 | **面板内 OAuth 登录**（API Key 没有公开接口） |

密钥不新填：插件沿用它自己的 `apiKeyEnv`，先问 DSH 的凭据服务，再回落到同名环境变量。密钥只存在于 Host 进程内，不回传浏览器、不写文件。

**官方登录不需要 Key**：只要 DSH 里登录了 DeepSeek 账号（设置 → 账号），聚合结果里就会自动多一张「DeepSeek 账号」卡。它不走 HTTP 直连，而是调宿主的 `deepseekAccount.getBalance()`，由宿主把本地凭据送到 Platform——插件从头到尾看不到 token。没登录就不出这张卡。改这段要重启 DSH（Host 侧代码）。

## xAI：登录、余额与免手工配置的模型路由

- **登录（网页授权）**：Grok 卡片 →「登录 xAI」→ 复制用户码 →「打开授权页」在 xAI 官方页面登录并批准。授权完成后卡片自动出数，模型选择器里的 **xAI (Grok)** 也立即可用；同一卡片上还有「退出登录」，退出后回到未授权状态，可重新走一遍。
- **额度查询**：读取 Grok CLI 的计费接口（`cli-chat-proxy.grok.com/v1/billing?format=credits`、`/v1/settings`、`api.x.ai/v1/me`），卡片展示：
  - 套餐档位（如 `SuperGrok`）；
  - 周期配额：`WEEKLY` 显示「本周额度」、`MONTHLY` 显示「本月额度」，主数值是**已用百分比**，附重置倒计时；
  - 产品分项：Grok Build、Grok 聊天等各自的使用百分比；
  - 按需计费与预付余额（接口有就显示）。
  卡片右上角小刷新只重查这一家；平台不披露百分比时会明说，而不是显示 0。API Key 形态没有公开的余额接口，因此这条查询只对 OAuth 登录态生效。
- **令牌**：与 dsh-xai-oauth 共用 `$DSH_HOME/xai-oauth.json`（0600），所以**之前装过 dsh-xai-oauth 并登录过的用户无需重新授权**；把旧插件从 profile 的 `bundles` 里移除后重启即可（它占用的 1457 端口随之释放，本插件不再单开端口，全部走 `/api/dsh-balance-panel/xai/*` 同源路由）。令牌只在 Host 侧，浏览器只能看到登录态；退出登录有 CSRF 校验。
- **自动续期**：距过期不足 5 分钟用 refresh token 续期，并重新写入 DSH 凭据 `XAI_OAUTH_TOKEN`，模型请求与余额查询都读最新值。
- **自动模型路由**：插件通过 DSH 官方 `configEditor`（和「设置 → 模型」页同一条写入路径）确保 `llm-pi-ai` 里存在 xai 路由：`apiKeyEnv: XAI_OAUTH_TOKEN`、`api: openai-responses`、`baseURL: https://api.x.ai/v1`。字段齐了就不再写；你已有的 `models` 等自定义内容原样保留；没写 `models` 时使用宿主内置目录里的全部 Grok 模型。**不需要、也不应该再手工往 `cordis.patch.yml` 里补 xai 配置**（手工覆盖反而可能把插件合并的字段顶掉）。
- **退出登录**：删除本地令牌文件并撤回凭据；Grok 卡片回到「登录 xAI」状态，模型路由因没有凭据而不可用，重新登录即可恢复。

## 按供应商的代理分流

- **代理地址**：设置 → 余额 →「代理设置」，只支持 `http(s)://`（例如 `http://127.0.0.1:7897`），保存立即生效，不用重启。
- **每家是否使用**：设置 → 模型 → 对应供应商卡片上的「网络代理」下拉：
  - **跟随默认**：不干预，保持 DSH 原有行为（包括它按 `HTTPS_PROXY` 等环境变量安装的策略）；
  - **直连**：这个供应商强制不走任何代理，连环境代理也绕过；
  - **走代理**：这个供应商强制走上面填的地址。没填地址时该选项不生效，卡片会提示先去填。
- **覆盖范围**：模型 API 请求、余额查询、xAI 的设备码登录与令牌续期都走同一路由。xAI 的三个域（`api.x.ai` / `auth.x.ai` / `cli-chat-proxy.grok.com`）作为一个整体跟随 xai 供应商的选择，不会出现「模型通了但余额还是失败」。
- **实现**：在 undici 全局 dispatcher 上按 origin 分流；默认流量原样转交 DSH 原来的 dispatcher，没有任何非默认规则时完全不触碰全局网络。设置保存在 `~/.dsh/data/balance-panel/settings.json`，不写 profile。

## 配置

写在 profile 的 `cordis.patch.yml`，按同 id 覆盖：

```yaml
- id: balance-panel
  config:
    cacheMs: 30000        # 服务端结果缓存（0 表示每次都查）
    timeoutMs: 10000      # 单次查询超时
    vendors:              # 按供应商名固定查询方式，优先级低于界面里的选择
      glm: zai-coding
      kimi: kimi-coding
    disabled: [grok]      # 不查询，但仍在列表里显示
    xaiAutoProvider: true # 自动配置 xAI 模型路由（默认 true）
    xaiPath: ''           # xAI 令牌文件路径，默认 $DSH_HOME/xai-oauth.json
```

界面上的下拉选择与卡片顺序保存在 `~/.dsh/data/balance-panel/settings.json`，不会改你的 profile。

## 与 one-proxy 的差别

| | one-proxy | 本插件 |
| --- | --- | --- |
| 余额来源 | 自家 `balance.go` | 同一套端点与解析规则，JS 重写 |
| 多账号 | 一家可挂多个账户、主备/权重、自动切换 | 只读展示，不代理流量、不换号 |
| 运行依赖 | 桌面程序常开 | 无，DSH 装了就独立工作 |
| 币种 | 按平台原样 | 同样原样，不换算汇率 |

想要「一个入口 + 多账户自动切换」，正确做法是把 DSH 的 provider 指向 one-proxy 的兼容地址（`http://127.0.0.1:8280/<渠道ID>`），本插件只负责把余额看清楚。

## 已知限制

- **右侧栏是「按会话」的**：DSH 只在主视图还是对话、且选中了会话时才对插件暴露会话面。所以「余额」入口在有会话时拦截点击、直接开右侧栏 tab；没有选中会话（新会话页）时，右侧栏根本不存在，点入口会落到整页列表——这是宿主的结构，不是插件的开关。
- **Grok** 只有 OAuth 订阅令牌能查，API Key 没有公开余额接口；网络需要能访问 `auth.x.ai`、`api.x.ai` 与 `cli-chat-proxy.grok.com`（直连被断时请在系统/宿主里配置代理，报 `fetch failed` 多半是网络而不是登录态）。
- **MiniMax** 的配额响应结构是按 z.ai 的形状解析的，one-proxy 仓库里也没有 fixture；如果它返回别的结构，插件会明确报「结构可能不同」，而不是显示 0。
- **智谱** 优先打 `bigmodel.cn` 根域，失败再试 `open.bigmodel.cn`。
- 不做汇率换算：余额是美元就显示 `$`，是人民币就显示 `¥`。
- **代理只支持 HTTP(S) 代理**，不支持 SOCKS / PAC，也不读取 Windows 系统代理开关；需要走代理的供应商请在面板里显式选择。
- 百分比统一按「已用」画进度条；平台只给剩余量的，按 `(上限 − 剩余) / 上限` 反算。

## 开发

```bash
npm test
```

五个测试文件分别覆盖：适配器解析（注入假 fetch）、宿主路由与顺序持久化（假 ctx + 假 req/res）、前端注册契约与拖拽排序（假 ModuleLoader + 假 React）、xAI OAuth 流程 / 用量查询 / 模型路由自动配置（临时目录 + 假 fetch，不碰真实凭据）、代理分流（本地目标服务器 + 本地假代理验证真实路由，清空规则后恢复原 dispatcher）。
