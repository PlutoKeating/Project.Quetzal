# runtime · 运行基座

TypeScript / Node.js 22+。核心存储用内置 `node:sqlite`，无需额外 SQLite 原生扩展，打包为单文件 `dist/main.cjs`。平台级身体适配器：`adapters/android/`（任意安卓手机，身体能力经 Quetzal App 的本机身体接口提供）打包为 `dist/android.mjs`，随 Quetzal App 内置（App 只装一个，运行环境也在里面，见 `../console/tool/android-runtime/`）；`adapters/termux/`（旧的 Termux 安装：安卓手机 + Termux:API）打包为 `dist/termux.mjs`，保留以兼容；`adapters/linux/`（任意 Linux 电脑或服务器：电池与温度读 `/sys`，通知、播放、截图、剪贴板、相机、录音按可用程序探测）打包为 `dist/linux.mjs`，随 npm 包 `@plutokeating/quetzal`（`../cli`）内置；`adapters/windows/`（任意 Windows 10 1809 起 / 11 电脑：电源、温度、Toast、截图、剪贴板、打开、播放、拍照、录音，常驻一个 PowerShell 5.1 进程执行）打包为 `dist/windows.mjs`，另有用户桌面里的身体助手 `dist/windows-body.mjs` 与守护进程 `dist/windows-supervise.mjs`，随 Windows 安装包（`../cli/windows`）分发。Windows 的命令沙箱库单独打包为 `dist/srt.mjs`（srt-win.exe 由安装包放进 `srt-win\`），Mermaid 兜底渲染器为 `dist/mermaid.mjs`（桌面用，按需加载）。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元与集成测试（心脏、记忆与 FTS5 检索、上下文、会话与子 agent、灵魂 git 合并、模型路由、安全、听觉、网关、网状层与平台适配器；具体范围见 `test/*.test.ts` 及 `../engine/test/*.test.ts`；独立引擎测试见 `../engine/test/*.test.ts`） |
| `npm run build` | engine 独立类型检查 + runtime 类型检查 + esbuild 打包：`dist/main.cjs`、`android.mjs`、`linux.mjs`、`termux.mjs`、`windows.mjs`、`windows-body.mjs`、`windows-supervise.mjs`、`mermaid.mjs`；最后由 `tool/build-srt.mjs` 打包 `dist/srt.mjs` |
| `npm run dev` | 以 `./.dev` 为家目录直接运行源码 |

新增运行时依赖 `@modelcontextprotocol/client`（锁定 2.3.1）：使用官方 MCP 协议与 stdio 传输实现，支持现代 / legacy 协商；没有引入服务端框架或将 SDK 放进 engine。

运行时依赖：`ws`（网关）、`@larksuiteoapi/node-sdk`（飞书长连接、交互卡片、一键创建机器人）、`jpeg-js`（纯 JS 的 JPEG 编解码：手机上没有 ffmpeg / ImageMagick 时也能把大照片缩小后交给模型）、`microsoft-cognitiveservices-speech-sdk`（听觉的流式识别：裸 WebSocket 协议的社区实现都已弃用，官方 SDK 是 Node 下的标准做法，打包后约 1 MB），以及 `@peculiar/asn1-x509` + `@peculiar/asn1-schema`（锁定精确版本，MIT，纯 JS）：网关局域网 HTTPS 的自签名证书（`src/tls.ts`）。Node 有 TLS 却没有生成 X.509 证书的接口，证书的 DER 编码不自己写，用 PeculiarVentures 维护的 ASN.1 结构定义（`@peculiar/x509` 的底层），签名用 `node:crypto`。没用更上层的 `@peculiar/x509`：它依赖 `tsyringe`，要求进程里装全局的 `reflect-metadata` 补丁；`selfsigned` 新版本建立在 `@peculiar/x509` 之上，旧版本基于 `node-forge` 只能生成 RSA。打包后 `main.cjs` 约多 0.4 MB，Node 22+ 与 Termux 的 Node 都只用到 `node:crypto` 的标准 EC 能力。

可选依赖一个：`node-datachannel`（libdatachannel 的 Node 绑定，MPL-2.0，原生模块）——网状层的 WebRTC：ICE 穿透、DTLS 加密、SCTP 可靠传输都是安全敏感、久经考验的标准实现，不自己写。它不打进 `main.cjs`（esbuild `--external`），由安装器按 `tool/mesh-modules.lock.json` 的版本与 sha512 下载核对（`tool/install-mesh-modules.mjs`，安卓与 Linux 共用）；加载不了时网状层关闭，身体之间仍用 git 同步。升级它时同步修改 `package.json` 的 `optionalDependencies` 与锁定文件（哈希取自 registry.npmjs.org 的 `dist.integrity`）。

`package.json` 还声明了 `croner`（提醒的 cron 时刻计算）、`beautiful-mermaid`（`dist/mermaid.mjs` 的 SVG 兜底渲染）与 `@anthropic-ai/sandbox-runtime`（Windows 命令沙箱，单独打包为 `dist/srt.mjs`，核心只在 Windows 上加载）。可选 WebRTC 与 Windows 沙箱的原生组件由安装 / 发布流程提供。依赖与构建产物以 `package.json` 和 `tool/build-srt.mjs` 为准。

执行核心是独立 `../engine/` 的模型与工具循环（`engine/src/loop.ts`），由 `src/mind/brain.ts` 注入宿主能力并调用，上下文组装在 `prompt.ts` 与 `brain.ts` 的 `history()`；记忆使用 Markdown 与 SQLite FTS5。上下文预算按字符分块，当前没有统一 token 预算或本轮自动压缩；`session_compact` 下一轮生效。每日消费预算只减少自主醒来，子 agent 的 `maxSteps` 只写入提示词。`src/mcp/` 已提供 stdio MCP 工具来源，官方客户端 SDK 仅在宿主内使用；没有 MCP 服务端或 HTTP MCP。交互通过控制台、飞书与 CLI 的本机 `chat` / `tui`。MCP 配置、启动授权与隔离限制见 [MCP 文档](../../docs/engine/MCP.md)。详细边界见 [全局架构 §5](../../docs/ARCHITECTURE.md#5-大脑一次醒来)。

环境变量：`QUETZAL_HOME`（家目录，默认 Termux `~/quetzal`、其他机器 `~/.quetzal`；Quetzal App 内置时由 App 设为它数据目录下的 `files/home/quetzal`）、`QUETZAL_ADAPTER`（身体适配器模块路径）、`QUETZAL_WEB_DIR`（网页控制台的静态文件目录，缺省为 `main.cjs` 旁边的 `web/`；`src/web.ts` 托管它并提供本机浏览器免配对码登录 `GET /auth/local`）、`QUETZAL_DEV_ORIGINS`（开发时允许领取本机登录令牌的额外页面源，逗号分隔）、`QUETZAL_GATEWAY_HOSTS`（局域网模式下配对接口额外接受的 Host 名，逗号分隔；局域网监听只走 HTTPS，见 [API §1](../../docs/API.md)）、`QUETZAL_SANDBOX=none`（强制不用沙箱，只供排查问题）、`QUETZAL_HIDE_PATHS`（proot 沙箱额外遮住的目录，冒号分隔；Quetzal App 用它遮住自己的私有数据）。

agent 的命令在沙箱里运行（`src/sandbox.ts`）：Linux 用 `bwrap`（bubblewrap）或 Landlock，安卓用 `proot`（Quetzal App 内置；旧的 Termux 安装由安装脚本装）；一种都没有时缺省不执行她的命令，`status.sandbox.kind` 为 `none`。这些程序不是 npm 依赖。对方批准或自己打开「真实环境」（`src/host-mode.ts`）的那个会话里，她的命令不经沙箱，见 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §8.2。

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，接口见 [../../docs/API.md](../../docs/API.md)。内核专项开发与实现现状见 [../../docs/engine/README.md](../../docs/engine/README.md)，包含上下文、记忆、执行循环、工具接口和基线验证。
