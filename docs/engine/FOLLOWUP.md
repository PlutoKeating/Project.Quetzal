# 后续开发切片与整合验证

日期：2026-10-14。基于首次引擎提取后的 `2998bda` 继续实施，遵循避免大范围重构的要求。此前历史快照见 [BASELINE](BASELINE.md) 和 [首次提取](EXTRACTION.md)，本页记录新增实现及其验证范围。

## 已实施范围

| 切片 | 实际变化 | 宿主边界 |
|---|---|---|
| 上下文 / 检索纯策略 | engine 提供分词、评分、摘录、常驻条目选择和召回片段预算；runtime 原路径保留包装 | 文件、日记时间转换、SQLite FTS5、写锁和灵魂同步留在 runtime；不改变默认检索和字符预算 |
| 受限研究运行器 | `runResearchGroup` 真实调用同一执行循环；每样本独立环境、限制、轨迹、版本 metadata 与独立评分 | 不加载生产 runtime 或真实灵魂；不自动执行外部工具，不改变线上执行预算 |
| MCP stdio | 官方客户端 SDK、配置、协商、发现、稳定别名、输入 / 输出边界、审批、取消与生命周期 | SDK 只在 runtime；沿用工具权限、脱敏、审计及灵魂触碰同步；配置在仓库外 |
| 本机 TUI | `quetzal chat` / `quetzal tui` 经现有回环网关使用同一个 Agent，支持会话、流式过程、审批、停止与恢复 | 不启动第二份引擎；不改网关协议；终端拒绝保密值并引导控制台 |

没有整体搬迁 mind、memory、providers、heart 或 mesh。新增依赖仅为宿主 MCP 官方客户端及锁定的传递依赖；engine 和 TUI 无新增运行时依赖。CI 增加 CLI 路径触发及独立 Linux / Windows 测试与类型检查任务，现有 runtime 构建仍检查 engine。

模块用法见 [engine](../../engine/docs/README.md)、[策略提取](CONTEXT_EXTRACTION.md)、[研究运行器](RESEARCH_RUNNER.md)、[MCP](MCP.md) 和 [TUI](../../cli/docs/TUI.md)。

本地实现提交：`f9ce84f`（策略与研究运行器）、`6a22eda`（MCP）、`4d2ffc0`（TUI 与 CI）；无远程推送。

## 实际验证

当前环境为 Linux / Node.js 24.16.0。以下均为本地验证，不代表远程 CI 或真实设备验收。

| 检查 | 结果 |
|---|---|
| `npm test --prefix engine` | 32 / 32 通过：原执行语义、纯策略及研究限制 |
| `npm run typecheck --prefix engine`、engine 构建 | 通过；独立产物导入与合成示例检查通过 |
| 策略行为对照 | 100 组合成输入与旧实现逐值一致；相关 runtime 检索 / 上下文测试通过 |
| `npm run research:demo --prefix engine` | 2 个成功、1 个故意失败，6 次合成模型调用、3 次工具调用、18 个报告 tokens；不是论文实验收益 |
| MCP 专项 | 6 / 6 通过，含 modern / legacy 实际协商、生产权限 / 急停 / 脱敏与临时 CJS 产物实际调用 |
| TUI 专项 | 13 / 13 通过，含认证、恢复、发送竞态、输入排队保护和跨会话生命周期 |
| CLI 全量 `npm test` | 47 项：45 通过、2 因缺 PowerShell 跳过、0 失败 |
| CLI 类型检查与打包 | 通过；完整 CLI 构建使用 `QUETZAL_NO_WEB=1`，未构建 Flutter Web，产物已忽略且不能作为完整发布包 |
| runtime 类型检查与完整构建 | 通过；原发布产物布局保留，main.cjs 约 9.1 MB，SDK 增加了打包体积 |
| runtime 全量 `npm test`（含 engine） | 345 项：337 通过、1 失败、7 跳过；失败为 mesh-lan.test.ts:66 的局域网超时 |
| 依赖审计 | registry 审计完成，报告 2 个 high：原有 sandbox-runtime / node-forge；与变更前版本及锁条目完全相同，未报告新增 MCP 包高危项；未对其进行降级或无关升级 |

局域网超时先前已在未提取执行循环的 `f4f93c4` 基线源码上复现（同一用例、同一等待位置）；此次没有改动 mesh 或该测试，仍未查明此环境超时的根因。之前全量并发中的协调器用例失败本次未再出现，不能据此证明间歇问题已修复。全量测试没有全绿。

## 独立审查与修正

子代理独立审查复现了保密输入排队问题：前一条 RPC 等待时，保密期间收到的正文可能在保密结束后执行。现在输入队列在收到行时固定屏蔽状态，受保护正文立即拒绝，不能在解锁后补发；真实入队回归覆盖普通正文和新会话标题。另修正非当前会话结束事件遗漏清理轮次状态。审查者复核并独立运行 TUI 13 项测试通过，没有剩余已确认阻断问题。

## 未完成与限制

- MCP 已支持 stdio 与远程 Streamable HTTP / SSE、OAuth 2.1、tools / resources / prompts 与插件包（见 [MCP 与插件](MCP.md)）；尚无多模态结果、动态列表刷新、自动重连、sampling / elicitation，推荐目录里的真实服务与安卓 / Windows 上的 npx / uvx 启动未做端到端验证。
- 默认 MCP 沙箱复用现有 agent 隔离，能访问部分灵魂与保密库；Windows 沙箱 stdio 明确拒绝。显式 sandbox:false 具有宿主用户权限；孙进程清理仅尽力处理。
- TUI 首期只连回环网关，没有远程 TLS 配对、全屏布局、附件、语音或终端保密值采集；未做实际交互终端及 Windows 真机验证。
- 研究运行器不包含 PRIME 演化、Training-Free GRPO 经验优化或 OpenRLHF 训练；尚未进行真实模型实验、GPU 训练或论文收益复现。轨迹不是自动脱敏的公开数据，报告用量不是精确费用硬上限。
- 未运行真实 MCP 服务、真实供应商、安卓 / Windows 设备或跨身体验收；未推送或发布。

后续工作与依赖继续维护在 [路线图](ROADMAP.md)。
