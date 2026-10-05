# 同步服务协议 v1

身体（运行基座、灵魂桥）与同步服务之间的接口。实现：服务端 `sync/src/`，身体端 `runtime/src/mesh/`。协议版本号为 `1`，不兼容的修改必须提升版本号。

同步服务是**目录与信令**，不是信任根：身体之间建立连接时，必须用灵魂仓库 `bodies/<身体>.json` 里登记的节点公钥核对对方（见 §4）。同步服务即使被攻破，也只能让身体连不上，不能冒充身体。

## 1. 身体的节点密钥

- 每具身体一把 **ed25519** 密钥，首次需要时在本机生成，私钥只在本机（运行基座：`QUETZAL_HOME/secrets/mesh_ed25519`，权限 0600）。
- 公钥写成 32 字节原始公钥的 base64url（43 个字符），称为 `nodeKey`。
- **指纹**：原始公钥字节的 SHA-256，取前 16 个十六进制字符，每 4 个一组用空格隔开（例如 `3f2a 9c01 77be d4e0`）。绑定时网页与身体两边各自显示，给人核对。

## 2. 绑定（OAuth 2.0 设备授权，RFC 8628 的语义）

```mermaid
sequenceDiagram
  participant B as 身体
  participant S as 同步服务
  participant U as 人（浏览器）
  B->>S: POST /v1/device/code {agent, body, kind, nodeKey, version}
  S-->>B: {device_code, user_code, verification_uri, verification_uri_complete, expires_in: 900, interval: 5}
  B->>U: 显示 user_code、链接与本机公钥指纹
  U->>S: GitHub 登录 → 网页前端的「批准设备」输入 user_code → 核对 agent、身体、指纹 → 批准（§5）
  loop 每 interval 秒
    B->>S: POST /v1/device/token {device_code}
    S-->>B: 400 {error: authorization_pending | slow_down}
  end
  S-->>B: 200 {access_token, token_type: "bearer", agent: {id, name}, body, account}
```

| 字段 | 规则 |
|---|---|
| `agent.id` | `agent.json` 的 `id`（UUID） |
| `agent.name` | 显示名，1–80 字符 |
| `body` | `^[a-z0-9][a-z0-9-]{0,39}$`，与灵魂仓库里的身体名相同 |
| `kind` | `runtime`（运行基座）或 `bridge`（灵魂桥，只读成员） |
| `nodeKey` | §1 |
| `version` | 身体的软件版本，最长 32 字符 |

- `/v1/device/token` 的错误：`authorization_pending`（还没批准）、`slow_down`（轮询太快，间隔加 5 秒）、`access_denied`（被拒绝）、`expired_token`（15 分钟过期，需要重新开始）、`invalid_grant`（设备码不存在或已经用过）。
- 令牌（`access_token`，`qsb_` 开头）只在批准后第一次轮询时生成并返回一次，服务端只存它的 SHA-256。身体把它存进自己的密钥目录（运行基座：`QUETZAL_HOME/secrets/sync.json`，0600；灵魂桥：`~/.agent-soul/<agent>/sync.json`）。
- **agent 登记按账户隔离**：`(账户, agent.id)` 唯一。agent id 不是秘密，所以不能全局唯一，否则别人知道了就能抢先占住。同一个 agent 的身体要绑定到同一个账户下，才会互相看到。
- 同一 agent 下再次绑定同名身体：新令牌生效，旧令牌立即作废，旧连接被断开。
- 限流（客户端地址见 §5.1 末尾，IPv6 按 /64 计）：每个地址 10 分钟内最多申请 10 次绑定码（含控制台登录码）、轮询 240 次；输错短码（查询与批准都算，过期的码也算输错）每个账户 10 分钟内最多 10 次、每个地址最多 30 次，用完后一律 429，命中也不给。
- `verification_uri` 指向网页前端（配置了 `SYNC_WEB_URL` 时为 `<前端>/device`，否则为同步服务自带的 `/device`）。

其他接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | `{ok, service, version, protocol, login, turn, online}` |
| GET | `/v1/me` | 请求头 `Authorization: Bearer <令牌>` → `{agent, body, kind, account}`；令牌无效为 401 |
| DELETE | `/v1/me` | 身体自己解绑：删除登记、令牌作废 |
| POST | `/v1/console/code` | 控制台登录（§5.2）：`Authorization: Bearer <身体令牌>`，可带 `X-Quetzal-Version`；返回与 `/v1/device/code` 相同的结构。只有运行基座（`kind` 为 `runtime`）能申请，灵魂桥为 403 `runtime_only` |

