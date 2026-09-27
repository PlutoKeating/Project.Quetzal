# runtime · 运行基座

TypeScript / Node.js 22+。无原生依赖（存储用内置 `node:sqlite`），打包为单文件 `dist/main.cjs`。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元与集成测试（心脏数学、记忆语义、灵魂 git 合并、供应商保存与故障转移） |
| `npm run build` | 类型检查 + esbuild 打包 |
| `npm run dev` | 以 `./.dev` 为家目录直接运行源码 |

运行时依赖只有两个：`ws`（网关）与 `@larksuiteoapi/node-sdk`（飞书长连接、交互卡片、一键创建机器人）。

环境变量：`AMANI_HOME`（家目录，默认 `~/amani`）、`AMANI_ADAPTER`（身体适配器模块路径）。

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，接口见 [../../docs/API.md](../../docs/API.md)。
