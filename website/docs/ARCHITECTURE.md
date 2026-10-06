# website · 架构

## 1. 构建与托管

```mermaid
flowchart LR
  DS["designSystem.ts"] -- gen-tokens --> CSS["tokens.generated.css<br/>CSS 变量 + @theme"]
  CSS --> TW["Tailwind 4"]
  MD["content/docs/{zh,en}/*.md"] -- 构建时读取 --> RR
  I18N["routes/*/i18n.ts"] --> RR["React Router 8<br/>ssr:false + prerender"]
  TW --> RR
  RR --> OUT["build/client/<br/>/, /404, /zh/…, /en/…, *.data, assets/"]
  OUT -- postbuild --> OUT2["+ 404.html + sitemap.xml"]
  OUT2 -- wrangler deploy（Workers Builds） --> CF["Cloudflare Workers 静态资源<br/>quetzal.plutokeating.beer"]
  BR["浏览器"] -- 只读 GitHub 公开 API --> GH["api.github.com/repos/PlutoKeating/Project.Quetzal/releases"]
  CF --> BR
```

- **没有服务端**：账户页的数据由浏览器直接向同步服务读取（§5）。页面全部是静态资源；Worker 脚本 `worker/index.ts` 只接管 `/dl/*` 与 `/api/*`（发布资产与发布接口的镜像、换令牌中转，见 DEVOPS §4），其余路径不经过它。未知路径由 `404.html` 兜底（`not_found_handling: "404-page"`）。
- **预渲染**：`react-router.config.ts` 用 `app/lib/prerender.ts` 列出所有路径（语言 × 页面 + 文档页）。路由 `loader` 在构建时执行，结果写成 `.data` 文件，客户端导航时读取；因此页面不能依赖运行时服务端。
- **语言**：`/` 预渲染为一个只含内联跳转脚本的页面；`/:lang/*` 共用 `routes/layout.tsx`（顶栏、页脚、语言校验）。`<html lang>` 由 `root.tsx` 按路径参数设置。

## 1.1 安全响应头与 CSP

`scripts/postbuild.mjs` 在构建后写两层策略，浏览器同时执行、取交集：

- **`_headers` 的 `/*`**（全站静态资源；`/dl/*`、`/api/*` 由 Worker 响应，不带这些头）：
  - `Content-Security-Policy`：`default-src 'self'`；`script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`（脚本由下面的 `<meta>` 收紧）；`style-src 'self' 'unsafe-inline'`（React 的 style 属性、KaTeX、mermaid）；`img-src 'self' data:`；`font-src 'self' data:`（KaTeX 样式表内嵌字体）；`connect-src 'self' https://sync.quetzal.plutokeating.beer https://api.github.com`；`object-src 'none'`；`frame-ancestors 'none'`；`base-uri 'none'`；`form-action 'self' https://sync.quetzal.plutokeating.beer`。
  - `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Strict-Transport-Security: max-age=31536000; includeSubDomains`、`Permissions-Policy`（摄像头、麦克风、定位、支付、USB 全部关闭）。
  - `/install` 另有 `Content-Type: text/plain` 与 5 分钟缓存。
- **每个 HTML 的 `<meta http-equiv="Content-Security-Policy">`**（紧跟 `<meta charSet>`，先于任何脚本）：`script-src 'self' 'wasm-unsafe-eval'` 加该页每个内联脚本的 `sha256-…`。内联脚本有主题（`THEME_SCRIPT`）、`/` 的语言跳转、`/device` `/account` 的转发（`FORWARD_SCRIPT`），以及 React Router 每页不同的上下文与水合入口，所以只能逐页算；`_headers` 最多 100 条规则、每行 2000 字符，放不下逐页的哈希，才用 `<meta>`。客户端导航不再执行新的内联脚本，第一页的策略一直有效。`'wasm-unsafe-eval'` 给站内搜索 pagefind。

改动内联脚本、加外部资源（新的接口域名、图片来源）时要同步改 `postbuild.mjs` 的策略，并用 `npm run build && npm run preview` 加无头浏览器检查控制台里没有 CSP 报错。

## 2. 设计系统

`app/design-system/designSystem.ts` 是唯一事实源，分为：语义色（深 / 浅两套，键一致）、圆角与描边、阴影与光效（引用色变量，随明暗切换）、透明度、动效时长与曲线、字体与字号、容器宽度与断点、矮窗口阈值。

`scripts/gen-tokens.ts` 生成三段 CSS：`:root` 深色变量；`prefers-color-scheme: light` 与 `[data-theme]` 的覆盖；`@theme inline` 把 Tailwind 的 `--color-*`、`--radius-*`、`--shadow-*`、`--blur-*`、`--ease-*`、`--font-*`、`--text-*`、`--container-*`、`--breakpoint-*` 命名空间先清空（`initial`）再映射到 `--ds-*` 变量。于是 Tailwind 内置调色板与阴影在本项目里不存在，页面只能用语义类名。另有 `short:` 变体对应矮窗口（横屏手机）。