## 3. 信令：WebSocket `/v1/ws`

- 地址：`wss://<域名>/v1/ws`。连接建立后 10 秒内必须先发 `hello`，否则断开。`hello` 之前只接受这一条消息：格式不对（不是 JSON、不符合下表）断开（4400），是别的消息断开（4401）。
- 握手前按客户端地址限制：同一地址（IPv6 按 /64）同时最多 20 条连接、每分钟最多 60 次握手，超出时握手直接得到 HTTP 429。
- 每条消息是一个 JSON 文本帧，最大 64 KiB，嵌套最多 33 层（即 `signal.data` 最多 32 层）；不支持二进制帧；不协商压缩。
- 服务端每 30 秒发一次 WebSocket ping，没有回 pong 就断开。身体可以发 `{"t":"ping"}` 测量往返时间，服务端回 `{"t":"pong","now":<毫秒>}`。
- 每条连接 10 秒内最多 200 条消息、合计 512 KiB，超出的消息丢弃并回 `{"t":"error","code":"rate_limited"}`。
- 发给一条连接、它还没读走的数据超过 1 MiB 时，服务端不再排队，以 4408 断开它（重连后 `welcome` 会带回完整的在场）。

### 3.1 身体 → 服务

| 消息 | 说明 |
|---|---|
| `{"t":"hello","token","protocol":1,"version","agentName"?}` | 认证。`token` 为 `qsb_` 开头的身体令牌；`version` 最长 32 字符；`agentName` 1–80 字符，不含控制字符，只有运行基座发来时才更新登记的显示名（灵魂桥的忽略） |
| `{"t":"signal","to"?,"id"?,"data"}` | 转发给同一 agent 的另一具在线身体（`to`，身体名规则同 §2），省略 `to` 则发给所有在线的其他身体。`id` 为 1–64 个可见 ASCII 字符。`data` 必须是 JSON 对象（最多 32 层），服务端不解读内容 |
| `{"t":"turn"}` | 刷新 TURN 凭据（凭据到期前调用）；每条连接每分钟最多一次（`welcome` 也算一次），超出回 `rate_limited` |
| `{"t":"ping"}` | 测往返 |

### 3.2 服务 → 身体

| 消息 | 说明 |
|---|---|
| `{"t":"welcome","protocol","now","agent":{id,name},"body","account","peers":[Peer],"iceServers","ttl"}` | 认证成功。`now` 是服务端时钟，可用于估计时钟偏差 |
| `{"t":"peer","peer":Peer}` | 另一具身体上线、下线或重新绑定 |
| `{"t":"peer.removed","body"}` | 另一具身体被解绑 |
| `{"t":"signal","from","id"?,"data"}` | 来自另一具身体的信令 |
| `{"t":"turn","iceServers","ttl"}` | 新的 TURN 凭据 |
| `{"t":"error","code",…}` | `bad_message`（认证后的坏消息，连接保留）、`rate_limited`、`offline`（`to` 不在线，带回 `to` 与 `id`）、`unauthorized`、`protocol`（带 `supported`）、`already_hello` |
| `{"t":"bye","reason"}` | 即将断开：`replaced`（同一身体的新连接顶替了这条）、`revoked`（被解绑） |

`Peer = {body, kind, nodeKey, version, online, lastSeen}`。

`iceServers` 的格式与 WebRTC 的 `RTCIceServer` 相同：`[{urls: ["stun:…"]}, {urls: ["turn:…?transport=udp", "turn:…?transport=tcp"], username, credential}]`。TURN 凭据采用 coturn 的 `use-auth-secret`：`username = "<到期 Unix 秒>:<标识>"`，`credential = base64(HMAC-SHA1(共享密钥, username))`，默认 1 小时有效。`<标识>` 是每具身体固定的不透明值（共享密钥派生的 HMAC，22 个 base64url 字符），不含 agent id 与身体名；coturn 的每用户配额按它计。服务端按身体缓存凭据：剩余有效期过半之前（重连、刷新）发的是同一个，`ttl` 是**剩余**秒数。

WebSocket 关闭码：`4400` 帧格式错误（含 hello 之前的坏消息）、`4401` 未认证或认证失败、`4403` 被解绑、`4408` 接收太慢（积压超过 1 MiB）、`4409` 被顶替、`4426` 协议版本不符、`1001` 服务关闭、`1011` 服务端处理这条连接时出错。

## 4. 身体之间：WebRTC 数据通道

服务端不参与这一层，这里只是约定：

