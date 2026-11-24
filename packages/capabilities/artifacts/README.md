# 产物登记（artifacts）

以不可变 ArtifactRef 登记构建产物与 Git Tree 引用，供跨 Worktree 零拷贝交接。

- 实现：`quetzalcoatl-capabilities::artifacts`。
- 描述符：`capability.json`，由工作区契约测试逐字段校验。
- 权限面：网络=否；sinks=artifact.register, artifact.read。
- 所有工具调用仍须经 `Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings` 交集授权。