`scripts/lint-tokens.ts` 在构建前扫描 `app/`（设计系统目录除外）。

## 3. 响应式与横竖屏

- 宽度断点来自设计系统（`sm`…`2xl`），高度用 `short:`（`max-height`），方向用 Tailwind 内置的 `portrait:` / `landscape:`。
- 首屏 hero 高度为视口减顶栏（`100dvh - 顶栏`），矮窗口（横屏手机）时取消最小高度并压缩留白；`Section` 统一处理 `short:` 留白。
- 所有间距、字号均为 rem，不写像素。
- 外观：默认跟随系统（`prefers-color-scheme`），顶栏的切换按钮写入 `localStorage` 键 `quetzal.theme` 并设置 `<html data-theme>`；`root.tsx` 内联脚本在首屏前应用，避免闪烁。

## 3.1 首页的示意与「活着」

- **文案原则**：只讲用户一眼能懂、别处没有的东西（自己醒来、身体、灵魂随身、许多身体一个 ta、会长大、你说了算）；协议、算法、参数、文件名一律不上介绍页，放进文档。hero 的标语、英文副标与引言是固定文案，不改。

- **示意图的窄屏规则**：`Frame` 在容器窄于 480px 时把 SVG 文字按比例放大（最多 1.5 倍）补偿缩小，所以**同一行不能左右并排放两段文字**（名字与说明、键与值都上下两行、左对齐），单行文字按放大 1.5 倍后仍须放进画布；文案改长时要在 320 / 360 / 412 宽度下核对。
- **三条带子** `components/figure.tsx` 的 `WakeCompare`（首页「没有定时器」一节与亮点页 03 共用）：Codex / Claude Code 只在你调用时有点；Hermes / OpenClaw 每 30 分钟一个 heartbeat 刻度；Quetzal 是随清醒度起伏的随机醒来点与大段睡眠。对照口径经查证：Hermes 有 cron，OpenClaw 有 heartbeat（默认 30 分钟）与 cron。
- **凭证小字**：`lib/github.ts` 的 `fetchRepoStats` 取星标与最新版本（星标少于 10 时只显示 GitHub）。

- **呼吸光斑** `Breath`：有机形状的柔光，`animate-breath`（亮度 ±8%、5 秒周期）。
- **示例身体** `routes/home/ExampleBody.tsx`：在浏览器里运行 `lib/bodyClock.ts`（与 `runtime/src/heart/model.ts` 相同的双过程模型纯函数）按本地时间推算醒 / 睡、清醒度、睡眠压力，电量与光线是按一天节律构造的示例曲线；明确标注「示例身体 · 模型实时推算」。
- **一天** `routes/home/DayStrip.tsx` + i18n 里的示例条目：时间线按模型节律构造、参考真实身体的典型形态，**不含任何真实设备或个人数据**（公开站点的硬规则）。生物钟的完整曲线作为静态 SVG 放在文档架构页。

## 4. 页面与数据

| 路径 | 内容 | 数据来源 |
|---|---|---|
| `/` | 语言跳转 | 内联脚本 |
| `/:lang` | 首页：hero（slogan 与引言，固定文案；按钮下一行写支持的平台）→ 没有定时器（与 Codex / Hermes / OpenClaw 的一处差别 + 三条 24 小时带子 + 凭证小字）→ 别处没有的（四张卡：身体 · 灵魂 · 许多身体 · 会长大，各链到亮点页对应一节）→ 装在哪（安卓 · Windows · Linux 三张卡，链到下载页对应平台的 `#android` `#windows` `#linux`）→ 此刻（示例身体）→ 一天 → 它有时候不动 → 你说了算（三条）→ 开始 | `routes/home/i18n.ts`；`ExampleBody.tsx`、`DayStrip.tsx` 只用 `lib/bodyClock` 的模型，不含任何真实设备数据 |
| `/:lang/features` | 七个亮点故事（灵魂 · 许多身体 · 没有定时器 · 身体 · 会长大 · 你说了算 · 装在旧手机上；通俗标题 + 示意图 + 要点 + 文档链接，左右交替，锚点即故事 id，首页四张卡链到 `#body` `#soul` `#mesh` `#tools`）与「还有这些」网格 | `routes/features/i18n.ts`；示意图为 `routes/features/illustrations.tsx` 里的内联 SVG（只用语义类，文字走 i18n） |
| `/:lang/docs/*` | 文档教程：侧栏、正文（统一 Markdown 组件）、页内目录 | `content/docs/<lang>/**/*.md`（构建时读取） |