- 两具身体用 WebRTC 建立连接：ICE 负责穿透（局域网、IPv6、STUN 反射地址，打不通时由 TURN 中转），DTLS 负责加密，SCTP 数据通道负责可靠有序传输。运行基座用 `node-datachannel`（libdatachannel）。
- **信令内容由身体签名**：`signal.data` 是信封 `{v: 2, agent, from, to, ts, nonce, body, sig}`（`body` 里是 SDP 或 ICE 候选），`sig` 是发送方节点私钥对规范化 JSON（不含 `sig`）的 ed25519 签名。`v` 是身体之间的协议版本（1.0.3 起为 2，与 1 不兼容，同一个 agent 的身体要一起升级），`agent` 是 agent id（防止同一把节点密钥登记在两个灵魂仓库时跨 agent 重放）。接收方：
  1. 用**灵魂仓库**里 `bodies/<from>.json` 的 `meshKey` 验证签名（不信任同步服务给的 `nodeKey`，两者不一致就拒绝并提醒）；首次见到的公钥与类型钉在本机（`data/mesh-pins.json`），之后变了就不连，直到在控制台确认；
  2. 检查 `v`、`agent` 与自己一致，`to` 是自己，`ts` 在 ±5 分钟内且不早于本进程启动前 1 分钟，`nonce` 没有见过（防重放）。
- SDP 里的 DTLS 证书指纹因此由节点密钥担保：中转者或同步服务无法插入中间人。数据通道打开后，双方再用节点密钥对 DTLS 指纹（连同 agent id）做一次挑战与应答，确认通道两端就是签名的两方。
- 经 TURN 中转的流量本身就是 DTLS 加密的，中转服务器看不到内容。

## 5. 账户接口：`/v1/web/*`

给人看的页面（登录、账户、批准设备）都在网页前端（`SYNC_WEB_URL`，官方部署为 https://quetzal.plutokeating.beer），同步服务只提供接口；App（控制台）经运行基座用同一套接口。没有配置 `SYNC_WEB_URL` 时，同步服务退回自带的简单页面（`/`、`/account`、`/device`）；配置了时这些地址一律跳到前端。

### 5.1 登录与身份

- **网页前端**：`GET /login?return_to=<前端上的地址>` 经 GitHub 登录（授权码 + PKCE S256；`state`、`code_verifier` 与回跳地址放在 10 分钟的 `__Host-` 临时 Cookie 里），回到 `return_to`（只接受前端同源的地址，否则回到 `<前端>/account`；失败回到 `<前端>/account?login=failed`）。会话是同步服务自己的 Cookie（`__Host-quetzal_session`，HttpOnly、Secure、SameSite=Lax）；前端与同步服务必须同站（同一个可注册域名），用 `fetch(…, {credentials: "include"})` 调用。
- **会话寿命**：网页会话 `SYNC_SESSION_DAYS`（默认 30）天、控制台登录 30 天，剩余不到一半时随使用续期；无论怎么续，自创建起最长 90 天，到时须重新登录。
- **控制台**：`Authorization: Bearer qsc_…`（§5.2），只认控制台登录的会话；身体令牌与网页会话的 Cookie 都不能当它用，它也不能当身体令牌或 Cookie 用。
- **CORS**：只对 `SYNC_WEB_URL` 与同步服务自己的源放行带凭据的请求（`GET`、`POST`，头 `Content-Type`）。所有响应都带 `Vary: Origin`。
- **改动请求**：`POST`，`Content-Type: application/json`（跨源时必先预检）；用 Cookie 时必须带 `Origin` 且是上面两个源之一，否则 403。响应都带 `Cache-Control: no-store`。

| 方法 | 路径 | 请求体 | 返回 |
|---|---|---|---|
| GET | `/v1/web/session` | — | `{loginEnabled, user: {login, name} \| null}` |
| GET | `/v1/web/account` | — | `{user, limits: {agents, bodies}, agents: [{id, name, created, bodies: [{body, kind, version, created, lastSeen, online, fingerprint}]}], consoles: [{id, body, created, lastUsed, current}]}`；没登录 401 |
| POST | `/v1/web/device/lookup` | `{code}` | 待批准的码，见下；错误 `bad_code`（404：不存在或已过期，二者不区分；计入输错次数）、`too_many`（429：输错次数用完，命中也返回它）、`decided` / `too_many_agents` / `too_many_bodies` / `not_yours`（409） |
| POST | `/v1/web/device/decide` | `{code, approve}` | `{ok, approved}`；错误同上（同样计入输错次数）；请求体不对为 400 `bad_request` |
| POST | `/v1/web/bodies/remove` | `{agent, body}` | 解绑一具身体（立即断开）；不是你的或不存在为 404 |
| POST | `/v1/web/agents/remove` | `{agent}` | 删除一个 agent 与它的所有身体 |
| POST | `/v1/web/consoles/revoke` | `{id}` | 吊销一个控制台登录（`id` 为 `consoles[].id`） |
| POST | `/v1/web/sessions/revoke-all` | `{}` | 在所有设备上退出网页登录：作废这个账户的**全部**网页会话（包括发出请求的这一个，并清除它的 Cookie）；控制台登录不受影响。返回 `{ok, revoked}`（作废的个数） |
| POST | `/v1/web/logout` | `{}` | 网页：清除 Cookie 会话；控制台：作废它自己的令牌 |
| POST | `/v1/web/account/delete` | `{confirm: true}` | 删除账户（级联删除会话、agent、身体、设备码，所有连接断开） |

