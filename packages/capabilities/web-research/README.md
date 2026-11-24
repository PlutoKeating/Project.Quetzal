# 联网研究（web-research）

经外部只读检索与抓取收敛来源，输出带引用的研究报告；写外发需 Router 授权。

- 实现：`quetzalcoatl-capabilities::web_research`。
- 描述符：`capability.json`，由工作区契约测试逐字段校验。
- 权限面：网络=是；sinks=network.read, memory.observe。
- 所有工具调用仍须经 `Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings` 交集授权。
