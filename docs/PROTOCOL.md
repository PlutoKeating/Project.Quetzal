# Quetzalcoatl V2 协议

本文描述跨进程、跨设备、跨语言边界上真实存在的线格式。实现事实源为 Rust
`crates/quetzalcoatl-crypto` / `crates/quetzalcoatl-spine` / `crates/quetzalcoatl-group`
与 Go `hub/internal/`；跨语言测试向量位于 `spec/vectors/`。

## 1. 通用约定

- **编码**：JSON 使用 UTF-8、字段名 `snake_case`（领域包清单为 `camelCase`，见其文档）；
  二进制字段一律小写十六进制或标准 Base64（`ciphertext_b64`）。
- **时间**：毫秒 Unix 时间戳字段以 `_ms` 结尾；HLC 为 128-bit 十六进制。
- **错误信封**：Hub 统一返回 `{"code": "<ERROR_CODE>", "detail": "<人类可读说明>"}`，HTTP 状态
  另行表达传输语义（如 `403`、`409`、`429`）。`code` 取值与
  `crates/quetzalcoatl-types` 的 `ErrorCode` 完全一致，见 §12。
- **认证**：Hub 除 `/healthz`、`/ping`、`/generate_204`、`/relay` 握手与 webhook 入站外，均要求
  设备会话；身份必须与请求体中的 `agent_id` / `device_id` 完全一致，否则
  `PERMISSION_DENIED`。
- **幂等**：所有写操作都携带自然幂等键（事件 `seq`、`(target_id, evidence_hash)`、`pack_id`、
  `upload_id`），重复提交不得二次生效。

## 2. 脊柱事件

单条事件是单行 JSONL 对象：

```json
{
  "header": {
    "agent_id": "uuid",
    "device_id": "uuid",
    "epoch": 7,
    "hlc": "000001a2...e1",
    "payload_blake3": "64-hex",
    "prev_blake3": "64-hex",
    "seq": 42
  },
  "event_blake3": "64-hex",
  "sig": "128-hex",
  "payload": { "kind": "..." }
}
```

规范头按固定字段序拼接（`agent_id, device_id, epoch, hlc, payload_blake3, prev_blake3, seq`），
`event_blake3 = BLAKE3("quetzalcoatl/v2/spine-event-v1", canonical_header)`，`sig` 是设备
Ed25519 对该摘要的签名；`payload` 是内联 JSON 值（不是字符串字段）。

> **字段名属于冻结契约**：JSONL 顶层只有 `header`、`event_blake3`、`sig`、`payload` 四个键，
> 头内只有上述 7 个键。事实源是 `crates/quetzalcoatl-spine/src/ledger.rs` 的
> `SpineEvent::to_pack_jsonl_line`；Rust/Go 解析与 `spec/vectors/spine_pack_aad.json` 必须同步，
> `scripts/tests/docs_links.test.sh` 会检查本文档中的键名仍存在于该实现。

硬约束：

1. `seq` 从 1 递增；`seq = 1` 时 `prev_blake3` 必须全零。
2. `payload` 必须是合法 JSON；序列化为单行 JSONL 时不得含未转义换行。
3. 同一 `(device_id, seq)` 只能出现一次；不同设备链通过 `prev_blake3` 独立延展，合并时按 HLC
   全序去重。
4. 满 500 条未封包事件由 `SpineEngine` 自动打包（`AUTO_PACK_EVENT_THRESHOLD`）。

## 3. HLC

`HlcTimestamp` 是 128-bit：

```text
┌────────────── 64 ──────────────┬──── 32 ────┬──── 32 ────┐
│ wall_ms (Unix 毫秒)            │ logical    │ node_tag   │
└────────────────────────────────┴────────────┴────────────┘
```

- 排序按无符号 128-bit 全序，先比墙钟、再比逻辑计数、最后比节点标签。
- 接收远端事件时，若 `hlc.wall_ms > 本地可信时间 + 300_000 ms`，直接隔离拒收并记录
  `CLOCK_DRIFT_EXCEEDED`，**绝不**推高本机 HLC。
- 单毫秒逻辑计数溢出返回 `HLC_COUNTER_OVERFLOW`，不得回绕。

## 4. Packfile 与 AAD

`SealedPackfile` 字段：

```text
pack_id, aad, aad_utf8, dek_wrap_nonce[24], wrapped_dek,
pack_nonce[24], ciphertext
```

