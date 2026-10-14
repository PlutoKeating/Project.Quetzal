# 执行循环、自主调度与协作

基线与证据范围见 [BASELINE.md](BASELINE.md)。宿主编排入口为 [brain.ts](../../runtime/src/mind/brain.ts)，真实循环在 [engine/src/loop.ts](../../engine/src/loop.ts)。首次提取验证见 [EXTRACTION.md](EXTRACTION.md)。

## 1. 三条执行路径

| 路径 | 触发与输入 | 结束与落盘 |
|---|---|---|
| 对话 `converse()` | 控制台、飞书、语音、子 agent 报告、灵魂提醒、跨身体交接；系统提示 + 会话历史 + 当前输入 | 模型不再调用工具时取最后一步文字；回复和过程写 `messages`，细节写时间线，尝试灵魂推送 |
| 思考 `wake("think")` | 心脏抽样；拉取灵魂，quick 模型内省决定投入 / 意图 / 身体位置 | `finish` 写日记与驱动力反馈；不调用工具也可结束，缺 `finish` 时用默认日记 |
| 做梦 `wake("dream")` | 睡眠状态的抽样；任务提示要求整理经历与记忆 | 获取整理租约，执行同一循环，写日记并释放租约；每 10 分钟续租 |

单身体做梦跳过 quick 内省并直接投入；多身体时内省仍用于选择执行位置，做梦只选一具身体。思考内省回答 `engage=false` 时记一条 `doze` 后返回。内省解析 / 请求失败时默认投入，并采用可用的推荐位置。

## 2. 一轮工具循环

`brain.loop(messages, reason, withFinish, session, exclude)` 取得工具定义快照并装配宿主 ports，随后委托 `engine.runTurn()` 执行；循环持续复用同一个消息数组：

1. 检查 Session 取消状态和 `STOP`，读取收件箱及待查看图片，发送 `step`。
2. 调用 `providers/router.chat()`，传入消息、工具、`brain.maxOutputTokens`（默认 4096）、轮次 id、取消信号与流回调。
3. 保存模型 assistant 消息。没有工具且没有待处理插话 / 图片时结束；刚收到插话则继续。
4. 按模型返回顺序逐个执行工具；同一个响应里的多工具调用采用串行 `await`，不是并行执行。
5. `finish` 由循环直接处理；普通工具通过 `callTool()`，向模型追加工具结果后再进入下一步。

这是一种模型驱动的“调用工具—观察结果—继续”循环，没有独立的规划图、任务 DAG 或持久化工作流执行器。步数和持续工作的总时长没有硬上限。

对话没有输出文字也没有工具时最多追加两次基座提醒再试；仍为空则明确说明没有回复。`truncated` 表示输出达到上限，不触发输入上下文压缩。回复采用终止步骤的文本，中间文字属于过程。`stripStamp()` 去掉模型仿写的历史附注。

工具结果原文给模型最多 12000 字符，失败 / 被拒标记另加；同一工具与参数再次失败时附上提醒，但不强制禁止重试。摘要结果、完整本机工具记录和模型上下文结果分别保存，不能互相替代。`move_to` 成功发起后结束本地循环，通过接手身体继续。

## 3. 会话与轮次

源码使用两种不同概念：SQLite `sessions.id` / `conv` 是长期对话会话；[activity.ts](../../runtime/src/mind/activity.ts) 的 `Session.id` 是一次执行轮次，事件字段名为 `session`，客户端也称 `turn`。醒来轮次可以没有 `conv`；子 agent 的 `conv` 指向父会话。模型请求传入的是轮次 id。

同一会话经 `chains` 排队；`running` 保存当前轮次；不同会话可在同一 Node.js 进程中并发。系统提示能看到其他会话近期消息和进行中动作，因此会话不是权限或数据隔离域。

| 输入方式 | 执行行为 |
|---|---|
| `steer`（默认） | 消息立即入库，加入收件箱；下一次模型调用前并入当前上下文 |
| `interrupt` | 同上，并中止当前模型输出；已输出文字保留并标注打断；正在执行的工具继续 |
| `queue` | 入库并排在当前轮次之后，成为下一轮 |
| `chat.stop` | 中止当前轮次与正在进行的模型请求，不再等普通工具；`shell` 接收到取消信号后结束；排队消息继续 |

保密输入先经过跨身体路由，再由 `intake()` 截取，发生在消息入库之前。环境输入使用数据库角色 `ambient`，模型侧转成 `user` 消息并给出来源说明；模型回复“沉默”可不保存回复，将原输入标为 `ignored`。

## 4. 时间墙与进展

