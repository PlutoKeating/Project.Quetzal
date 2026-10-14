# 引擎边界与依赖注入

## 第一阶段边界

`runTurn(options, ports)` 执行一轮模型—工具循环，原地追加 `options.messages`，返回 `{text, finish?, steps, tokens, model}`。它不认识身体、会话数据库、人格、灵魂 Git、心脏、网关或消息通道，不导入运行宿主。

`RunOptions` 提供初始消息、轮次生命周期、工具定义快照、输出 token 上限（数字或按每次请求读取的函数）和可选 finish 定义。`TurnControl` 是结构型协议，由宿主实现 id、取消信号、进展事件、流输出、模型请求生命周期与工具等待期间的计时暂停；现有 runtime Session 直接适配，无需搬迁计时、快照或 mesh 广播。

`EnginePorts` 的职责：

| 端口 | 宿主提供的行为 |
|---|---|
| chat | 模型请求、供应商协议与路由 |
| execute | 工具查找、权限、沙箱、审计及灵魂触碰同步 |
| drain / incoming / pending | 插话、提醒、附件与图片补入消息；incoming 仅表示收件箱，pending 包含待处理图片 |
| check | 急停等外部执行条件 |
| interrupted / stopToolWait | 区分模型打断与能够提前结束工具等待的取消原因 |
| moved | 跨身体交接已发生时的结束说明 |
| cleanText / redactArgs / summarize | 宿主历史附注清理、参数脱敏与工具卡片摘要 |
| recordTool / warning | 完整工具记录保存及非致命记录错误 |

FinishTool 名称固定为 `finish`，运行时也拒绝其他名字；未提供 finishTool 时模型自行返回 finish，仍按旧循环识别并结束，不交给普通工具端口。finish 的 schema 由宿主定义；引擎只返回参数，不写日记或改变驱动力。MCP 是宿主工具来源之一，需要宿主管理连接/发现/权限，再以 ToolDef 与 execute 接入；界面和通道则调用宿主的对话入口。当前切片没有新增 MCP 或 TUI。

## 兼容行为

工具定义在入口快照，工具执行串行；finish 不调用普通工具端口，同一响应中 finish 后的其他工具仍执行。最终 text 只取终止步骤，空对话最多提醒两次。interrupt 保留部分文字；pending 输入或图片使循环继续。模型侧工具结果截取 12000 字符，简短步骤记录截取 1500，完整记录由宿主保存。失败与 denied 注入错误标记，同参数重复失败追加提醒。

取消判定由宿主注入：现有普通 Stopped 能提前结束正在等待的工具，子 agent 的普通 Error 保持已有差异。工具本身的取消和副作用仍由宿主管理。迁移不增加总步数、总消费或绝对时长上限，也不实施自动压缩；既有 maxSteps 提示词限制不变。

模型类型由 engine 维护，`runtime/src/providers/types.ts` 重导出兼容旧导入路径，供应商配置、Key 与 ProviderError 留在 runtime。

## 后续切片

先在保持回归通过的条件下设计独立轮次生命周期；再讨论上下文预算/自动压缩、可替换记忆接口、工具来源管理、独立宿主入口。新增成本门禁、背压、能力隔离属于行为变化，应分别设计与验证，不能混入本次目录提取。跨身体和子 agent 调度继续由宿主负责，除非之后明确批准通用编排接口的迁移。