**图表与图片的可读性**（`components/markdown/Mermaid.tsx`、`Lightbox.tsx`）：mermaid 以原始尺寸渲染（`useMaxWidth: false`，字号 16px）；容器窄于 640px 时横向流程图（LR / RL，含子图 direction）自动改为纵向；图比容器宽时，若缩放不低于 0.72 则整体缩放，否则原尺寸横向滚动并提示；每张图与文档里的图片都可点按进入全屏查看（缩放按钮、双向滚动、Esc 关闭）。时序图开启自动换行。架构参考页的总图改用与 README 相同的手绘 SVG（`public/img/architecture.{zh,en}.svg`，由 `scripts/gen-architecture-svg.py` 生成）。
| `/:lang/account` `account/device` `account/consoles` `account/settings` | 账户（像控制台的一组子页面）：概览（agent 与身体、解绑、删除 agent）· 批准设备（输入码、核对指纹与码的生成时间，控制台登录还核对发起方身体的指纹与绑定时间，批准或拒绝）· 控制台登录（吊销）· 账户设置（「管理账号」跳到 PlutoKeating 账号的设置页，改完点「返回」回来、退出、退出所有网页登录、删除账户）；没登录时显示「登录」 | 浏览器调用同步服务的账户接口 `https://sync.quetzal.plutokeating.beer/v1/web/*`（`lib/sync.ts`，见 §5） |
| `/device` `/account` | 不带语言的入口（身体与 App 给出的链接、同步服务跳来的地址）：内联脚本按访客语言转到 `/:lang/account/device` 或 `/:lang/account`，保留查询参数 | `i18n/core.ts` 的 `FORWARD_SCRIPT` |
| `/:lang/download` | 多平台下载：首屏是名字、一句话、平台切换（安卓 · Windows · Linux）、该平台的安装方式（安卓是 APK 按钮；Windows 是 PowerShell 一行命令与按架构的安装包；Linux 是一行 curl 命令）与最新版本一行；下面是发布说明与历史版本（列出 APK 与 Windows 安装包）。平台按地址的 `#android` / `#windows` / `#linux` 选，没有锚点时按访客系统猜；预渲染的 HTML 里是安卓，不跑脚本的旧手机也拿得到 `/dl/latest/android.apk` | 浏览器请求官网的发布接口镜像 `/api/releases`（不另存，刷新即最新；不通时退回直连 GitHub，才用 sessionStorage 缓存），不硬编码版本 |
| `/:lang/about` `terms` `privacy` | 关于 / 条款 / 隐私（共用 `components/Article.tsx` 长文版式） | 各自 `i18n.ts`（分节 + 段落 + 要点） |
| `/404` | 404 页 | — |

## 5. 账户：官网是唯一给人看的前端

同步服务（`sync/`）只提供接口，官方部署配置了 `SYNC_WEB_URL=https://quetzal.plutokeating.beer`：它自带的页面一律跳到这里，身体与 App 给出的绑定链接也指向这里的 `/device`。

- **登录**：「登录」跳到 `https://sync.quetzal.plutokeating.beer/login?return_to=<当前地址>`，经 PlutoKeating 账号（作者的统一账号 `https://id.plutokeating.beer`，同步服务以 OpenID Connect 对接；邮箱、通行密钥或 GitHub 都能登录）回到原页面。账号本身（名字、邮箱、通行密钥、关联 GitHub；没有密码）在账号服务的设置页里管理，地址由 `lib/sync.ts` 的 `accountUrl(返回地址)` 生成。会话是同步服务的 `__Host-` Cookie（HttpOnly、SameSite=Lax）；官网与同步服务同站不同源，`lib/sync.ts` 用 `fetch(…, {credentials: "include"})` 调用 `/v1/web/*`，同步服务只对官网放行 CORS，改动请求是 JSON（必先预检）。官网自己不设 Cookie、不存任何账户数据。
- **退出所有网页登录**：账户设置里的按钮调用 `POST /v1/web/sessions/revoke-all`（body `{}`），吊销这个账户在所有浏览器上的会话（含当前的），不影响身体绑定与控制台登录。
- **批准设备**：`/v1/web/device/lookup` 返回的 `createdAt`（码的生成时间）对所有类型显示；控制台登录另外显示 `bodyFingerprint`（发起方身体的公钥指纹）与 `bodyBoundAt`（它绑定的时间）。旧版同步服务没有这些字段时不显示。
- **预渲染**：账户页预渲染时只有外壳（标题、子导航），水合后才读取登录状态与数据（`routes/account/shell.tsx` 的 `AccountShell` 与 `useLoad`）；`robots: noindex`。
- **子导航高亮**按去掉尾斜杠的路径比较（托管时目录页会补上尾斜杠，`NavLink` 的精确匹配会失效）。
- App 的「控制 → 账户」与这里用同一套接口（经运行基座，控制台登录），见 `sync/docs/PROTOCOL.md` §5。
- **换令牌的中转**：官方同步服务所在的机房连 `github.com` 时通时断，它链接灵魂仓库时直连失败就经官网 Worker 的 `POST /api/oauth/github/token` 转发授权码换令牌的请求（`worker/index.ts`）。只放行 Worker 变量 `OAUTH_CLIENT_IDS`（在 Cloudflare 控制台设置，不入库；没设置就不转发）里的 client_id，只转发到 `github.com/login/oauth/access_token`，不缓存、不记录请求体，不开 CORS。