`/v1/web/device/lookup` 的返回：

```jsonc
{
  "code": "BCDF-GHJK",
  "agent": { "id": "<uuid>", "name": "…" },
  "body": "honor9",                 // 要绑定的身体；控制台登录时为发起它的那具身体
  "kind": "runtime",                // runtime | bridge | console
  "version": "1.0.1",
  "fingerprint": "3f2a 9c01 77be d4e0", // 节点公钥指纹（§1）；控制台登录时为发起它的那具身体的指纹
  "replaces": false,                // 同名身体已存在，批准后旧绑定作废
  "newAgent": false,                // 这个 agent 第一次绑定到这个账户
  "createdAt": 1790000000000,       // 码的申请时间（毫秒）
  "expires": 1790000900000,         // 码的到期时间（毫秒）
  // 只在 kind 为 console 时：
  "bodyFingerprint": "3f2a 9c01 77be d4e0", // 发起它的那具已绑定身体的节点公钥指纹（与 fingerprint 相同），请与那具身体控制台上显示的核对
  "bodyBoundAt": 1789000000000      // 那具身体的绑定时间（毫秒）
}
```

配置了 `SYNC_WEB_URL` 时，同步服务自带网页的表单 POST（`/device`、`/device/decide`、`/account/*`）一律 303 跳到网页前端，不做任何改动。

客户端地址（只用于内存里的限流，不写库、不写日志）：同步服务在反向代理后面（`SYNC_TRUST_PROXY`）时先取 `CF-Connecting-IP`，没有时取 `X-Forwarded-For` 的最右一项；IPv6 按 /64 聚合。

### 5.2 控制台登录

App 只和自己的运行基座通信，没有浏览器 Cookie；身体令牌只代表这具身体。要在 App 里管理账户，运行基座代它申请一次控制台登录：

```mermaid
sequenceDiagram
  participant A as App（控制台）
  participant B as 运行基座
  participant S as 同步服务
  participant U as 人（网页前端）
  A->>B: account.signIn
  B->>S: POST /v1/console/code（Bearer 身体令牌）
  S-->>B: {device_code, user_code, verification_uri_complete, …}
  B-->>A: 码与链接
  U->>S: 批准设备：输入码 → 页面写明「这是控制台登录，批准后能管理整个账户」→ 批准
  B->>S: POST /v1/device/token {device_code}
  S-->>B: 200 {access_token: "qsc_…", kind: "console", account, expires_in}
  A->>B: account.get / account.removeBody …
  B->>S: /v1/web/*（Bearer qsc_…）
```

- 只有已绑定的**运行基座**能申请（请求要带身体令牌；灵魂桥为 403），且**只有这具身体所在账户的主人能批准**（别的账户批准时为 `not_yours`）：别人骗你批准，也得先控制你的一具身体。确认时网页给出这具身体的真实公钥指纹（`bodyFingerprint`）与绑定时间（`bodyBoundAt`），供人与那具身体控制台上显示的核对。
- 申请之后这具身体被解绑、或同名重新绑定（公钥或绑定时间变了），这个码就不能再批准（`not_yours`），批准过的也拿不到令牌（`access_denied`）。
- 令牌 `qsc_` 开头，256 位随机数，库里只存 SHA-256；有效期 30 天，滑动续期，自创建起最长 90 天；`last_used` 记录最近使用。运行基座存进 `secrets/sync-account.json`（0600）。在网页或任何 App 的「控制台登录」里可以吊销，立即失效；发起它的身体被解绑（网页解绑、`DELETE /v1/me`、同名重新绑定、删除 agent、删除账户）时也一并作废。运行基座遇到 401 就删除本地令牌、回到未登录。

