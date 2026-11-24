# 桌面操作（hands-desktop）

在用户显式授权下经 OS 沙箱执行桌面自动化，所有高危动作强制二次确认。

- 占位（Sprint 4/5 落地）：`quetzalcoatl-capabilities::hands_desktop`。
- 描述符：`capability.json`，由工作区契约测试逐字段校验。
- 权限面：网络=否；sinks=desktop.interact。
- 所有工具调用仍须经 `Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings` 交集授权。
