# 结构化记忆与生产 PRIME 宿主

状态：生产宿主实现；实际模型调用经 quick 路由，测试使用假模型、真实 Markdown 文件、SQLite 与本地灵魂 Git。此页不把合成测试当真实模型质量证明。

## 真相源与规范边界

结构化记录位于 `QUETZAL_HOME/soul/notes/QuetzalMemory/<id>_v<version>.md`。遵守 [灵魂仓库规范 v14](../SOUL_REPO_SPEC.md) 的现有 notes 目录、可移植路径和自由 Markdown，不增加灵魂顶层目录，不改变规范版本，不向灵魂提交派生检索索引。

每文件含 `#` 标题、`>` 一句话摘要、标识 `quetzal-memory-v1` 的 fenced JSON 和可读正文 / 来源。一个文件对应一个记忆版本。记录包括 kind、state、scope、stage、zone、适用条件、来源证据、验证状态、父版本和时间范围。状态是 candidate / active / superseded / archived；类型是 fact / preference / episode / experience，偏好另分 explicit / inferred。格式与纯状态规则由 [engine memory](../../engine/src/memory.ts) 维护。

[structured.ts](../../runtime/src/memory/structured.ts) 只进行格式、状态、路径和历史完整性验证，**不对私有灵魂正文进行密钥检查、隐私筛选或脱敏**。读取和保存原始正文 / 证据；即使正文含已知秘密，也不改写该私有记录。模型输入、客户端输出和日志是另行脱敏的边界。新增自动候选由已脱敏的学习输入形成，但不会据此重写已有私有记录。

写入经过 `memory.exclusive()`，在锁内重新读取现有记录，再以临时文件替换变化版本；之后调用 `soul.touched()` 触发基座自动提交与同步。agent 和用户不需要操作 git。旧版本只能替代或归档，不能经此 API 删除。并发学习对已变化版本拒绝覆盖，避免用旧快照覆盖刚合入的远端内容。锁只保证本机进程内互斥，多身体仍遵循现有灵魂 Git 合并边界。

JSON 损坏、格式未知、id 与文件名不匹配、过大文件或 `.incoming` 副本不作为正式记录读取，原文件保留供裁决。QuetzalMemory 保留目录内的这些材料**也不再被导入为自由 legacy 笔记**，避免损坏或候选状态通过兼容路径进入默认上下文。原始 recall / 笔记工具仍可读取资料，不等于已确认的上下文记忆。

普通 `note_save` / `note_move` / `note_delete` 在路径规范化后拒绝大小写不同的受管类别；移动同时检查来源和目标。普通灵魂写入口拒绝路径中的已有符号链接 / 目录链接、硬链接文件别名及以目录冒充笔记的移动，覆盖 USER / MEMORY / SOUL 写入与日记追加，避免升级前留下的链接将普通写入导向受管记录；已有路径段的 native 真实路径另行核对，防止文件系统短名别名绕过受管根检查。宿主 structured 写入使用独立的候选、证据确认与版本 API，不经过普通笔记写入口；读取继续允许。这里保护的是受管状态与证据的修改权限，**不检查、删改或脱敏私人正文**，普通笔记仍能保存任意 Markdown 内容。进程内锁覆盖应用写入，操作系统层的命令写权限另由沙箱约束；它不阻止部署者在信任边界外直接维护自己的私有仓库。

## 兼容已有知识

原 `memories/USER.md`、`MEMORY.md` 和保留目录外的普通 notes 不搬移、不覆盖、不自动重写。读取时映射为临时的 legacy episode / warning，正文前明确标注“旧记忆未核实，仅参考”。其验证信息只证明旧材料存在，不证明断言为真，不参与 PRIME golden 策略评价，也不落盘生成另一份灵魂副本。

`getMemoryCandidates(query, scope, phase, options)` 返回引擎 `MemoryRecord[]`。结构化候选、过期记录、superseded / archived、错 agent / 用户 / 会话 / 任务类型、不满足标签或工具条件的记录均被排除。阶段未知时仅匹配 any；不以模型名字或文字相似自动突破作用域。legacy 保留知识可用性，但其事实来源等级保持显式区分。

## 宿主 API

