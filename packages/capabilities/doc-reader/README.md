# 文档读取（doc-reader）

解析用户授权目录内的 PDF/Office/文本，提取结构化内容，不修改原文件。

- 占位（Sprint 4/5 落地）：`quetzalcoatl-capabilities::doc_reader`。
- 描述符：`capability.json`，由工作区契约测试逐字段校验。
- 权限面：网络=否；sinks=file.read。
- 所有工具调用仍须经 `Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings` 交集授权。