`PackAad` 的规范 JSON 字段序固定为：

```text
agent_id, compartment, device_id, epoch, first_seq, last_seq,
max_hlc, min_hlc, padded_len, uncompressed_blake3, v
```

封包流程：

1. 明文按 `core` / `external_channel` 物理分包；
2. `zstd` 压缩，`windowLog <= 20`（1 MiB），解压上限 16 MiB；
3. 生成 `u32_be(compressed_len) || zstd_bytes || 0x00...`，长度向上取到 `>= 256` 的 2 的幂；
4. `padded_len` 写入 AAD；AAD 的 UTF-8 字节作为 AEAD 关联数据；
5. 随机 `PerPackDEK`，用 `EpochKey[e]` 经 X-Wing HPKE 封装；
6. `XChaCha20-Poly1305` 加密分桶明文。

解包时任何长度、分桶、AAD、摘要不一致都返回 `INTEGRITY_VIOLATION`，不做部分恢复。

## 5. Hub REST 端点

默认监听 `127.0.0.1:8443`（`QUETZALCOATL_HUB_ADDR`）。生产部署应成对设置
`QUETZALCOATL_HUB_TLS_CERT_FILE` 与 `QUETZALCOATL_HUB_TLS_KEY_FILE`；未设置时以明文 HTTP
启动，仅适合回环开发。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 存活探针（免认证） |
| `POST` | `/v1/auth/passkey/register/begin` | WebAuthn 注册挑战 |
| `POST` | `/v1/auth/passkey/register/finish` | WebAuthn 注册完成 |
| `POST` | `/v1/auth/passkey/login/begin` | WebAuthn 登录挑战 |
| `POST` | `/v1/auth/passkey/login/finish` | WebAuthn 登录完成 |
| `POST` | `/v1/pair/initiate` | 发起配对，返回 `pairing_id` / `short_code` / `expires_at_ms` |
| `POST` | `/v1/pair/join` | 新设备提交 Ed25519 + X-Wing(1216 B) 公钥 |
| `GET` | `/v1/pair/{pairing_id}` | 查询配对状态 |
| `POST` | `/v1/pair/approve` | 现有设备批准 |
| `POST` | `/v1/pair/complete` | 完成配对并下发纪元密钥封装 |
| `POST` | `/v1/auth/guardian/setup` | 监护人恢复配置 |
| `POST` | `/v1/auth/guardian/recover/request` | 发起监护人恢复 |
| `POST` | `/v1/auth/guardian/recover/approve` | 监护人批准 |
| `GET` | `/v1/auth/guardian/recover/{recovery_id}` | 查询恢复状态 |
| `POST` | `/v1/auth/opaque/register/init` | OPAQUE 注册初始化 |
| `POST` | `/v1/auth/opaque/register/finish` | OPAQUE 注册完成 |
| `POST` | `/v1/auth/opaque/login/start` | OPAQUE 登录开始 |
| `POST` | `/v1/auth/opaque/login/finish` | OPAQUE 登录完成 |
| `POST` | `/v1/auth/oidc/begin` | OIDC 登录开始 |
| `POST` | `/v1/auth/oidc/callback` | OIDC 回调 |
| `POST` | `/v1/auth/events` | 认证事件 webhook |
| `PUT` | `/v1/auth/slots/{agent_id}/hardware_local` | 写入硬件本地根密钥槽 |
| `PUT` | `/v1/auth/slots/{agent_id}/channel_ingress` | 写入通道入站密钥槽 |
| `GET` | `/v1/auth/slots/{agent_id}` | 列出密钥槽 |
| `POST` | `/v1/auth/devices` | 登记设备 |
| `GET` | `/v1/auth/devices/{agent_id}` | 列出设备 |
| `POST` | `/v1/lease/acquire` | 获取写租约与 `witness_epoch` |
| `POST` | `/v1/lease/renew` | 续租 |
| `POST` | `/v1/lease/release` | 释放 |
| `POST` | `/v1/spine/{agent_id}/packs/presign` | 获取 Presigned `PUT`（含 `content_length` / `sha256_hex`） |
| `POST` | `/v1/spine/{agent_id}/packs/commit` | 提交已上传 Packfile 元数据 |
| `GET` | `/v1/spine/{agent_id}/packs` | 列出可下载 Packfile |
| `POST` | `/v1/groups` | 创建群房间 |
| `GET` | `/v1/groups` | 列出群房间 |
| `POST` | `/v1/groups/{group_id}/members` | 添加成员 |
| `GET` | `/v1/groups/{group_id}/members` | 列出成员 |
| `DELETE` | `/v1/groups/{group_id}/members/{agent_id}` | 移除成员 |
| `POST` | `/v1/groups/{group_id}/commits` | 追加群提交 |
| `GET` | `/v1/groups/{group_id}/commits` | 按序拉取群提交 |
| `POST` | `/v1/webhook/{agent_id}/{channel}` | 零知识 webhook 入站 |
| `GET` | `/v1/webhook/{agent_id}/ingress` | 拉取已密封入站队列 |
| `POST` | `/v1/webhook/{agent_id}/ingress/ack` | 确认消费 |
| `GET` | `/v1/webhook/{agent_id}/status` | 队列状态 |
| `PUT` | `/v1/blobs/put/{upload_id}` | 分片上传 |
| `GET` | `/v1/blobs/get/{blob_key...}` | 分片下载 |
| `GET` | `/v1/meta` | 公开的元信息：服务端版本、最低客户端版本、公告（见 §7） |
| `GET` | `/metrics` | 运行指标，仅限管理员（见 §7） |

