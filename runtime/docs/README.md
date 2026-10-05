# runtime · 运行基座

TypeScript / Node.js 22+。无原生依赖（存储用内置 `node:sqlite`），打包为单文件 `dist/main.cjs`。两个平台级身体适配器：`adapters/termux/`（安卓手机，Termux + Termux:API）打包为 `dist/termux.mjs`，随 Quetzal App 内置；`adapters/linux/`（任意 Linux 电脑或服务器：电池与温度读 `/sys`，通知、播放、截图、剪贴板、相机、录音按可用程序探测）打包为 `dist/linux.mjs`，随 npm 包 `@plutokeating/quetzal`（`../cli`）内置。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元与集成测试（心脏数学、记忆语义、灵魂 git 合并、供应商保存与故障转移、保密传递、自造工具、听觉、两个适配器的探测逻辑） |
| `npm run build` | 类型检查 + esbuild 打包（`dist/main.cjs`、`dist/termux.mjs`、`dist/linux.mjs`） |
| `npm run dev` | 以 `./.dev` 为家目录直接运行源码 |

运行时依赖只有四个：`ws`（网关）、`@larksuiteoapi/node-sdk`（飞书长连接、交互卡片、一键创建机器人）、`jpeg-js`（纯 JS 的 JPEG 编解码：手机上没有 ffmpeg / ImageMagick 时也能把大照片缩小后交给模型）与 `microsoft-cognitiveservices-speech-sdk`（听觉的流式识别：裸 WebSocket 协议的社区实现都已弃用，官方 SDK 是 Node 下的标准做法，打包后约 1 MB）。

可选依赖一个：`node-datachannel`（libdatachannel 的 Node 绑定，MPL-2.0，原生模块）——网状层的 WebRTC：ICE 穿透、DTLS 加密、SCTP 可靠传输都是安全敏感、久经考验的标准实现，不自己写。它不打进 `main.cjs`（esbuild `--external`），由安装器按 `tool/mesh-modules.lock.json` 的版本与 sha512 下载核对（`tool/install-mesh-modules.mjs`，安卓与 Linux 共用）；加载不了时网状层关闭，身体之间仍用 git 同步。升级它时同步修改 `package.json` 的 `optionalDependencies` 与锁定文件（哈希取自 registry.npmjs.org 的 `dist.integrity`）。

环境变量：`QUETZAL_HOME`（家目录，默认 Termux `~/quetzal`、其他机器 `~/.quetzal`）、`QUETZAL_ADAPTER`（身体适配器模块路径）、`QUETZAL_WEB_DIR`（网页控制台的静态文件目录，缺省为 `main.cjs` 旁边的 `web/`；`src/web.ts` 托管它并提供本机浏览器免配对码登录 `GET /auth/local`）。

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，接口见 [../../docs/API.md](../../docs/API.md)。
