# 公网 Webhook 通道包

公网 Webhook 入站由 quetzalcoatl-hub 内存验签后立即 HPKE 密封入队（零明文落盘）；出站为 HTTP POST。

- 描述符事实源：`channel.json`（由 `quetzalcoatl-channels` 一致性测试强制校验）。
- 驱动实现：`crates/quetzalcoatl-channels/src/drivers/webhook.rs`。
- 凭据：仅从 `QUETZALCOATL_HOME/secrets/webhook.json` 或 `QUETZALCOATL_CHANNEL_WEBHOOK_*` 环境变量读取，绝不入库。
- 测试：全部使用 `MockTransport`，CI 零真实网络。
