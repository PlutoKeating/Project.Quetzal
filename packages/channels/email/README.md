# 电子邮件 通道包

电子邮件 RFC 5322：主题 255 字符、正文 100000 字符、附件 20 个；超限主题追加可见截断标记。

- 描述符事实源：`channel.json`（由 `quetzalcoatl-channels` 一致性测试强制校验）。
- 驱动实现：`crates/quetzalcoatl-channels/src/drivers/email.rs`。
- 凭据：仅从 `QUETZALCOATL_HOME/secrets/email.json` 或 `QUETZALCOATL_CHANNEL_EMAIL_*` 环境变量读取，绝不入库。
- 测试：全部使用 `MockTransport`，CI 零真实网络。
