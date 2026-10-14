# 结构化记忆与 PRIME 经验内核

本页说明 [memory.ts](../../engine/src/memory.ts) 和 [prime.ts](../../engine/src/prime.ts) 的实际算法。内核提供结构化状态变迁、过滤检索、异步蒸馏和经验演化；runtime 负责来源采集、模型调用、独立结果判定、持久化、灵魂同步和取消／超时。它不是完整论文复现，合成任务结果不代表真实部署收益。

## 结构化真相与检索

`MemoryRecord` 是有版本的记录，包含以下字段：

| 字段 | 语义 |
|---|---|
| id、version | 逻辑记录与版本；`memoryKey()` 为 `id@version` |
| kind | fact、preference、episode、experience |
| state | candidate、active、superseded、archived |
| text | 该版本完整内容，不由检索摘录反推事实 |
| slot | 可选事实／偏好键，用于可信知识修订；不根据文字相似猜键 |
| scope | agentId，及可选 userId、sessionId、taskType；有约束的记录只匹配相同上下文 |
| createdAt、updatedAt、validFrom、validUntil | 毫秒时间与有效区间，结束时刻不包含在有效区间内 |
| conditions | requiredTags、excludedTags、tools；分别要求命中、拒绝命中、要求能力存在 |
| stage | exploration、verification、completion、any；由宿主任务状态提供，不按固定会话轮数推断 |
| zone | golden、warning、preference |
| preference | 偏好必须标 explicit 或 inferred；explicit 需有核对过的用户证据 |
| parents | 父版本键；改写、组合与回滚均可追踪 |
| evidence | 来源 id、ref、origin、observedAt、summary、verified；不允许同 id 的证据被改写 |
| validation | unverified／verified／rejected、评价者、时间、分数、可选基线与证据引用 |

`validateMemoryRecord()` 校验身份、内容、时间、条件、来源和验证引用。未验证记录不能标为 active；显式偏好不能以模型的推断代替用户来源。来源 verified 是宿主可信采集与核对的结果，不是让蒸馏模型自填的字段。校验器无法仅靠一个布尔值证明来源真实，生产适配器必须控制这个边界。

`selectMemory(records, query)` 先过滤 active／verified、agent 与用户／会话／任务 scope、有效区间、阶段和条件，再做词面相关性排序。阶段 unknown 只匹配 any；没有查询文本时按更新时间排序。返回克隆，调用者修改返回值不修改库。词面分数只影响相关性，不证明内容真实。普通旧 notes 原文不能因此成为事实或独立任务结果。

`retrieveMemory(records, query, ports?, options?)` 在同一资格门禁后提供异步语义选择。候选默认最多 20 项，个人事实／偏好和经验／episode 分组各预留一半；组内词面优先，补充近期记录，个人组额外给长期偏好／事实保留最多两个名额，避免近期经历完全挤掉旧认识。候选每条默认 256 字符短视图，不修改真相源。宿主注入的 select 返回版本键，未知、跨 scope、重复或未入选候选的键不会透传；允许零命中，最终仍受 query.limit 限制。

选择器收到查询和短视图的克隆，不能通过修改它们放宽原门禁。返回的是原记录快照的完整克隆，短视图不是事实正文。没有 select 端口时明确退回 `selectMemory` 的确定性词面算法，不宣称语义召回；有界候选也不保证全库的每一条潜在语义相关记忆都被看到。模型调用、取消、缓存与费用预算仍由生产宿主提供。

## 候选与激活

`createMemoryCandidate(draft, evidence, now)` 仅允许引用调用方来源清单中已存在的 evidenceIds。草稿没有权力发明来源、跳过验证或自行设 active。

`assessMemory(candidate, assessment, now, minimumScore)` 必须满足 accepted=true、independent=true、独立已核对来源、分数达到明确传入的门槛；有 baselineScore 时还必须不低于基线。结果合格才 active，否则仍为 candidate，validation 记录 rejected。经验的 agent 自述和 document 来源不能作为独立评价结果。

事实与偏好可以由宿主通过专门的可信流程核对，但 **PRIME 自动学习只激活 experience**。fact、preference 和 episode 草稿保留为候选；本内核不读写人格和 `USER.md`，经验泛化不能跨 agent 或用户作用域。inferred 偏好不得被包装成 explicit。

## 轨迹提炼闭环

`MemoryEpisode` 包含身份／scope、起止时间、宿主给出的任务阶段、标签／工具、各轮文字与证据引用、来源清单以及 outcome。outcome 为 success／failure／unknown，并引用对应来源。

