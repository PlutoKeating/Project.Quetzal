# runtime · 运行基座

TypeScript / Node.js 22+。无原生依赖（存储用内置 `node:sqlite`），打包为单文件 `dist/main.cjs`。平台级身体适配器：`adapters/android/`（任意安卓手机，身体能力经 Quetzal App 的本机身体接口提供）打包为 `dist/android.mjs`，随 Quetzal App 内置（App 只装一个，运行环境也在里面，见 `../console/tool/android-runtime/`）；`adapters/termux/`（旧的 Termux 安装：安卓手机 + Termux:API）打包为 `dist/termux.mjs`，保留以兼容；`adapters/linux/`（任意 Linux 电脑或服务器：电池与温度读 `/sys`，通知、播放、截图、剪贴板、相机、录音按可用程序探测）打包为 `dist/linux.mjs`，随 npm 包 `@plutokeating/quetzal`（`../cli`）内置；`adapters/windows/`（任意 Windows 10 1809 起 / 11 电脑：电源、温度、Toast、截图、剪贴板、打开、播放、拍照、录音，常驻一个 PowerShell 5.1 进程执行）打包为 `dist/windows.mjs`，另有用户桌面里的身体助手 `dist/windows-body.mjs` 与守护进程 `dist/windows-supervise.mjs`，随 Windows 安装包（`../cli/windows`）分发。Windows 的命令沙箱库单独打包为 `dist/srt.mjs`（srt-win.exe 由安装包放进 `srt-win\`），Mermaid 兜底渲染器为 `dist/mermaid.mjs`（桌面用，按需加载）。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元与集成测试（心脏数学、记忆语义、灵魂 git 合并、供应商保存与故障转移、保密传递、真实环境模式、自造工具、听觉、网关的加密局域网传输与配对证明、两个适配器的探测逻辑） |
| `npm run build` | 类型检查 + esbuild 打包（`dist/main.cjs`、`dist/android.mjs`、`dist/linux.mjs`、`dist/termux.mjs`） |
| `npm run dev` | 以 `./.dev` 为家目录直接运行源码 |

运行时依赖：`ws`（网关）、`@larksuiteoapi/node-sdk`（飞书长连接、交互卡片、一键创建机器人）、`jpeg-js`（纯 JS 的 JPEG 编解码：手机上没有 ffmpeg / ImageMagick 时也能把大照片缩小后交给模型）、`microsoft-cognitiveservices-speech-sdk`（听觉的流式识别：裸 WebSocket 协议的社区实现都已弃用，官方 SDK 是 Node 下的标准做法，打包后约 1 MB），以及 `@peculiar/asn1-x509` + `@peculiar/asn1-schema`（锁定精确版本，MIT，纯 JS）：网关局域网 HTTPS 的自签名证书（`src/tls.ts`）。Node 有 TLS 却没有生成 X.509 证书的接口，证书的 DER 编码不自己写，用 PeculiarVentures 维护的 ASN.1 结构定义（`@peculiar/x509` 的底层），签名用 `node:crypto`。没用更上层的 `@peculiar/x509`：它依赖 `tsyringe`，要求进程里装全局的 `reflect-metadata` 补丁；`selfsigned` 新版本建立在 `@peculiar/x509` 之上，旧版本基于 `node-forge` 只能生成 RSA。打包后 `main.cjs` 约多 0.4 MB，Node 22+ 与 Termux 的 Node 都只用到 `node:crypto` 的标准 EC 能力。

可选依赖一个：`node-datachannel`（libdatachannel 的 Node 绑定，MPL-2.0，原生模块）——网状层的 WebRTC：ICE 穿透、DTLS 加密、SCTP 可靠传输都是安全敏感、久经考验的标准实现，不自己写。它不打进 `main.cjs`（esbuild `--external`），由安装器按 `tool/mesh-modules.lock.json` 的版本与 sha512 下载核对（`tool/install-mesh-modules.mjs`，安卓与 Linux 共用）；加载不了时网状层关闭，身体之间仍用 git 同步。升级它时同步修改 `package.json` 的 `optionalDependencies` 与锁定文件（哈希取自 registry.npmjs.org 的 `dist.integrity`）。

环境变量：`QUETZAL_HOME`（家目录，默认 Termux `~/quetzal`、其他机器 `~/.quetzal`；Quetzal App 内置时由 App 设为它数据目录下的 `files/home/quetzal`）、`QUETZAL_ADAPTER`（身体适配器模块路径）、`QUETZAL_WEB_DIR`（网页控制台的静态文件目录，缺省为 `main.cjs` 旁边的 `web/`；`src/web.ts` 托管它并提供本机浏览器免配对码登录 `GET /auth/local`）、`QUETZAL_DEV_ORIGINS`（开发时允许领取本机登录令牌的额外页面源，逗号分隔）、`QUETZAL_GATEWAY_HOSTS`（局域网模式下配对接口额外接受的 Host 名，逗号分隔；局域网监听只走 HTTPS，见 [API §1](../../docs/API.md)）、`QUETZAL_SANDBOX=none`（强制不用沙箱，只供排查问题）、`QUETZAL_HIDE_PATHS`（proot 沙箱额外遮住的目录，冒号分隔；Quetzal App 用它遮住自己的私有数据）。

agent 的命令在沙箱里运行（`src/sandbox.ts`）：Linux 用 `bwrap`（bubblewrap）或 Landlock，安卓用 `proot`（Quetzal App 内置；旧的 Termux 安装由安装脚本装）；一种都没有时缺省不执行她的命令，`status.sandbox.kind` 为 `none`。这些程序不是 npm 依赖。对方批准或自己打开「真实环境」（`src/host-mode.ts`）的那个会话里，她的命令不经沙箱，见 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §8.2。

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，接口见 [../../docs/API.md](../../docs/API.md)。
