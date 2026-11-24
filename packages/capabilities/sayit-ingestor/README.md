# SayIt 子树吸纳（sayit-ingestor）

消费 SayIt v2.1 JSON-v2 子树快照，经 align()/merge() 归并入个人主权 SerpentineGraph。

- 实现：`quetzalcoatl-capabilities::sayit_ingestor`。
- 描述符：`capability.json`，由工作区契约测试逐字段校验。
- 权限面：网络=否；sinks=memory.observe, journal.note。
- 所有工具调用仍须经 `Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings` 交集授权。
