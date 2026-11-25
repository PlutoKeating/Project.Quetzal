# `surfaces/web` — 羽蛇神纯原生三态 Web 客户端

TypeScript（`strict: true` / `noUncheckedIndexedAccess: true`）实现的零框架浏览器客户端：
原生 DOM + 极小的内部渲染器（`src/render/dom.ts`），ES modules，无 WebView、无 UI 框架、
无第三方字体 / 分析 / CDN 依赖。所有交互都在同源（`http://127.0.0.1:<port>`）完成，
静态资源由本机 `quetzalcoatld` 直接托管。

## 构建与测试

```bash
npm --prefix surfaces/web ci          # 安装锁定的开发依赖
npm --prefix surfaces/web run build   # → surfaces/web/dist（index.html + assets/*）
npm --prefix surfaces/web test        # typecheck + vitest + Playwright（含真实守护进程）
```

- `npm run build`：esbuild 打包 `src/main.ts`、`src/worker/wasm_cache_worker.ts` 与
  `src/styles/app.css`，产出纯静态资源；`dist/` 与 `node_modules/` 均不入库。
- `npm run test:unit`：vitest + jsdom，覆盖补丁幂等/删除、密度持久化、双 `aria-live`
  通道去重与整句刷写、320px/200% 布局不变量（断言 CSS 令牌与 `min-height`）、
  离线繁忙态、引导记忆、产物提交状态与降级矩阵。
- `npm run test:e2e`：Playwright + 缓存中的 Chromium，不使用下载。
  `e2e/global-setup.ts` 会：
  1. 构建 `dist`；
  2. 若 `target/debug/quetzalcoatld` 不存在则现场 `cargo build`（可用
     `QUETZALCOATL_DAEMON_BIN` 指定已有二进制）；
  3. 以临时 `QUETZALCOATL_HOME` + `QUETZALCOATL_WEB_DIR=surfaces/web/dist`
     启动**真实** `quetzalcoatld`，等 `/health` 就绪后运行浏览器验收。
  真实守护进程无法启动时测试**直接失败**（绝不 skip）。

## `quetzalcoatld` 同源托管

守护进程在**不额外开端口**的前提下，把本地回环 IPC 端口同时用作 Web 控制台入口：

| 配置 | 行为 |
| --- | --- |
| `QUETZALCOATL_WEB_DIR=<dir>` | 托管 `<dir>` 下的静态资源 |
| `quetzalcoatld --web-dir <dir>` | 同上（显式 CLI 优先于默认探测） |
| 可执行文件旁存在 `web/` 目录 | 自动托管（`target/release/web` 等） |
| 以上皆无 | 只保留 `/health`；静态、`/auth/local`、`/rpc` 全部 404，IPC 不受影响 |

