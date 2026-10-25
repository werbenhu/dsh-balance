# dsh-balance-panel

DSH（DeepSeek Harness）插件。侧边栏点「余额」，看各家模型供应商的余额和配额。Grok 支持网页授权登录和额度查询，代理可以按供应商分开设置。

## 功能

- **余额总览**：金额或配额进度条，带重置倒计时。支持 DeepSeek、Kimi、智谱、Ollama、OpenRouter 等，完整列表见下文。
- **Grok（xAI 订阅）**：设备码网页授权，SuperGrok / X Premium 都能用，不需要 API Key。授权在「设置 → 模型」的 xAI 卡片上完成；余额页只负责显示套餐、周/月额度已用百分比和 Grok Build 等分项。
- **按供应商设代理**：每家可选跟随默认、直连、走代理。模型请求和余额、登录查询走同一条路由。
- **界面入口**：侧边栏「余额」在右侧栏打开；「设置 → 余额」是完整列表；「设置 → 模型」的供应商卡片上选查询方式和代理（未保存的添加草稿里不显示这两项）。

## 安装

已经装在 desktop profile。装到其它 profile：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add link:D:/workspace/dsh-balance   # 开发用 link:，分发用包名或 file: 路径
```

再把 `dsh-balance-panel` 加进该 profile `package.json` 的 `dsh.profile.bundles`，重启 DSH。

## 用法

**看余额**：侧边栏「余额」。卡片右上角的小图标只刷这一家，顶部「刷新」全部重查，拖动手柄可以排序。

**Grok 登录和查额度**：

1. 在「设置 → 模型」里添加 xAI (Grok) 供应商或模型 —— 面板上出现 Grok 卡片靠的是这条配置，插件不会替你新建。xAI 卡片下方就是授权区。
2. 点「登录 xAI」，复制用户码，点「打开授权页」，在 xAI 官方页面登录并批准。
3. 回到「设置 → 模型」，卡片显示已登录；那条 xAI 路由同时接上 OAuth 凭据，模型选择器里能直接选。
4. 侧边栏「余额」只显示结果：套餐（如 SuperGrok）、本周或本月已用百分比、重置时间。没授权时卡片只提示去哪里授权。

令牌存在 `$DSH_HOME/xai-oauth.json`，快过期会自动续期，退出登录在同一张模型卡片上。之前装过 dsh-xai-oauth 的，登录态直接沿用，不用重新授权。

**其它供应商**：在「设置 → 模型」对应卡片上选「余额查询」。默认按 baseURL 自动识别，识别不了就手选。密钥沿用供应商自己的 `apiKeyEnv`，不用重复填。

**代理**：

1. 「设置 → 余额」填代理地址，只支持 http(s)，例如 `http://127.0.0.1:7897`。
2. 「设置 → 模型」每家卡片选「跟随默认 / 直连 / 走代理」。

xAI 选走代理时，`api.x.ai`、`auth.x.ai`、`cli-chat-proxy.grok.com` 会一起走，模型、登录、余额都覆盖。

## 支持的查询方式

DeepSeek（账号和 API 余额）、OpenRouter、Ollama Cloud、Kimi 开放平台、Kimi Coding、z.ai Coding Plan、智谱 BigModel Coding、MiniMax Token Plan、Command Code、SiliconFlow、Novita、阶跃星辰、火山方舟、New API / One API、Sub2API、Grok（xAI 订阅，OAuth）。

Grok 这条只对 OAuth 登录态有效，API Key 没有公开余额接口。

## 配置

一般用不到。查询方式、排序、代理都保存在 `~/.dsh/data/balance-panel/settings.json`，不动 profile。要改缓存时间之类，在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: balance-panel
  config:
    cacheMs: 30000        # 余额结果缓存，毫秒
    timeoutMs: 10000      # 单次查询超时
    xaiAutoProvider: true # 给已配置的 xAI 路由补 baseURL / 登录凭据（不新建供应商）
    xaiPath: ''           # 令牌文件路径，默认 $DSH_HOME/xai-oauth.json
```

## 开发

```bash
pnpm install
pnpm test
```

测试覆盖适配器解析、宿主路由、前端注册、xAI OAuth 和代理分流，全部离线跑。
