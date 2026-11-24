# Telegram 通道包

Telegram Bot API：文本硬上限 4096 字符，超出必须分片且末段带可见截断标记。

- 描述符事实源：`channel.json`（由 `quetzalcoatl-channels` 一致性测试强制校验）。
- 驱动实现：`crates/quetzalcoatl-channels/src/drivers/telegram.rs`。
- 凭据：仅从 `QUETZALCOATL_HOME/secrets/telegram.json` 或 `QUETZALCOATL_CHANNEL_TELEGRAM_*` 环境变量读取，绝不入库。
- 测试：全部使用 `MockTransport`，CI 零真实网络。
