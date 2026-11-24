# 钉钉 通道包

钉钉机器人 JSON 回调与 markdown 出站：单条 20000 字节上限。

- 描述符事实源：`channel.json`（由 `quetzalcoatl-channels` 一致性测试强制校验）。
- 驱动实现：`crates/quetzalcoatl-channels/src/drivers/dingtalk.rs`。
- 凭据：仅从 `QUETZALCOATL_HOME/secrets/dingtalk.json` 或 `QUETZALCOATL_CHANNEL_DINGTALK_*` 环境变量读取，绝不入库。
- 测试：全部使用 `MockTransport`，CI 零真实网络。