`/v1/lease/*` 请求体字段：`agent_id`、`device_id`、`expected_epoch`（acquire）、
`witness_epoch`（renew/release）、`ttl_ms`。纪元落后返回 `STALE_LEASE_EPOCH`。

## 6. 中继与 QAD

- **中继**：`GET /relay` 的 WebSocket 升级；`iroh-relay-v2` 混合帧：
  - `0..=3`：`postcard`/ULEB128 握手帧；
  - `4..=13`：原始二进制数据/控制帧。
  反代导致 TLS Exporter 不匹配时优雅回退 `ServerChallenge`。
- **延迟探针**：`GET /ping`、`GET /generate_204`（免认证、无正文）。
- **QAD**：UDP `:7842`（`QUETZALCOATL_HUB_QAD_ADDR` 可覆写），ALPN `/iroh-qad/0`。
  `iroh 1.x` 已移除 STUN，公网反射地址发现完全依赖该响应器。
- **对象存储**：统一使用 S3 兼容 Presigned `PUT`（Cloudflare R2 / MinIO / AWS S3），签名覆盖
  `Content-Length` 与 `sha256`；不使用兼容性差的 `PresignedPostPolicy`。

## 7. 运行指标与元信息

Hub 看不到内容（这是设计），所以它的管理面只有运行状况，由 `hub/internal/ops` 提供：

- **`GET /v1/meta`**：公开、无需鉴权，返回 `server_version`、`min_client_version`、`announcement`
  与 `server_time_ms`。`min_client_version` 来自 `QUETZALCOATL_HUB_MIN_CLIENT_VERSION`（空表示
  不设门槛），`announcement` 来自 `QUETZALCOATL_HUB_ANNOUNCEMENT`。客户端据此提示升级，并在低于
  最低版本时停止同步。
- **`GET /metrics`**：Prometheus 文本格式，指标前缀 `quetzalcoatl_hub_`：账户与 Agent 数量、
  已存密文包数量与字节数、配额、当前中继连接数与累计转发量、地址发现请求数、入站队列深度、
  持有租约的 Agent 数。**不输出任何账户、Agent 或设备标识。** 配置了
  `QUETZALCOATL_HUB_METRICS_TOKEN` 时要求 `Authorization: Bearer`；没有配置时只接受不带转发头的
  回环请求，其余一律 `404`。

Hub 不提供模型代理：模型调用永远发生在用户自己的宿主里。

## 8. 群组提交协议

Hub 端 `POST /v1/groups/{group_id}/commits` 请求体：

```json
{
  "mls_epoch": 12,
  "causal_parent_seq": 40,
  "sender_agent_id": "uuid",
  "sender_device_id": "uuid",
  "mentions": [{"kind": "addressee", "target_agent_id": "uuid"}],
  "ciphertext_b64": "base64",
  "kind": "message",
  "author_kind": "agent",
  "reencrypt_only": false
}
```

