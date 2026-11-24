# 飞书 通道包

飞书事件订阅与卡片消息：长连接由单一 witness_epoch 持有；出站按卡片 30KB 字节上限分片。入站 JSON 事件仅在 Hub 内验签并 HPKE 密封。

- 描述符事实源：`channel.json`（由 `quetzalcoatl-channels` 一致性测试强制校验）。
- 驱动实现：`crates/quetzalcoatl-channels/src/drivers/feishu.rs`。
- 凭据：仅从 `QUETZALCOATL_HOME/secrets/feishu.json` 或 `QUETZALCOATL_CHANNEL_FEISHU_*` 环境变量读取，绝不入库。
- 测试：全部使用 `MockTransport`，CI 零真实网络。
