# 引擎边界与依赖注入

## 当前执行边界

`runTurn(options, ports)` 执行一轮模型—工具循环，原地追加 `options.messages`，返回 `{text, finish?, steps, tokens, model}`。它不认识身体、会话数据库、人格、灵魂 Git、心脏、网关或消息通道，不导入运行宿主。

`RunOptions` 提供初始消息、轮次生命周期、工具定义快照、输出 token 上限（数字或按每次请求读取的函数）和可选 finish 定义。`TurnControl` 是结构型协议，由宿主实现 id、取消信号、进展事件、流输出、模型请求生命周期与工具等待期间的计时暂停；现有 runtime Session 直接适配，无需搬迁计时、快照或 mesh 广播。

`EnginePorts` 的职责：

| 端口 | 宿主提供的行为 |
|---|---|
| prepareContext（可选） | 每次模型调用前准备任务状态与动态记忆，使用同轮signal；ChatRequest.prepareForModel再针对实际候选窗口重算 |
| chat | 模型请求、供应商协议与路由 |
| execute | 工具查找、权限、沙箱、审计及灵魂触碰同步 |
| drain / incoming / pending | 插话、提醒、附件与图片补入消息；incoming 仅表示收件箱，pending 包含待处理图片 |
| check | 急停等外部执行条件 |
| interrupted / stopToolWait | 区分模型打断与能够提前结束工具等待的取消原因 |
| moved | 跨身体交接已发生时的结束说明 |
| cleanText / redactArgs / summarize | 宿主历史附注清理、参数脱敏与工具卡片摘要 |
| recordTool / warning | 完整工具记录保存及非致命记录错误 |

FinishTool 名称固定为 `finish`，运行时也拒绝其他名字；未提供 finishTool 时模型自行返回 finish，仍按旧循环识别并结束，不交给普通工具端口。finish 的 schema 由宿主定义；引擎只返回参数，不写日记或改变驱动力。MCP 是宿主工具来源之一，需要宿主管理连接/发现/权限，再以 ToolDef 与 execute 接入；界面和通道则调用宿主的对话入口。宿主已提供 stdio MCP 工具来源，CLI 已提供本机 TUI；二者不进入 engine 的协议实现或依赖树。

## 兼容行为

工具定义在入口快照，工具执行串行；finish 不调用普通工具端口，同一响应中 finish 后的其他工具仍执行。最终 text 只取终止步骤，空对话最多提醒两次。interrupt 保留部分文字；pending 输入或图片使循环继续。模型侧工具结果截取 12000 字符，简短步骤记录截取 1500，完整记录由宿主保存。失败与 denied 注入错误标记，同参数重复失败追加提醒。

取消判定由宿主注入：现有普通 Stopped 能提前结束正在等待的工具，子 agent 的普通 Error 保持已有差异。工具本身的取消和副作用仍由宿主管理。执行循环不增加总步数、总消费或绝对时长上限；自动压缩由新增 ContextManager 与宿主 prepareContext／prepareForModel 接线实施，子 agent 的 maxSteps 由宿主经 check／drain 端口计数，引擎不感知。

模型类型由 engine 维护，`runtime/src/providers/types.ts` 重导出兼容旧导入路径，供应商配置、Key 与 ProviderError 留在 runtime。

## 纯策略与离线研究

`context.ts` 与 `retrieval.ts` 只接收文本、文档、字符预算及显式当前时间；runtime 保留文件读取、日记时间转换、SQLite、灵魂同步与旧路径包装。这两份兼容纯函数保持旧算法的字符视图；生产工具循环使用独立 context-manager 与结构化记忆选择，不应据此称生产仍无动态预算。

`research.ts` 的 `runResearchGroup` 为每个样本建立独立环境并直接调用 `runTurn`；步数、调用数、报告用量、总超时和独立评分仅作用于研究运行。合成示例与真实模型实验不同，轨迹也不自动成为可公开的脱敏数据。完整接口及限制见 [研究运行器](../../docs/engine/RESEARCH_RUNNER.md)。

## 动态上下文与记忆内核

`context-manager.ts` 已实现逐请求有限窗口视图、字节保守估计、输出/Schema/图片余量、固定政策/用户约束与完整工具组、独立摘要slot/缓存和可回查投影。原消息不删除，固定部分无法装入时明确ContextOverflow；这是保守估计，不是真tokenizer。`TaskWorkingState`由宿主给出目标、约束、问题与证据，不从最新字符猜造事实。

`memory.ts`提供版本记录、来源/范围/有效期/阶段/条件门禁，以及可注入异步语义选择端口；`prime.ts`提供真实异步轨迹蒸馏与经验改写/泛化/组合/归档。经验需要可信独立结果评价，演化需要基线；模型自述与资料不是奖励。个人事实/偏好的可信确认、模型选择/学习预算、真实SQLite来源、Markdown持久化和自动Git同步由runtime实现。对应 [动态上下文](../../docs/engine/DYNAMIC_CONTEXT.md)、[记忆宿主](../../docs/engine/STRUCTURED_MEMORY.md) 与 [PRIME规则](../../docs/engine/PRIME_CORE.md)；没有宣称完整论文复现。

## 后续工作

轮次生命周期、跨身体和子agent编排仍在宿主；成本硬门禁、请求背压与独立能力域需单独设计验证。已有动态上下文与学习不等于这些边界已经完成，也不等于真实模型成功率得到证明。后续按回归与实际证据推进，避免把状态接口、生成候选或模型评语当作验证结论。
