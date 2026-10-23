# dsh-balance-panel

DeepSeek Harness 插件：为每个已配置的模型供应商选一个「余额查询方式」，在侧边栏点「余额」就能看到各家套餐余额与配额窗口。

余额接口的实现照搬 [one-proxy](https://github.com/) 的 `internal/service/balance.go`（端点、字段、百分比口径都一致），但**不依赖 one-proxy 运行**：插件自己发 HTTP 请求。

## 它长什么样

- **设置 → 模型**：每个供应商卡片里多一行「余额查询」下拉（自动识别 / DeepSeek 余额 / Kimi Coding 套餐 / 智谱 Coding Plan / … / 不查询）。**这是唯一配置查询方式的地方。**
- **设置 → 余额**：全部供应商的余额总览，可拖动卡片调整顺序。
- **侧边栏 → 余额**：点图标直接在右侧栏打开余额 tab，**对话留在原地**、不换页；主视图正被别的面板占着时，也会先回到对话再开。只有确实没有选中会话（新会话页）时才退化成整页列表。
- **DSH 登录了 DeepSeek 账号**时，还会多一张「DeepSeek 账号」卡：充值余额与赠送余额，不用填任何 Key。
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
| Grok (xAI) | — | — | **查不了**：只认 OAuth 登录态，API Key 没有公开接口 |

密钥不新填：插件沿用它自己的 `apiKeyEnv`，先问 DSH 的凭据服务，再回落到同名环境变量。密钥只存在于 Host 进程内，不回传浏览器、不写文件。

**官方登录不需要 Key**：只要 DSH 里登录了 DeepSeek 账号（设置 → 账号），聚合结果里就会自动多一张「DeepSeek 账号」卡。它不走 HTTP 直连，而是调宿主的 `deepseekAccount.getBalance()`，由宿主把本地凭据送到 Platform——插件从头到尾看不到 token。没登录就不出这张卡。改这段要重启 DSH（Host 侧代码）。

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
- **Grok** 只有 OAuth 能查，DSH 里的 API Key 供应商会直接显示原因，不发无谓请求。
- **MiniMax** 的配额响应结构是按 z.ai 的形状解析的，one-proxy 仓库里也没有 fixture；如果它返回别的结构，插件会明确报「结构可能不同」，而不是显示 0。
- **智谱** 优先打 `bigmodel.cn` 根域，失败再试 `open.bigmodel.cn`。
- 不做汇率换算：余额是美元就显示 `$`，是人民币就显示 `¥`。
- 百分比统一按「已用」画进度条；平台只给剩余量的，按 `(上限 − 剩余) / 上限` 反算。

## 开发

```bash
node --test test/adapters.test.mjs test/plugin.test.mjs test/client.test.mjs
```

三个测试文件分别覆盖：适配器解析（注入假 fetch）、宿主路由与顺序持久化（假 ctx + 假 req/res）、前端注册契约与拖拽排序（假 ModuleLoader + 假 React）。
