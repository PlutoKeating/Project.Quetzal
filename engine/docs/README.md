# engine · Agent 核心执行引擎

根级 `engine/` 是独立的模型与工具执行模块，不导入 `runtime/`，没有运行时第三方依赖。现阶段包含真实工具循环、模型协议类型、纯上下文 / 检索策略，以及独立环境的受限研究运行器；生产轮次生命周期、上下文组装、供应商实现与记忆存储仍由宿主提供。

运行基座的对话（App / 网关 / 飞书 / 听觉）、自主思考、做梦和子 agent，均经 `runtime/src/mind/brain.ts` 装配本引擎。TUI 或其他宿主可通过同一接口提供模型、工具、上下文和事件处理；本模块本身不实现终端 UI 或 MCP 协议。

| 文件 | 职责 |
|---|---|
| [src/index.ts](../src/index.ts) | 公共入口与类型导出 |
| [src/types.ts](../src/types.ts) | Msg、图片、工具定义/调用、ChatRequest、ChatResult |
| [src/loop.ts](../src/loop.ts) | runTurn、TurnControl、EnginePorts 与结果/记录类型 |
| [src/context.ts](../src/context.ts) / [src/retrieval.ts](../src/retrieval.ts) | 字符预算选择、分词、评分与摘录纯策略 |
| [src/research.ts](../src/research.ts) | 每样本独立环境、有界执行、轨迹及独立评分 |
| [test/boundary.test.ts](../test/boundary.test.ts) | 静态源码依赖图不得越过引擎边界 |
| [test/loop.test.ts](../test/loop.test.ts) | 假模型/工具的独立执行、取消、插话、失败、finish、交接测试 |

## 本地验证与构建

在仓库根目录执行：

```bash
npm test --prefix engine
npm run typecheck --prefix engine
npm run build --prefix engine
```

独立测试只需要 Node.js 22+，不会启动 runtime、读取宿主配置或创建数据库。类型检查与构建复用 `runtime/package-lock.json` 锁定的 TypeScript、esbuild 与 Node 类型，须先按 runtime 既有流程安装开发依赖；engine 不额外安装另一套工具链。

构建生成 `engine/dist/index.mjs` 和 sourcemap（已忽略）；runtime 的现有 esbuild 主入口也直接打包引擎源码，`npm run build` 先执行 engine 类型检查；`runtime` 的 `npm test` 已包含 engine 独立测试，避免常规验证遗漏。`package.json` 的源码导出用于仓库内 Node strip-types 调用；独立产物供使用 JavaScript 的宿主导入。当前模块为私有仓库内模块，尚未配置 npm 发布或声明文件分发。

边界、接口与后续迁移见 [ARCHITECTURE.md](ARCHITECTURE.md)。完整的运行基座行为与已知限制见 [内核现状](../../docs/engine/README.md)。