`kind` 允许值：`message`、`constraint_update`、`cancel`、`steer`、`question`、`chatter`、
`reaction`、`mls_commit`。`author_kind` 仅 `human` / `agent`。

规则：

1. **两层屏障**：Hub 校验 `mls_epoch`；仅纪元轮换导致的不匹配允许用 `GroupEpochKey[e+1]` 重加密
   同一密文重发（`reencrypt_only = true`），不重跑模型。Router 侧再判
   `(last_seen_group_seq, head_seq]` 是否含点名、`@agents`、约束/打断或同父实质追问；无关闲聊
   快进并附挂 `causal_parent_seq`。
2. **Agent 接力上限 3**：`author_kind = agent` 且非 `mls_commit` 时 `hop = parent.hop + 1`，
   超过 3 返回 `409 FLOOR_SILENCED`。`mls_commit` 不计 hop，避免群状态同步触发熔断。
3. **非法父序**：`causal_parent_seq` 不存在返回 `400 INVALID_ID`。
4. **身份绑定**：`sender_agent_id` / `sender_device_id` 必须等于认证主体，否则
   `403 PERMISSION_DENIED`。
5. **隔离（quarantine）语义**：本版本没有独立"隔离表"服务端，隔离由三条既有机制承担——
   ①脊柱未来时钟事件直接拒收（`CLOCK_DRIFT_EXCEEDED`）；②群纪元失配只允许重加密、不允许旧密文
   提交；③语义水位线冲突返回 `WATERMARK_CONFLICT` 并要求重读，绝不静默覆盖。被逐成员移除后，
   `StewardGrant` 立即吊销并轮换 `EpochKey[e+1]`。
6. **群聊非主人降权**：入站消息在 Agent 侧包裹为 `<group_room_context authority="UNTRUSTED">`，
   只计 `S8`；未验证主人设备签名的提案不得写 `> MEMORY` 的权威段。

## 9. 设备配对与纪元

1. 已认证设备 `POST /v1/pair/initiate` → `pairing_id` + 8 字符 `short_code`（`XXXX-XXXX`，
   字符集排除易混字符）+ 过期时间。
2. 新设备 `POST /v1/pair/join`，提交 `device_id`、32 字节 Ed25519 公钥、1216 字节 X-Wing 公钥。
3. 现有设备 `POST /v1/pair/approve`。
4. 新设备 `POST /v1/pair/complete`（附新设备对 `quetzalcoatl/v2/pair-complete:<pairing_id>` 的签名），
   换回会话令牌与用新设备 X-Wing 公钥封存的根密钥（只能换一次）。
5. 纪元钥匙与条目钥匙走下面的封存钥匙通道：已有设备在下一次心跳时把它们逐个封存给新设备。
   新设备收齐第一个纪元的钥匙后接管同一个身份（原来的身份与脊柱挪到 `before-pairing-<时间>/`），
   同步拉下密文包，再随条目钥匙的到达重放出同一片海。
6. `short_code` 只存 HMAC（`HMAC-SHA256("quetzalcoatl/v2/pairing-code:" || pairing_id || ":" ||
   CODE)`），有尝试次数上限，超限 `429 CREDENTIAL_REJECTED`。
7. **纪元轮换**：设备吊销、成员移除或群成员变更后，立即生成 `EpochKey[e+1]` 并以剩余设备公钥
   重新包裹；旧纪元密文不再可解。

### 9.1 封存钥匙通道

条目钥匙（每条往事一把）与纪元钥匙不进签名事件链，而是经这条可以删除的通道在设备之间传递。
每一份都在客户端用接收设备的 X-Wing 公钥封存（HPKE，`info = quetzalcoatl/v2/device-sealed-secret`，
`aad = quetzalcoatl/device-secret|<agent>|<device>|<name>`），Hub 只见密文。

| 端点 | 作用 | 谁能调用 |
| --- | --- | --- |
| `PUT /v1/keys/{agent_id}/{device_id}/{name...}` | 寄给某台设备一份 `{aad_utf8, ciphertext_hex, hpke_enc_hex}` | 该 Agent 的任一设备 |
| `GET /v1/keys/{agent_id}/{device_id}` | 取走寄给本机的全部 | 只有收件设备本身 |
| `DELETE /v1/keys/{agent_id}/{name...}` | 删掉这个名字在所有设备上的那一份（抹除时） | 该 Agent 的任一设备 |

