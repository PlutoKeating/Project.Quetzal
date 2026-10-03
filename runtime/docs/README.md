# runtime · 运行基座

TypeScript / Node.js 22+。无原生依赖（存储用内置 `node:sqlite`），打包为单文件 `dist/main.cjs`。`adapters/termux/` 是安卓手机（Termux + Termux:API）的身体适配器，打包为 `dist/termux.mjs`，随 Windler App 内置。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元与集成测试（心脏数学、记忆语义、灵魂 git 合并、供应商保存与故障转移、保密传递） |
| `npm run build` | 类型检查 + esbuild 打包（`dist/main.cjs` 与 `dist/termux.mjs`） |
| `npm run dev` | 以 `./.dev` 为家目录直接运行源码 |

运行时依赖只有三个：`ws`（网关）、`@larksuiteoapi/node-sdk`（飞书长连接、交互卡片、一键创建机器人）与 `jpeg-js`（纯 JS 的 JPEG 编解码：手机上没有 ffmpeg / ImageMagick 时也能把大照片缩小后交给模型）。

环境变量：`WINDLER_HOME`（家目录，默认 `~/windler`）、`WINDLER_ADAPTER`（身体适配器模块路径）。

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，接口见 [../../docs/API.md](../../docs/API.md)。