`distillEpisode(episode, distill, now)` 实际异步调用注入的蒸馏端口，传递轨迹克隆，返回最多 32 项结构化候选。它校验用户边界、重复候选 id 和来源引用。蒸馏可以整理没有奖励的经历，但不能因此证明策略有效。

`learnEpisode(records, episode, ports, {now, minimumScore})` 将候选并入新库。只有 outcome 已知、引用已核对的用户／工具／环境／评价来源，且候选为 experience，才调用独立 evaluate 端口尝试激活。outcome 未知、只有模型自述或文档资料时，不执行激活评价。普通工具返回 ok 本身不自动意味着用户任务成功；宿主必须单独判断目标结果。

ports 包括：

- `distill(episode)`：注入模型完成语义提炼，返回 MemoryDraft[]。
- `evaluate({candidate, parents, episode?})`：注入独立任务或可核查反馈评价，返回 MemoryAssessment。

生产适配器可以使用快速模型提炼和提出改写，但不能允许同一模型通过生成 accepted、score 或 verified 来源自证成功。独立反馈缺失时，candidate 是正确结果。宿主端口须处理超时、急停、费用与输出脱敏；这些策略不由纯状态模块隐藏执行。

## 演化、去重与回滚

`evolveMemory(records, request, ports)` 支持四种真实操作：

| 操作 | 状态变迁 |
|---|---|
| rewrite | propose 改写一个 active 经验；保留 id，新版本经 evaluate 合格后才 supersede 原版本 |
| generalize | propose 泛化适用条件／阶段；保留 agent／用户边界，合格后才替代 |
| combine | 至少两个同 agent／用户经验形成新 id，保留全部父版本与来源，不自动替代或删除父经验 |
| archive | 指定 active 经验归档，保留内容、来源及历史，不调用模型，不因使用次数低就删除 |

演化的独立评价必须给出 baselineScore；没有对照、证据不足或分数退化时只安装候选。提案不能选择性删除父版本的失败来源。`installMemory()` 在有效活动／候选记录中按内容、性质、作用域、阶段及条件去重并合并来源；替代仅在新版本 active 后发生。不同内容不能覆盖已存在的版本键，已演化 id 的后续更新应走演化接口。

候选仅能和候选去重。只有新记录本身 active／verified 时才合并到既有 active 的证据；故事、否定或未确认片段即使正文完全相同，也不能借去重污染已确认事实，仍单独保留候选。

`rollbackMemory(records, key, now)` 从已验证且未失效的历史版本生成新的 active 版本，保留父关系，把当前同 id 活动版本 supersede。它不是改写或删除历史，也不要求用户或模型手动操作灵魂 Git。

## 已确认事实与明确偏好的修订

`upsertConfirmedMemory(records, incoming, now)` 处理同 scope、同 slot 的知识更新。只有 incoming 已 active／verified，kind 为 fact 或 explicit preference，validFrom 与原始来源 observedAt 都严格更新，且当前有效，才沿用旧逻辑 id 生成更高版本并将旧 active 版本 supersede。来源与父版本全部保留；不同用户、会话或任务约束不会互相替代。

有用户原话时，比较用户原话的 observedAt，不能靠更晚的模型评价时间冒充新用户决定。同时间不同内容、旧来源、新事实尚未有效、或原库已有多个活动冲突版本时，保留新内容为 rejected candidate，不任意挑选真值。没有 slot、没有可信验证或 inferred 偏好不自动覆盖既有事实；重复相同内容只合并证据。宿主必须用稳定领域键标识事实，如 residence.city，而不能仅凭文本相似触发覆盖。

所有状态函数返回新记录，不修改调用方原库。持久化要由宿主原子写入并遵守 [灵魂仓库规范](../SOUL_REPO_SPEC.md)，调用现有自动同步；检索、提炼与演化接口自身没有文件或数据库依赖。

## 已有合成验证与范围

[memory.test.ts](../../engine/test/memory.test.ts) 和 [prime.test.ts](../../engine/test/prime.test.ts) 覆盖来源与偏好校验、多维过滤、失效与状态、去重、来源不可改写、归档、版本替代、回滚、真实异步端口、未知结果与自述成功、事实／偏好不自动激活、退化提案、无基线泛化和组合保留来源。

合成闭环比较没有经验与已激活经验的同一预算任务：经验引导先确认预算，再搜索；标准答案检查行动顺序。它证明接口和状态路径可执行，不证明真实模型能正确提炼、长期泛化或改善用户满意度。真实部署仍需核对 runtime 来源采集与独立结果评价；MCP 成功、模型最终文字和权限审批分别不是任务成功证据。
