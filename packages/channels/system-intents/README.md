# 系统本地意图 通道包

纯本地系统意图通道：零网络、零凭据、无外部服务依赖，禁止投递任何附件。

- 描述符事实源：`channel.json`（由 `quetzalcoatl-channels` 一致性测试强制校验）。
- 驱动实现：`crates/quetzalcoatl-channels/src/drivers/system-intents.rs`。
- 凭据：仅从 `QUETZALCOATL_HOME/secrets/system-intents.json` 或 `QUETZALCOATL_CHANNEL_SYSTEM-INTENTS_*` 环境变量读取，绝不入库。
- 测试：全部使用 `MockTransport`，CI 零真实网络。