| API | 行为 |
|---|---|
| `readStructuredRecords()` | 原样读取可验证格式的全部版本，包括候选与历史 |
| `readLegacyRecords(scope)` | 只读兼容映射，不重复 QuetzalMemory 记录 |
| `getMemoryCandidates(query, scope?, phase?, options?)` | 语义候选用于上下文选择，默认只包含合格 active 及标注的 legacy 材料 |
| `recordMemory(draft, evidence, options?)` | 写 candidate；引用证据须真实存在于传入清单；不能自行指定 active |
| `reviewMemory(key, assessment, options?)` | 可信宿主的独立评价；不能把模型工具参数中的 verified / independent 直接当证据 |
| `confirmPersonalMemory(key, {actor, signal?})` | 仅管理者确认入口核对真实用户来源与个人语义；不暴露为 agent 工具 |
| `archiveRecord(key)` / `rollbackRecord(key)` | 保留历史的归档与恢复；不恢复未经验证或已失效版本 |
| `recordMemoryUse(keys, episodeId)` | 本机 SQLite 使用统计，不进灵魂 |
| `recordEpisode(input)` | 记录已完成轮次的真实轨迹，保留来源级别，不执行生产工具 |
| `learnEpisode(inputOrEpisode, options?)` | quick 蒸馏、来源评价、存候选或已核对记忆；返回 learned / skipped / failed |
| `evolveMemory({operation, keys, signal?}, options?)` | quick 改写 / 泛化 / 组合提案或直接归档，再经独立对照门禁；不恢复生产任务 |

生产学习实现在 [prime.ts](../../runtime/src/memory/prime.ts)，纯 PRIME 规则在 [engine prime](../../engine/src/prime.ts)。学习与演化接受注入的 `chat` 与可信 `evaluate`，个人语义可由可信 `confirmPersonal` 注入确认；默认不设置个人确认器。默认 chat 调用 `providers/router.chat(request, {quick:true})`，不依赖研究脚本。

`EpisodeInput` 必须提供 episodeId、session、userInput、reply；可提供 userSourceRef、userOrigin、scope、phase、toolRecords、taskEvidence、outcome / outcomeEvidenceIds、feedback、使用过的记忆 key 及 signal。脑、做梦与子 agent 都可以提供轨迹，但生成的任务文字不是用户发言。

## 证据准入

1. **个人事实 / 偏好默认候选：**只有 `message:<id>` 对应当前 session 中真实 SQLite user 消息时，用户来源才标 verified。即使 text / quote 与原文子串一致，也不证明它是用户自述：否定、故事角色和假设都可能出现同样文字。因此默认 fact / explicit preference 均保存 candidate，只有可信宿主的独立个人语义确认或管理者明确确认后才准入；不靠再加关键词启发式判断。无 message ref、agent / environment 输入不会冒充明确用户来源；推断只留 candidate，也不改写 USER。
2. **完整语境观察：**真实用户消息在调用模型前自动保存为 active episode / warning，只验证“用户发送了这段消息”，明确不确认消息内的个人断言与偏好。长消息按不破坏 Unicode 的 30000 字符片段完整保存并标序号，SQLite 保留原消息。模型失败或学习预算耗尽也不丢这份来源语境，不把它当 golden 策略奖励。
3. **新事实版本：**只有个人语义得到独立确认后才按稳定 slot 更新。蒸馏模型得到有限的同作用域已知槽位，必须明确同一属性才复用；引擎只按 slot 与完整 scope 更新，不用文本相似覆盖。以真实用户消息时间作为 validFrom；来源与时间严格较新才沿旧 id 升 version、保留父 key 与旧来源并 supersede。时间冲突或证据不足保留候选，不猜真相。
4. **工具失败观察：**`toolRecords` 必须能匹配本机 `tool_calls` 的当前轮次、工具名、状态与结果。匹配的真实单调用 error 可沉淀为 warning，但仅在候选限定一个对应工具时准入。宿主将模型归因替换为实际失败观察及限制说明，不断言整任务失败、不宣称已证明解决策略。伪造的工具摘要只留未核实材料。
5. **成功经验：**单工具 ok、最终有文字或模型自称完成都不是整体成功。必须额外提供独立 taskEvidence 并由 outcomeEvidenceIds 引用；模型不能自建 evaluator 证据。任务成功仍不足以证明任意蒸馏经验。默认在宿主真实独立成功证据存在时，通过第二次 quick 调用评审完整轨迹、候选正文与证据的语义忠实性：不扩大条件、不新增世界事实或因果断言、引用真实来源才激活。仅采用模型 accepted 与证据引用；verified / independent 来自宿主，拒绝模型自造证据。此门禁不证明因果收益；固定任务验收器仍可通过 evaluate 注入。
6. **晚到用户评价：**只有同 session 中真实、在原轨迹完成之后的用户 message 引用可附加反馈。新反馈可触发该轨迹新的记忆评价，不重跑工具、不重建执行栈；没有新来源时 episode 学习幂等。
7. **演化：**rewrite / generalize / combine 只处理 active experience。quick 提案不自动获奖；激活新经验必须有独立结果、baselineScore 和不退化评价。缺实际对照时保存 candidate，旧 active 保留。archive 不依赖模型、保留证据与历史。