名字：条目钥匙是 `sea.entry-key/<层>/<编号>`，纪元钥匙是 `epoch-key/<纪元>`。抹除时本机先销毁钥匙，
再删 Hub 上的所有副本（离线时排队，联网后删）；其它设备重放到这次抹除时销毁自己那一把。

## 10. 通道信封与 Webhook 入站

统一入站信封（`ChannelEnvelope`）：

```json
{
  "channel": "telegram",
  "external_id": "opaque-id",
  "sender": "opaque-sender",
  "text": "正文",
  "attachments": [{"name": "a.pdf", "mime": "application/pdf", "size_bytes": 1234, "url": null}],
  "received_at_ms": 1795400000000,
  "thread_hint": null
}
```

- 通道 ID 固定为 `feishu`、`wecom`、`dingtalk`、`telegram`、`email`、`webhook`、`system-intents`。
- 正文绝不进入 `Debug`/日志；凭据只在内存解密使用。
- 出站超限显式分片，末片带可见截断标记，绝不静默丢字。
- **Webhook 零知识入站**：Hub 只在内存验证平台 HMAC，随后用 Agent 的 `ChannelIngressKey` 做 HPKE
  密封入队；任何明文都不落盘。Agent 拉取后自行解密、ack；队列超限按配额拒绝。

## 11. 本地 IPC

- 传输：POSIX `0600` Unix Domain Socket；Windows 回退 `127.0.0.1` 回环 TCP。
- 校验：严格 `Host` 白名单（`127.0.0.1` / `localhost` / `[::1]`），拒绝任何外部 `Origin` 的写请求。
- 能力令牌：`quetzalcoatld` 为每个受管会话生成 256-bit 路径能力令牌，常量时间比较。
- 方法集合见 `crates/quetzalcoatl-daemon/src/local_ipc.rs` 的 `IpcRequest`（状态、桌面快照、
  对话、导出、`import-v1`、配对、群组、通道、SayIt、Webhook、领域包、运行钩子等）。
- 客户端只在守护进程不可达时降级；降级只允许只读能力，绝不打开主库写句柄。

## 12. 错误码

| 码 | 含义 |
| --- | --- |
| `INVALID_ID` | 标识符格式/版本非法 |
| `INTEGRITY_VIOLATION` | 密码学完整性或审计链校验失败 |
| `CLOCK_DRIFT_EXCEEDED` | HLC 超前超过 5 分钟，事件隔离拒收 |
| `HLC_COUNTER_OVERFLOW` | 单毫秒逻辑计数溢出 |
| `EPOCH_OVERFLOW` | 纪元编号溢出 |
| `STALE_LEASE_EPOCH` | 租约纪元过期（`provided < current`） |
| `PARTITION_RESTRICTED` | 断网受限租约禁止非幂等公网外发 |
| `DELIVERY_REFUSED` | 投递被内核门禁拒绝 |
| `PERMISSION_DENIED` | 能力/身份/监护人授权不足 |
| `VERIFICATION_FAILED` | 洁净室客观校验未通过 |
| `CONSCIENCE_VIOLATION` | 触碰绝对段或良知清单不一致 |
| `WATERMARK_CONFLICT` | 群组未读水位线冲突，须重读 |
| `FLOOR_SILENCED` | ANP-P9 发言门禁或 Agent 接力上限拦截 |
| `CREDENTIAL_REJECTED` | 零凭据代理或配对码拒绝 |
| `SANDBOX_VIOLATION` | 沙箱隔离边界违规 |
| `SERIALIZATION_ERROR` | JSON/长度/类型错误 |
| `STORAGE_ERROR` | 存储层失败 |

## 13. 版本与兼容

- 脊柱事件、Packfile AAD、群提交与 `spec/vectors/*.json` 中的向量是**冻结契约**；改动必须
  同步 Rust 与 Go 两侧测试。
- 领域包 schema 为 `quetzalcoatl.domain-pack.v1`，安全信封为
  `quetzalcoatl.domain-safety-envelope.v1`。
- 良知清单与指令摘要使用域分离 BLAKE3 上下文：`quetzalcoatl/v2/conscience-directive-v1`、
  `quetzalcoatl/v2/conscience-root-manifest-v1`、
  `quetzalcoatl/v2/conscience-operator-manifest-v1`、
  `quetzalcoatl/v2/conscience-operator-key-v1`。
