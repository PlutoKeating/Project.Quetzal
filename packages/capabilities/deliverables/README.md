# 交付物生成（deliverables）

在受限工作区内生成文档、表格与演示文稿交付物并登记 ArtifactRef。

- 占位（Sprint 4/5 落地）：`quetzalcoatl-capabilities::deliverables`。
- 描述符：`capability.json`，由工作区契约测试逐字段校验。
- 权限面：网络=否；sinks=file.write, artifact.register。
- 所有工具调用仍须经 `Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings` 交集授权。
