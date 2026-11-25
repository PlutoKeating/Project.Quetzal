# 钉钉 通道包

钉钉机器人 JSON 回调与 markdown 出站：单条 20000 字节上限。

- 描述符事实源：`channel.json`（由 `quetzalcoatl-channels` 一致性测试强制校验）。
- 驱动实现：`crates/quetzalcoatl-channels/src/drivers/dingtalk.rs`。
- 凭据：仅从 `QUETZALCOATL_HOME/secrets/dingtalk.json` 或 `QUETZALCOATL_CHANNEL_DINGTALK_*` 环境变量读取，绝不入库。
- 测试：全部使用 `MockTransport`，CI 零真实网络。

## 加密回调字段

`QUETZALCOATL_HOME/secrets/dingtalk.json`（或 `QUETZALCOATL_CHANNEL_DINGTALK_*`）需提供：

- `aes_key`：钉钉 43 字符 `aes_key`（可省略末尾 `=`；解码为 32 字节时走 AES-256-CBC，否则走文档 SHA-256 派生变体）。
- `encrypt_key`：兼容字段名。
- `access_token` / `token`：出站机器人 access token。
- `secret`（可选）：出站加签密钥，发送时使用当前 epoch 毫秒并 URL 编码 `sign`。