| 机制 | 当前常数与实现 | 能保证什么 |
|---|---|---|
| 模型无数据 | `LLM_IDLE_MS=90000`，`providers/adapters.ts` | 无数据时终止该次模型请求 |
| 模型无内容 | `LLM_CONTENT_IDLE_MS=180000` | 避免只发保活而没有内容的流一直持续 |
| 轮次无进展 | `SESSION_IDLE_MS=120000`，`activity.ts` | 无进展时中止轮次；工具执行和排队时 `hold()` 暂停计时 |
| 可见心跳 | `HEARTBEAT_MS=15000`；文字每约 200ms 合并推送 | 客户端观察存活与流式进展；心跳本身不等于任务有成果 |
| 命令 / 自造工具 | `sh.ts`、`custom-tools.ts` 按无输出计超时 | 连续有 stdout / stderr 时可持续运行，不限制总耗时 |

没有统一的“任务总时长 / 总步数 / 总消费”硬停止条件。取消能力取决于执行入口：对话停止使用 `Stopped`，子 agent 停止使用普通 Error；`untilStopped()` 只对 `Stopped` 提前结束工具等待，子 agent 停止不能等同于强制撤销所有工具副作用。

## 5. 子 agent

[agents.ts](../../runtime/src/mind/agents.ts) 通过 `spawn()` 开一个后台异步循环，系统提示由名字、目标、人设、范围与背景拼出，任务消息包含显式 `context`。不自动继承主 agent 人格和完整历史，也不自动执行主 agent 的系统提示组装 / 自动 RAG。

它复用 `brain.loop()`，传入排除集合 `AGENT_TOOLS`：不能切会话、压缩会话或管理 / 再派子 agent；循环再单独加入 `finish`。其他可用工具仍共享，包括读取 / 修改记忆、运行命令和身体能力，闸门使用同一配置。独立提示词不等于独立进程或权限域。

完成报告来自 `finish.journal`，没有 finish 则采用最后文字；报告作为父会话的 `ambient` / `子agent` 输入送回 `converse()`，可能触发主 agent 继续处理。`agent_message` 进入收件箱，`agent_status` 读取元数据和 live 过程，`agent_stop` 取消 Session。最近 50 条元数据持久化到 kv；重启时未完成任务标为错误“基座重启，未完成”，没有执行检查点恢复。

`AgentSpec.maxSteps` 只写入提示词，循环没有按它计数终止。`SubAgent.steps` 完成时取工具记录数，与轮次 `step` 的模型调用次数并非同一种计数。

## 6. 心脏、感知与提醒

[heart/model.ts](../../runtime/src/heart/model.ts) 实现好奇、表达、社交与未完成念头驱动力，双过程生物钟（睡眠压力 S、昼夜节律 C），瞬时醒来率与指数抽样。[heart.ts](../../runtime/src/heart/heart.ts) 维护状态、积分、睡眠切换与 thinning 调度；最长 15 分钟候选等待只是重算步长，不是定时叫醒。

暂停、急停和无模型使自主率归零；过热、电量低、离线按倍率抑制；每日 tokens / 费用达到预算时乘 0.05。预算由用量记录驱动，只控制自主醒来概率，不是模型请求硬门禁。对话由消息直接进入，不等待下一次抽样。

[body/twin.ts](../../runtime/src/body/twin.ts) 把平台采样映射为身体描述与 `sense` 事件；采样不调用模型。[time/reminders.ts](../../runtime/src/time/reminders.ts) 单独维护提醒，到点直接发送预先写好的文字，不需要模型或抽样命中。多身体时通常由协调者触发，网络分区可重复发送。

## 7. 多身体执行

[coordinator.ts](../../runtime/src/mesh/coordinator.ts) 在可达成员中按优先级、电源、启动时刻、名字确定持有心脏的身体，其他身体跟随；网络分区各自选举，不提供全网强一致单领导者保障。[placement.ts](../../runtime/src/mesh/placement.ts) 提供概况与推荐，模型用 uuid 选择执行身体。

[presence.ts](../../runtime/src/mesh/presence.ts) 路由正在另一具身体上进行的会话输入、转发 live 进展；[limbs.ts](../../runtime/src/mesh/limbs.ts) 暴露受限工具、文件借用与交接；[replica.ts](../../runtime/src/mesh/replica.ts) 复制对话与时间线。迁移依靠历史和交接重新建立循环，不序列化原执行栈 / 原 `messages` 数组。

[claims.ts](../../runtime/src/mind/claims.ts) 提供按规范化 key 字面比较的认领，协调者在线时集中决定，断开时本地决定；它依赖模型主动调用，工具执行入口不自动强制认领。它不是外部副作用的事务或恰好一次执行保障。