**显式配置 web 根后**，所有非 `/v1/*` 路径由 Web 控制台处理，并复用本地 IPC 的严格
回环 `Host`/`Origin` 校验（拒绝 DNS 重绑定与跨源页面）；未配置时仅 `/health` 存活，
包括 WebSocket upgrade 在内的其余路径一律 `404`：

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/`、`/assets/*` | GET/HEAD | 静态资源；无扩展名的深链回退 `index.html`；拒绝 `%`、`..`、点文件与逃逸根目录的符号链接；HEAD 无响应体 |
| `/health` | GET/HEAD | `{"status":"ok","version":"...","web":true}`，零令牌 |
| `/auth/local` | POST | **只有同源浏览器页面**可获取 256-bit 会话令牌：缺失 `Origin`（curl）或与 `Host` 不一致一律 `403`；非浏览器本机客户端请走既有 gateway/admin IPC |
| `/rpc/snapshot` | GET | `Authorization: Bearer <token>` → 完整 `ViewState` 快照 |
| `/rpc` | POST | `Authorization: Bearer <token>` + `IpcRequest` JSON（HTTP 兜底），仅白名单方法 |
| `/rpc` | WebSocket | `Upgrade: websocket`；首帧 `{"auth":"<token>"}` 认证后进入 RPC |

**Web 只读方法白名单**：`status`、`agents`、`chat`、`web_commit_artifact`
（`chat` 的 `workspace_dir`/`verifier_dag`/`peer_id`/`router_attempted_forbidden_tools`
在服务端强制清空）。其余方法（`export`、`import_v1`、`fabric_*`、`group_*`、
`channel_*`、`shutdown`、`set_permission`、`self_update`、`secrets`、未知方法……）即使
持有有效令牌也返回 `403 PERMISSION_DENIED`；WS 返回同 code 的 typed error 帧。
Web 会话令牌**不是**管理员主令牌，不能用于 `/v1/rpc`。

**连接策略**：一个会话令牌只绑定**一条** WebSocket 连接（第二条 → close `4409`
`SESSION_IN_USE`，连接关闭即销毁）；并发 WebSocket 上限 32，第 33 条握手收到
`503 too_many_connections`。

WebSocket 帧（服务端 → 客户端）：

```jsonc
{"type":"ready","transport":"websocket"}
{"type":"snapshot","state":{"rev":1,"density":"workbench","rows":{...}}}
{"type":"patch","patch":{"from_rev":1,"to_rev":2,"density":"workbench","ops":[...]}}}
{"type":"token","messageId":"...","seq":0,"text":"..."}   // 只进 aria-live="polite"
{"type":"tool"|"approval"|"error","id":"...","title":"...","detail":"..."} // 只进 assertive
{"type":"response","id":7,"response":{"kind":"status","data":{...}}}
```

真实守护进程的快照额外包含：`conscience/{root,operator,self_core,memory}/<id>`
（仅层级/标题/披露标志，**绝不下发受保护正文**）、`artifact/md/<name>`（脊柱
Markdown 产物）、`artifact/run/<id>`（物化 Run）与 `session/active`（个人/群组会话）。
Workbench 的「提交」经 `web_commit_artifact` 调用真实 `GroupSend` 路径；会话为个人时
按钮禁用并显示原因。

`/auth/local` 每次签发独立会话令牌（12 小时 TTL、内存驻留、最多 256 个），
**绝不回传**管理员 IPC 主令牌；会话令牌与单条 WS 连接绑定且关闭即销毁；
旧 `/v1/rpc` + `x-qz-ipc-token` 通道完全不受影响。
CSP 统一为 `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; ...`（`wasm-unsafe-eval`
只放行 WebAssembly 编译，不开放 JS `eval`），并附加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。

## 三档认知密度

| 密度 | 目标 | 披露层级 | 关键行为 |
| --- | --- | --- | --- |
| Companion | 长辈 / 随身 | 仅 `summary` | 10 秒三步零术语引导（可跳过并记忆）、`--tap-target: 64px`、纯自然语言 |
| Workbench | 桌面工作 | `summary + detail` | 真实脊柱产物卡片、复制引用、本地提交清单；群组会话可「提交」，个人会话显示禁用原因 |
| Inspector | 工程 / 审计 | `summary + detail + raw_json` | 全部状态行、良知树、原始 JSON 快照 |

- 切换即时（同步重渲染）并写入 `localStorage["qz.web.density"]`；Web 端首次打开为
  Companion（10 秒零术语引导），非法持久化值回退 Companion 而不是崩溃。
- 键盘：`Alt+1/2/3` 任意位置切换；切换后焦点落到新视图 `<h1 tabindex="-1">`，
  并在礼貌通道播报「已切换到…视图」。`aria-pressed` 标记当前密度。
- 状态与消息在切换间完整保留；`ViewPatch` 只在服务端修订号上推进，密度切换不污染修订序列。

## 无障碍（a11y）

- **双通道播报**：`#qz-live-polite`（`role="status"`、`aria-live="polite"`）只接收流式正文，
  按 `messageId#seq` 去重，并按句读标点或 250ms 空闲整句刷写（避免逐 token 结巴），
  保留 240 字符滑动窗口；`#qz-live-assertive`
  （`role="alert"`、`aria-live="assertive"`）只接收工具、审批与错误事件，按事件 id 去重。
  同一 token 文本在任何情况下都不会同时进入两个通道（单测逐 token 双向断言）。
- 可聚焦的按钮均有 ≥64pt 的 `min-height`；审批卡片提供「允许 / 暂不允许」键盘可聚焦按钮。
- 320px 视口 + 200% 字号：无横向溢出、无文本裁切（`overflow-wrap: anywhere`，
  正文/容器无固定像素宽高），主按钮完整落在视口内且高度 ≥64pt（Playwright 断言）。
  密度切换、流式事件重渲染都会恢复标题焦点，键盘用户不会因事件刷新丢焦点。
- 正文区域不设 `aria-live`，避免与两个播报通道重复朗读。

## 降级矩阵（绝不白屏、绝不伪装）

| 情形 | 检测 | 表现 |
| --- | --- | --- |
| 守护进程未运行 | `POST /auth/local` 失败 → `DaemonUnavailable` | 先显示「正在连接…」（不闪错），失败后 Companion 外壳 + 「本机守护进程未运行」面板、输入禁用、移除 `aria-busy` 后用 `role="alert"` 播报、可重试 |
| WebSocket 不可用 | 握手异常 / 超时 / 关闭 | 自动回退 `POST /rpc`，徽标显示「HTTP 回退」，消息仍可发送 |
| 补丁序裂 | `from_rev !== 本地 rev` | 显式 `PatchSequenceError` + assertive 播报 + 请求 `{"type":"resync"}` 重发快照 |
| 无 WASM 产物 | Worker `HEAD /wasm/quetzalcoatl_wasm_bg.wasm` 非 2xx | `degraded: "no-wasm"`，改用内存缓存，徽标明示「刷新后草稿丢失」 |
| WASM 初始化失败 | glue/OPFS/Web Lock 异常 | `degraded: "wasm-error"`，内存缓存，保留可诊断详情 |
| 会话重复连接 | 同一令牌第二条 WS | close `4409 SESSION_IN_USE`，页面重新认证后可恢复 |
| Web 连接过多 | 并发 > 32 | 握手 `503 too_many_connections`（typed JSON） |
| Worker 不可用 | `Worker` 缺失 / 初始化超时 | `degraded: "worker-unavailable"`，内存缓存 |
| `localStorage` 被禁用 | 读写抛异常 | 密度仍在内存内即时切换，不影响任何功能 |

## 可选 WASM OPFS 单写者缓存

默认 `npm run build` **不**包含 WASM（因此降级路径是确定性的、可测试的）。
如需启用 OPFS 单写者缓存：

```bash
scripts/build-web-wasm.sh            # wasm-bindgen 0.2.130 + wasm32 target（缺失时退出码 77）
QZ_WEB_WITH_WASM=1 npm --prefix surfaces/web run build
```

`wasm_cache_worker.ts` 在 `dist/wasm/` 存在时动态加载 glue 并调用 `OpfsSpine.open()`；
每次写入前由 Rust 侧通过 `navigator.locks`（独占、`ifAvailable`）获取写者租约，
取不到即 fail-fast，绝不做无锁写入。WASM 缺失时 Worker 上报 `degraded: "no-wasm"`，
主线程回退内存缓存——这条降级路径由单测与 Playwright 持续验证。

## 目录

```
surfaces/web/
├── src/
│   ├── app.ts                 # 三档壳层、状态机接线、焦点/快捷键/引导与产物提交
│   ├── model/{state,density}.ts
│   ├── transport/{client,protocol}.ts
│   ├── cache/{wasm_cache,worker_cache}.ts
│   ├── worker/{wasm_cache_core,wasm_cache_worker}.ts
│   ├── a11y/live_regions.ts
│   ├── render/dom.ts
│   └── tiers/{companion,workbench,inspector}/view.ts
├── tests/                     # vitest（jsdom）
├── e2e/                       # Playwright（mock + 真实 quetzalcoatld）
├── build.mjs
├── index.html
└── playwright.config.ts
```
