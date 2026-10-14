# Agent 内核引擎开发文档

这里专门维护 Quetzal Agent 运行时内核的实现事实、接口边界、验证证据与后续开发记录。2026-10-13 的初始快照记录既有实现；2026-10-14 起在保持兼容的前提下逐步提取独立引擎。

## 当前结论

Quetzal 使用自建的 TypeScript / Node.js 模型与工具循环。真实模型—工具循环已提取到根级 `engine/src/loop.ts`，通用协议在 `engine/src/types.ts`；`runtime/src/mind/brain.ts` 保留宿主编排，由 `runtime/src/main.ts` 装配。动态上下文、结构化记忆策略、PRIME 学习与演化，以及纯分词、评分、摘录和条目 / 片段预算选择已提取到 `engine/src/retrieval.ts` 与 `context.ts`；上下文装配、文件 / 数据库记忆、模型供应商、工具权限、自主调度和多身体协作仍由宿主提供。受限研究运行器独立调用同一循环，不接入生产状态。独立模块的使用与开发见 [engine 模块文档](../../engine/docs/README.md)。

当前上下文按实际模型窗口作统一保守预算、自动摘要与工具节选，长期记忆采用带来源／范围／验证／版本的结构化 Markdown，默认检索采用门禁后有界语义选择。PRIME 蒸馏和候选演化已接生产；个人事实需可信确认，经验启用需独立结果证据，演化缺真实基线时保留候选。旧 Markdown 与 FTS5 继续作为兼容入口。已实现 stdio MCP 工具来源与本机 TUI 第一切片；HTTP MCP、MCP 服务端、远程 TUI 与论文算法实验仍待推进。交互入口是 Flutter 控制台、飞书和经同一网关接入的 CLI 终端聊天。

## 阅读顺序

| 文档 | 记录范围 |
|---|---|
| [独立引擎设计](DESIGN.md) | 目标结构、实际切片、依赖方向与兼容契约 |
| [开发路线图](ROADMAP.md) | 工作分解、依赖顺序、分工、验收与阶段状态 |
| [MCP / TUI 适配计划](ADAPTERS_PLAN.md) | 工具来源和交互客户端的接口、协议与实施切片 |
| [MCP 实现](MCP.md) | stdio 来源、权限、生命周期、配置和平台限制 |
| [策略提取](CONTEXT_EXTRACTION.md) | 纯上下文 / 检索算法的实际迁移与兼容验证 |
| [受限研究运行器](RESEARCH_RUNNER.md) | 独立环境、边界、轨迹、评分及合成示例 |
| [后续切片验证](FOLLOWUP.md) | MCP、TUI、策略与研究运行器的整合证据 |
| [首次提取验证](EXTRACTION.md) | 本次代码变更与验证证据 |
| [模块地图](MODULE_MAP.md) | 内核在哪里、入口与调用链、外围模块边界、依赖与构建 |
| [执行与调度](EXECUTION.md) | 对话、醒来、做梦、工具循环、并发、子 agent、时间墙与停止 |
| [当前替代工程](MEMORY_REPLACEMENT.md) | 生产接线、配置、确认／反馈、验证与边界 |
| [动态上下文](DYNAMIC_CONTEXT.md) | 引擎窗口预算、摘要、原文引用与取消 |
| [结构化记忆](STRUCTURED_MEMORY.md) | 私有持久化、来源校验与生产学习 |
| [PRIME 内核](PRIME_CORE.md) | 资格门禁、语义选择、版本和演化契约 |
| [上下文管理](CONTEXT.md) | 提示词顺序、历史重建、预算、压缩、附件和实际限制 |
| [记忆架构](MEMORY.md) | 分层、持久化、FTS5、记忆写入、整理、同步与一致性 |
| [工具与交互接口](INTERFACES.md) | 模型工具、身体接口、网关、控制台、飞书、MCP / TUI 状态与权限 |
| [基线与验证](BASELINE.md) | 检查版本、执行过的检查、文档差异、未实现能力与未验证范围 |

这些文档相对于仓库根目录引用源码。基线提交与检查环境统一记录在 [BASELINE.md](BASELINE.md)，源码更新后应重新核对相关结论；[BASELINE.md](BASELINE.md) 保留初始快照，最新提取状态见 [EXTRACTION.md](EXTRACTION.md)。

## 维护约定

1. 行为结论同时给出源码路径与函数 / 常数；测试存在、测试本轮通过、真实部署验证是不同证据。
2. 修改执行、上下文、记忆、工具或模型层时，同步更新对应主题文档与验证记录；全局架构保持概览，`runtime/docs/ARCHITECTURE.md` 保持文件地图。
3. 后续方案另写带状态的设计文档；需要改变接口或数据契约时记录决策、迁移与回滚，不能把未实现方案混入现状。
4. 灵魂目录格式与同步契约仍以 [灵魂仓库规范](../SOUL_REPO_SPEC.md) 为准；本目录不另定义一种格式。
5. 只记录通用实现与合成示例，不收录真实人格、记忆、凭据、设备标识或运行数据。运行数据属于仓库外的 `QUETZAL_HOME`。

相关总览：[全局架构](../ARCHITECTURE.md)、[API](../API.md)、[运行时模块地图](../../runtime/docs/ARCHITECTURE.md)、[灵魂同步](../SOUL_SYNC.md)、[分布式设计](../DISTRIBUTED.md)。
