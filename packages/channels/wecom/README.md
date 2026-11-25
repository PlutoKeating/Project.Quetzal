# 企业微信 通道包

企业微信回调 XML 与应用 markdown 消息：markdown 单条 4096 字节，超限显式分片并带截断标记。

- 描述符事实源：`channel.json`（由 `quetzalcoatl-channels` 一致性测试强制校验）。
- 驱动实现：`crates/quetzalcoatl-channels/src/drivers/wecom.rs`。
- 凭据：仅从 `QUETZALCOATL_HOME/secrets/wecom.json` 或 `QUETZALCOATL_CHANNEL_WECOM_*` 环境变量读取，绝不入库。
- 测试：全部使用 `MockTransport`，CI 零真实网络。

## 加密回调字段

`QUETZALCOATL_HOME/secrets/wecom.json`（或 `QUETZALCOATL_CHANNEL_WECOM_*`）需提供：

- `encoding_aes_key`：企业微信 43 字符 `EncodingAESKey`（可省略末尾 `=`；加载时自动补齐 padding）。
- `receive_id`（可选）：配置后强制校验解密后的 `receive_id`（CorpID/AgentID），不匹配即 `INTEGRITY_VIOLATION`。
- `key` / `webhook_key`：出站群机器人 webhook key。