默认评价可以确认消息存在、失败观察与有独立结果支持的经验提炼语义忠实性，不能直接确认个人语义，也不声称只凭一条轨迹证明因果策略收益。管理确认核对近期实际消息来源，来源不在可核对窗口中时明确失败而非猜测。实际模型提炼质量、slot 分类准确性及跨任务收益仍需独立评测。

## 预算、取消与存储

学习前对模型输入脱敏；每次输出默认 1200 tokens，最多 2400；一次模型会话默认 8 秒硬超时。UTF-8 输入字节加输出上限作为保守预留，默认每次学习会话 32000、每日 64000 token 预算，实际供应商用量返回后调整记账。输入正文最多 24000 字节、返回文本最多 24000 字符；超限不调用模型或不安装结果。既有上下文窗口策略与该后台预算分别维护。

chat / evaluator 都接收取消信号或有界等待；急停事件中止本次学习，持久化前再次检查 STOP 与 signal。失败不安装未完成结果，返回 failed 供宿主记录；不影响已返回的用户回复。脑的学习队列由宿主调度，关闭或停止的任务不隐式恢复。

本机 `kv` 保存最近 50 条脱敏 episode、最近 200 个学习证据版本 key、使用统计与日预算；这些派生状态不进灵魂。工具详细记录仍由既有 store 管理。结构化学习结果才写 notes，自动 git 同步仍由基座负责。

## 验证

[structured-memory.test.ts](../../runtime/test/structured-memory.test.ts) 与 [prime-memory.test.ts](../../runtime/test/prime-memory.test.ts) 使用源码外临时 QUETZAL_HOME、真实文件 / SQLite / 本地 Git 与假模型，覆盖：

- candidate 门禁、独立验证、作用域、Markdown 格式、新版本 / supersede、归档与恢复。
- legacy 原文兼容及保留目录损坏文件无旁路；私有正文包含已知 secret 仍原样读写。
- 并发写入、非法路径、无证据 active 拒绝。
- [managed-memory-tools.test.ts](../../runtime/test/managed-memory-tools.test.ts) 通过真实 callTool 拒绝普通笔记伪造 active / verified、移入移出与删除，覆盖目录 / 父路径链接、祖先改名、硬链接、USER / MEMORY / SOUL 与日记写别名，并通过注入 native 解析契约模拟文件系统短名别名；验证宿主候选确认、读取以及普通笔记写入仍可用。
- 个人引用默认候选、否定 / 故事 / 虚构子串不能伪装用户偏好、完整语境观察、可信语义 / 管理确认、同 slot 更新与跨用户隔离。
- 真实 tool error 限定观察、未知任务结果、独立任务证据、无 baseline 的演化候选、可信对照升版。
- 晚到真实反馈、学习幂等、预算、硬超时与急停。

新增受管工具专项 7 项及记忆 / 上下文联合 38 项本地测试通过，runtime 类型检查通过；这里是合成数据与本地文件系统验证，不把 native 别名模拟当作 Windows 短名实机验收，也不证明真实模型质量或多身体同步收益。后续修改必须继续维护事实来源等级，不能以接口完成替代模型效果、因果收益或真实部署证据。
