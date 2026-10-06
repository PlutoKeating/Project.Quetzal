# 接口

Quetzal 对外有两类接口：**网关 API**（控制台、主机工具使用）和**身体适配器接口**（设备仓库实现）。

## 1. 网关

两个监听，共用同一套接口：

| 监听 | 地址 | 协议 | 用途 |
|---|---|---|---|
| 本机 | `127.0.0.1:<gateway.port>`（默认 7788），另加 `[::1]` 同一端口（有 IPv6 时） | 明文 HTTP / WebSocket | 同一台机器上的控制台（App 内置的运行基座与同一个 App、本机的网页控制台、命令行）。永远只在回环地址上，不出这台机器 |
| 局域网 | `<gateway.host>:<gateway.lanPort>`（默认 7789；`host` 是回环地址时为 `0.0.0.0`） | HTTPS / WSS（TLS 1.2 起） | 别的设备。只在对局域网开放时启动：`gateway.lan` 为真，或 `gateway.host` 不是回环地址（兼容旧配置：`host` 为 `0.0.0.0` 即开放；`npx @plutokeating/quetzal --lan` 两项都写） |

局域网上不再有明文 HTTP：旧配置 `host: 0.0.0.0` 升级后明文只留在 `127.0.0.1`，局域网改走 `lanPort` 的 HTTPS。

**证书**：运行基座第一次启动时生成自签名证书——ECDSA P-256，`CN=quetzal-<身体名>`，不带 SAN，10 年有效——私钥 `secrets/gateway-tls.key`（0600）、证书 `secrets/gateway-tls.crt`（`runtime/src/tls.ts`）。每次启动核对（能解析、私钥与证书配对、自签名验证通过、没过期），不合格就重新生成（指纹随之改变，已配对的控制台需要重新配对）。**指纹** = SHA-256（证书 DER）的小写十六进制（64 位）；**短格式**为前 16 位、4 位一组（`1a2b 3c4d 5e6f 7a8b`），出现在配对通知、服务日志与 `quetzal status` 里。没有 CA：原生控制台（安卓、Linux 桌面）与 App 的耳朵**钉住**这个指纹（只认这张证书，不看 CA 与主机名）；网页版由浏览器处理证书，人在浏览器的证书警告页上核对指纹。

**风险与做法**：令牌与对话在局域网上都经 TLS 加密；配对时配对码不上网络（见 `/pair/finish` 的配对证明），中间人换了证书就配不上，配对之后钉住的指纹挡住换证书的中间人。剩下要人做的是**核对指纹**：原生控制台在配对页显示握手时看到的指纹，网页版在浏览器的证书警告页上看，都应与运行基座那台机器上的配对通知（或 `quetzal status`）一致。更保守的做法仍是只监听本机、从别的机器用 ssh 隧道连：`ssh -N -L 7788:127.0.0.1:7788 <用户>@<这台机器>`，然后连 `127.0.0.1:7788`（经隧道来的连接对网关来说就是本机连接）。怀疑令牌泄露时用 `gateway.rotateToken` 换一个。

**令牌的传法**：HTTP 接口用请求头 `Authorization: Bearer <令牌>` 或 `X-Quetzal-Token: <令牌>`；WebSocket 连上 `/rpc` 后第一条消息发 `{"auth": "<令牌>"}`（5 秒内，不对或超时以关闭码 4401 断开，通过后才收到 `hello`）。旧式的查询参数 `?token=` 仍然接受（兼容旧控制台），但它会出现在代理与浏览器历史里，新客户端不要再用。

`main.cjs` 旁边有 `web/index.html`（npm 安装器放的网页控制台；或环境变量 `QUETZAL_WEB_DIR` 指定）时，网关同时托管这些静态文件：`GET /` 就是控制台。

### 1.1 HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, safeMode, mode}`，无需令牌，供点火器探活 |
| GET | `/auth/local` | `{ok, token}`：只给**同一台机器上打开着网关自己托管的网页控制台的浏览器**，打开即登录（只在本机明文监听上，HTTPS 监听上一律 403）。条件：网关托管着网页控制台（`web/` 存在）、不是安卓（安卓上别的应用也能连 127.0.0.1）；连接来自回环地址、Host 是本机名；**必须**带 `Origin` 且正好是网关自己的源（`http://127.0.0.1:<端口>`、`http://localhost:<端口>`、`http://[::1]:<端口>`；开发时别的源只能由环境变量 `QUETZAL_DEV_ORIGINS`（逗号分隔）明确列出），CORS 只对这个 Origin 放行；发起连接的进程不是运行基座的子孙（agent 的命令、后台任务、自造工具都是，Linux 上读 `/proc` 判断）。其他情况 403。注意：本机进程并不都读得到 `secrets/gateway.token`——agent 的命令在沙箱里读不到它（ARCHITECTURE §8.1），安卓上别的应用也读不到；`Origin` 头命令行程序能伪造，所以挡 agent 的是子孙进程检查与沙箱。ssh 隧道转发来的连接也算本机 |
| GET | `/<静态文件>` | 网页控制台（`web/` 目录存在时）：`/` → `index.html`，没有扩展名的未知路径也回退到 `index.html`（单页应用），带 ETag |
| GET | `/pair/info` | `{ok, fingerprint, short, body, version, tls: true}`，无需令牌：网关证书的指纹（完整与短格式）、身体名、版本。控制台配对的第一步：原生控制台以「捕获」方式握手，记下自己看到的指纹并显示给人核对；网页版用这里报告的指纹。两个监听上都有（回环上报告的也是 TLS 证书的指纹）。Host 检查同配对接口 |
| POST | `/pair/start` | 生成 8 位配对码（字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，密码学随机，通知里显示为 `控制台配对码 ABCD-EFGH · 证书指纹 1a2b 3c4d 5e6f 7a8b（5 分钟内有效）`；5 分钟有效），通过适配器的系统通知与飞书下发 → `{ok, expires}`。码还有效时再请求不换新码、不清零尝试次数（30 秒后可以再提醒一次）。Linux 适配器有桌面通知时服务日志里只记「控制台配对」，没有桌面的机器才把配对码写进日志 |
| POST | `/pair/finish` | `{proof}` 或 `{code}` → `{ok, token, fingerprint}`。**配对证明** `proof` = hex(PBKDF2-HMAC-SHA256(密码 = 规范化的配对码, 盐 = `"quetzal-pair-v2\|" + 指纹`, 迭代 100000, 32 字节))，小写十六进制 64 位（服务端比较时不区分大小写）；配对码规范化：转大写、去掉空白与连字符；指纹为客户端在 TLS 握手中看到的证书指纹（小写十六进制）、字符串按 UTF-8 编码。服务端用自己的证书指纹与当前有效的配对码算出同样的值（生成配对码时算好），定长比较。**HTTPS 监听上只收 `proof`**（带 `code` 或缺 `proof` 回 400，不计入尝试次数）：配对码不上网络，中间人看到的是自己的证书，转给运行基座的证明对不上。**回环明文监听上收 `{code}`**（同一台机器、旧控制台）也收 `proof`（指纹为 TLS 证书的）。成功时回报 `fingerprint`，客户端核对它等于自己握手时看到的。已知向量：配对码 `ABCDEFGH`、指纹 64 个 `0` → `23473714b2a61fbc2a61de0a7636402e197af0b3fe1ee19be90503518e30e4df`。错误码 403（不正确）、410（失效，或这个码已试过 5 次）、429（累计失败超过 5 次后全局锁定，按 30 秒 × 2^(n−6) 退避，最长 1 小时，`retryAfter` 为秒数；成功一次清零）、413（请求体超过 16 KB）。配对接口（`/pair/info`、`/pair/start`、`/pair/finish`）都检查 Host（防 DNS 重绑定）：回环连接只认本机名；局域网连接认 IP 字面量、`gateway.host` 与环境变量 `QUETZAL_GATEWAY_HOSTS`（逗号分隔，如 `mybox.local`）列出的名字 |
| GET | `/media/<文件名>`（令牌见上） | 她的声音：控制台 App 取合成语音（`data/media/` 里的音频文件）来播放，见 `speak` 事件 |
| POST | `/hear?started=<毫秒时刻>[&stream=1&id=<标识>&bargein=1]`（令牌见上） | 听觉。`bargein=1`：这句话打断了她的播放（App 本地已停播），以「打断」并入。`stream=1`：请求体为边说边送的 16 kHz 单声道 16 位 PCM（分块传输），基座用官方 SDK 流式识别，中间结果经 `hearing` 事件推送；否则请求体为一整句 WAV（最多 4 MiB）一次识别。→ `{ok, id, text, conv?, dropped?}`；`started` 为这句话开始的时刻，用于判断是不是她自己在说话（丢弃）。识别后以「环境声音」进入会话，见 §1.3 听觉 |
| POST | `/upload?name=<文件名>`（令牌见上） | 上传一个附件，请求体为文件内容（单个最多 50 MiB）→ `{ok, file: {id, name, path, rel, mime, size, kind: image｜text｜file}}`；保存在 `QUETZAL_HOME/data/uploads/<日期>/` |
| GET | `/uploads/<rel>`（令牌见上） | 下载附件（控制台预览图片）；只能访问 uploads 目录内的文件：路径本身是符号链接的、跟随链接后出了 uploads 的都是 404 |

### 1.2 WebSocket `/rpc`

- 认证：连上后第一条消息 `{"auth": "<令牌>"}`（5 秒内）；或旧式的 `/rpc?token=<令牌>`。单条消息最多 4 MiB。
- 请求：`{"id": 1, "method": "status", "params": {}}`
- 响应：`{"id": 1, "result": …}` 或 `{"id": 1, "error": {"code", "message"}}`
- 推送：`{"event": "<名称>", "data": …}`

| 推送事件 | 数据 |
|---|---|
| `hello` | `{version, safeMode}`，连接建立时 |
| `state` | 与 `status` 相同的完整状态（去抖 500ms） |
| `timeline` | 新的时间线条目 `{id, ts, kind, title, detail}`（`kind` 含 `soul`：灵魂同步知觉） |
| `approval` | 审批 `{id, action, reason, args, status}` |
| `say` | Quetzal 主动说的话（字符串） |
| `activity` | 进展 `{session, conv, origin: chat｜think｜dream, channel, ts, body, kind, …}`：`session` 为这一轮，`conv` 为所属会话（醒来为空），`body` 为这一轮在哪具身体上（多具身体时，其他身体上进行的轮次也经同一事件推送），见下表 |
| `secret` | 保密输入（`pass_secret`）的状态 `{id, conv, channel, status: open｜progress｜done｜cancelled｜expired, purpose, items: [{name, hint}], got, spell, expires}`：`got` 为已收到（结束时为已保存）的项数，`spell` 为结束口令；永远不含值 |
| `hearing` | 听觉 `{id, status: partial｜final｜dropped｜kept｜ignored, text, conv?, reason?}`：`partial` 识别中的文字（流式显示）；`final` 识别完成并进入会话 `conv`；`dropped` 没进会话（太短、没听清、她自己在说话、没在听；多具身体时另一只耳朵也听到了同一句话、由那边交给她）；`kept` 她回应了（保留显示）；`ignored` 她判断不是对她说的（这条消息的 `mode` 标为 `ignored`，控制台隐藏） |
| `speaking` | `{until}`：她在说话（`voice_speak`、试听）到 `until`（毫秒时刻，按码率估计）为止；App 回报播完或被插嘴时 `until` 提前到现在再推一次。只给界面用 |
| `session.switch` | `{from, to, title, done?}`：她用 `session_new` 把对话切到了新会话；控制台把打开的会话页切过去；`done` 为真表示她这一轮的回复已放进新会话 |
| `speak` | `{id, url, text, ms}`：让控制台 App 播放一段合成语音（`url` 为 `/media/<文件名>`，走通话音频路径，耳朵的回声消除以它为参考）；App 播完或被插嘴后调用 `player.done` |
| `mesh` | 网状层状态（同 `mesh` 方法的返回），绑定进展、同步服务连接、各身体的连接与路径变化时推送 |
| `account` | 账户的控制台登录状态（同 `account` 方法的返回）：申请码、批准、退出、令牌失效时推送 |
| `replica` | `{table: messages｜sessions｜message.mode, from, convs}`：从其他身体复制来的对话或会话已写入本机（`convs` 为涉及的会话），控制台据此刷新会话列表与打开的对话。时间线条目照常经 `timeline` 推送（带 `body`） |
| `feishu.qr` / `feishu.registered` / `feishu.error` | 飞书一键接入流程 |

`activity` 的 `kind`：

| kind | 字段 | 含义 |
|---|---|---|
| `start` / `queued` | `text?`, `msg?`, `ambient?` | 这一轮开始（`msg` 为这句话在对话记录里的 id；`ambient` 为真表示由环境声音触发）/ 排在同一会话前一轮之后 |
| `steer` | `text, msg, mode: steer｜interrupt` | 她工作时对方发来的消息已并入这一轮（进行中的卡片挂到这句话下面） |
| `step` | `step` | 第几次模型调用开始 |
| `delta` | `text` | 流式文字片段（约每 200ms 合并一次） |
| `text` | `step, text, final` | 该步的完整文字；`final` 为真表示这就是回复（不再调用工具） |
| `tool` | `call, name, summary, status: running｜ok｜error｜denied, ms?, result?` | 工具执行中 / 执行后（同一 `call` 先后两条），`summary` 为一行参数摘要 |
| `alive` | — | 心跳，会话存续期间每 15 秒一次 |
| `done` / `error` | `reply?` / `message, reply?` | 结束；回复与执行过程已写入对话记录 |

进行中的每一轮同时保存为快照（`sessions.live`）：客户端断线重连、从后台切回时据此完整恢复，然后继续接收增量事件。

### 1.3 方法

操作者（actor）统一记为「控制台」，所有修改类操作写入审计。

**观察**

| 方法 | 参数 | 返回 |
|---|---|---|
| `status` | — | `{agent, version, body, adapter, heart, physical, stopped, paused, activity, usage, budget, approvals, soul, models, thought, hearing, mesh, sandbox}`；`sandbox` 为 agent 命令的沙箱 `{kind: bwrap｜landlock｜proot｜none, hidden[], readonly[], note, allowUnsandboxed}`（`none` 时她的命令缺省一律不执行，`allowUnsandboxed` 为真时才不隔离执行；控制台应提示重新运行安装命令补上沙箱，见 ARCHITECTURE §8.1）；`thought` 为她想分享的一句话 `{text, ts}` 或 `null`，由她用 `share_thought` 维护，更新时推送 `state` |
| `sandbox.allowUnsandboxed` | `{allow}` | 没有可用沙箱时是否允许她的命令不隔离执行（不安全；缺省不允许）。只属于这具身体，不随多具身体同步；返回新的 `sandbox` 状态，记审计 |
| `timeline` | `{limit?, before?, kind?}` | 时间线（倒序；`kind` 另有 `place`（多具身体时，这次醒来选在了哪具身体上 `{kind, reason, intent, where}`）、`mesh`（网状层的事：绑定、心跳交接、安全提醒）、`hear`（听到有人说话，没有回应）、`tool`（造了 / 改了 / 删了一个工具）、`identity`（她改了自己的身份）、`session`（切到新会话 / 压缩了上下文）、`agent`（派出 / 完成 / 停止子 agent，完成的条目带 `journal`、`process`、`steps`）、`sandbox`（没有可用的沙箱，启动时提醒一次））。`detail` 随 `kind` 而异：`think` / `dream` 为 `{reason, intent, journal, feeling, thought?, process, steps, tokens, model}`（中断时为 `{reason, intent, error, process}`），`chat` 为 `{channel, conv, text, reply, process, steps, tokens, model}`；`process` 是这一轮的执行过程（与 `sessions.messages` 的 `process` 同构：工具卡片与中途叙述），`steps` 是每次工具调用的完整参数与结果（结果最多 1500 字） |
| `messages` | `{limit?}` | 全部会话里最近的对话（正序） |
| `audit` | `{limit?}` | 审计记录 |

`heart` 字段：`mode`（awake / asleep / active）、`S`、`C`、`sleepiness`、`alertness`、`drives{curiosity, expression, social, openLoops}`、`unconsolidated`、`ratePerHour`、`inhibitors[]`、`lastReason`、`nextCandidateAt`、`personality`。

**交流**

| 方法 | 参数 | 说明 |
|---|---|---|
| `chat.send` | `{text, conv?, turn?, attachments?, mode?}` | 与她对话，返回她的回复。`conv` 为会话（缺省为「最初的对话」）；`turn` 由客户端生成，用于把 `activity` 事件对应到这句话；`attachments` 为 `/upload` 返回的附件（只按 `rel` 解析，最多 20 个）。她正在这个会话里工作时，`mode` 决定这句话怎么处理：`steer`（默认，插话：这次模型调用结束后并入）、`queue`（排队：作为下一轮）、`interrupt`（打断：立即中止当前模型输出并带着新消息继续，不打断正在执行的工具）；插话与打断立即返回。调用不设绝对超时，按「120 秒无进展」判定 |
| `sessions` | `{archived?}` | 会话列表 `[{id, title, channel, created, updated, archived, count, last}]`（按最近更新） |
| `sessions.create` | `{title?}` | 新建会话（首条消息自动成为标题） |
| `sessions.rename` / `sessions.archive` | `{id, title}` / `{id, archived}` | 重命名 / 归档与找回（有新消息的会话自动回到列表） |
| `sessions.messages` | `{id, limit?, before?}` | 某个会话的对话 `[{id, ts, role, channel, text, session, process, attachments, mode, body}]`（按时间排列；`before` 为消息 id，取比它更早的；`body` 为这条消息发生在哪具身体上；消息 id 在所有身体上相同）；`role` 为 `user`（对方）、`agent`（她）或 `ambient`（环境输入，不是对方发的消息：通道 `语音` 为麦克风听到并识别的话（`mode` 为 `ignored` 表示她判断不是对她说的，控制台不显示）、`子agent` 为子 agent 送回的报告、`摘要` 为她用 `session_compact` 写下的上下文摘要（之前的历史不再进入上下文）、`交接` 为她用 `session_new` 切会话时写的交接）；`process` 里的 `{type: "steer", msg, text, mode, ambient}` 是插话 / 打断到达的那一刻（控制台据此把之前的过程截断在插话消息上方，之后的从它下面重新开出）；`process` 为这轮回复的执行过程（工具卡片与中间叙述） |
| `sessions.live` | — | 进行中的轮次快照 `[{turn, conv, origin, body, text, msg, status, step, live, items}]`（含其他身体上进行中的轮次，`body` 为在哪具身体上） |
| `poke` | `{note?}` | 戳一下：推高想念与好奇并立即重新抽样，不强制醒来 |

**保密库（`pass_secret`）**

会话处于保密输入中时，`chat.send` 的 `text` 被当作一项保密值（或结束口令）消费：不入库、不进入上下文，立即返回一条不含内容的回执。任何接口都不返回值。

| 方法 | 参数 | 说明 |
|---|---|---|
| `secrets` | — | 保密库里的各项 `[{name, hint, ts, channel, bytes, path}]` |
| `secrets.delete` | `{name}` | 删除一项，返回是否存在 |
| `secrets.pending` | — | 进行中的保密输入（结构同 `secret` 事件），客户端重建界面时取回 |
| `secrets.end` | `{id, cancel?}` | 结束一次保密输入，与对方发回结束口令（`cancel` 为真时与「口令 取消」）等价；返回结束后的状态，已结束则为 `null` |

**语音（Azure 语音服务）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `speech` / `setSpeech` | — / `{region?, endpoint?, key?, voice?, style?, rate?, pitch?, volume?, format?}` | 查看 / 修改配置；密钥只返回末四位，留空不改。`endpoint` 只接受 Azure 语音服务的 HTTPS 地址（`*.microsoft.com`、`*.azure.com`、`*.cognitiveservices.azure.com`），否则报错；配置文件里或其他身体同步来的不合规端点会被清空。她的 `voice_config` 不能改端点 |
| `speechVoices` | `{locale?}` | 可选音色（含支持的风格） |
| `speechTest` | `{text?}` | 用当前配置合成并播放一句 |

**听觉（耳朵在控制台 App，识别在基座）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `player.set` / `player.done` | `{enabled}` / `{id, interrupted?, utterance?}` | 控制台 App 的耳朵开着时登记为她的播放器（之后 `voice_speak` 的声音由 App 经通话路径播放，没有播放器时交给身体适配器）；播完或被插嘴后回报，`utterance` 为打断播放的那句话的标识（耳朵送 `/hear` 时带的 `id`），那句话以「打断」并入 |
| `hearing` / `setHearing` | — / `{enabled?, windowMin?, sensitivity?, language?, minChars?}` | 查看 / 修改：`{…配置, listening, reasons[], speaking, last}`。`listening` 为 App 该不该开麦克风（开关、未急停、Azure 语音已配置、电量与温度在预算限制内），`reasons` 为没在听的原因，`speaking` 为她此刻在说话，`last` 为最近一次识别 |
| `status` 的 `hearing` 字段 | — | 同 `hearing`，随 `state` 推送；App 据此启停本机的麦克风前台服务 |

**自造工具（她用 `tool_write` 造的，这里只看、启停与删除）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `tools` | — | `{tools: [{name, description, parameters, permission, runtime, timeout, requires, enabled, updatedAt, missing[], hasSkill, skillSummary}], skills: [{name, description, implemented}]}`；`skills` 为灵魂仓库里的全部技能文档（含其他身体写的） |
| `tools.read` | `{name}` | `{manifest, source, skill}`；只有技能文档没有本机实现时 `manifest` 为 `null` |
| `tools.toggle` | `{name, enabled}` | 停用 / 启用（写入她的日记） |
| `tools.delete` | `{name, skill?}` | 删除实现；`skill` 为真时连技能文档一起删（灵魂仓库历史可找回） |

**调节与安全**

| 方法 | 参数 |
|---|---|
| `activity` | `{value}`（0–4） |
| `pause` | `{paused}` |
| `personality` | `{changes: {"tau.curiosity": 2, …}}`（有界） |
| `stop` / `unstop` | `{reason?, scope?: all｜body}` / —（多具身体时急停缺省全网生效；`scope: "body"` 只停这具身体，别处的解除清不掉它） |
| `permissions` / `setPermission` | — / `{id, level: allow｜ask｜deny}`（见 §3 `permissions.*`：「执行命令」为允许时，其他类别挡不住她） |
| `approvals` / `decide` | — / `{id, approve, note?, body?}`（多具身体时含其他身体上等待批准的，带 `body`；批准转给那具身体处理。`body` 取审批列表里的那一项：给了就只找那具身体上的；不给而编号在几具身体上都有时不处理，返回 `false`） |
| `budget` / `setBudget` | — / `{dailyTokens?, dailyCostUsd?, minBattery?, maxTempC?}` |
| `config` / `setConfig` | — / `{timezone?, brain?, heart?}` |
| `restart` | — （进程退出，由守护者拉起） |
| `gateway.rotateToken` | — → `{token}`：换一个新的网关令牌并保存，断开其他所有连接（关闭码 4001，它们手里的旧令牌作废），新令牌只返回给发起的这个连接；写审计 |
| `selfUpdate` | `{version?}` | 让这具身体在后台重跑一键安装脚本，把运行基座、网页控制台与原生控制台升到 `version`（控制台看到的最新发布；不给时装 npm 的 latest，它可能晚于发布）并重启服务一次：`{started, message, status}`。同一时间只跑一个升级（进行中再调只返回说明）。由适配器的 `upgrade(version?)` 实现（Linux：`systemd-run --user` 起临时单元脱离服务的 cgroup，没有 systemd 用 `setsid`；日志 `logs/upgrade.log`，每次升级的开始与退出码带编号）；安卓没有（App 自己升级） |
| `quit` | — | 退出（桌面托盘的「退出」）：这一次停掉后台服务，开机自启照旧。由适配器的 `quit()` 实现（Linux：systemd 用户服务 `stop --no-block`；守护循环放 `state/quit`，循环在运行基座退出后看到它就自己也退出；都没有直接结束进程）；没有的身体直接结束进程（安卓的前台服务会重新拉起） |
| `selfUpdateStatus` | — | 最近一次升级：`{running, id?, startedAt?, target?, exitCode?, step?, stalled?}`（`step` 为安装脚本最后一步或报错；开始超过 15 分钟还没结束为 `stalled`）。控制台据此显示进度、失败原因与「重试」，重开控制台时接着显示进行中的升级 |
| `supervision` / `setSupervision` | — / `{enabled}` | 守护开关（开机自启 + 退出后自动重启，一个开关管两件事）：`{available, enabled, kind: systemd｜runit｜loop｜none, detail}`。由身体适配器实现：Linux 是 systemd 用户服务（关 = disable + 覆盖片段 `Restart=no`）或一键安装脚本的守护循环（关 = 标志文件 `state/supervise.off` + 删开机项），安卓（App 内置）是 App 前台服务的「开机与升级后自启、退出后重启」开关（`kind: loop`，经身体接口），旧的 Termux 安装是 runit `down` 文件 + Termux:Boot 开机脚本；`available` 为假（手动部署）时控制台不显示开关。关闭只影响之后：正在运行的进程不受影响 |

**记忆**

| 方法 | 参数 |
|---|---|
| `memory` | — → `{soul, memory[], user[], loops[]}` |
| `editMemory` | `{target: memory｜user, action: add｜replace｜remove, content?, oldText?}` |
| `setSoul` | `{text}` |
| `journalList` / `journal` | — / `{body, day}` |
| `notes` / `note` / `search` | — → `[{name, title, summary, mtime, size}]`（`name` 为目录树中的相对路径，如 `身体/honor9/硬件`）/ `{name}` / `{query}`（按相关度检索笔记、日记与常驻记忆） |
| `soulConfig` / `setSoulConfig` / `soulKey` / `syncSoul` | 灵魂仓库地址（只接受 SSH 地址，见规范 §7）与访问方式 `sshMode`（`deploy` 本机部署密钥 / `custom` 指定私钥 `sshKeyPath` / `system` 系统 ssh 配置）、本机部署公钥（没有则生成）、立即同步；`status` 含 `lastPull`、`lastPush`、`lastError`（落盘，重启不归零）与 `unpushed`（她碰过、已提交但还在本机等待推送的改动数）。她每次工具调用后碰了灵魂目录都会立即提交、3 秒去抖推送（见 SOUL_SYNC.md）；推送失败与冲突副本由基座直接提醒她，时间线 `kind` 为 `soul` |
| `agent` / `setAgent` | — / `{displayName?, name?, pronouns?, description?, color?, language?}`（写入 agent.json 并同步；她自己改用工具 `edit_identity`，留时间线 `identity`） |
| `bodies` | — → 灵魂仓库中登记的身体 |
| `soulHistory` / `soulShow` / `soulRevert` | `{limit?}` / `{hash}` / `{hash}`：记忆历史、查看差异、撤销（生成反向提交） |

**网状层（多具身体直连，见 ARCHITECTURE §6.2）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `mesh` | — | `{server, bound, account, fingerprint, available, state, error, clockSkewMs, peers, binding}`：`state` 为 `off`（没配地址、没绑定或缺组件）/ `connecting` / `online` / `offline` / `unauthorized`（令牌失效，需重新绑定）；`fingerprint` 为本机节点公钥指纹（绑定时与网页上的核对）；`available` 为原生组件能否加载；`peers` 为同一 agent 的其他身体 `[{body, kind, version, online, lastSeen, link: none｜idle｜connecting｜authenticating｜open｜closed, path?: {local, remote, rtt}, error?, keyOk, registered, fingerprint, pinMismatch?, settings}]`（`path` 的 `local` / `remote` 为候选类型 host / srflx / prflx / relay，不含地址；`keyOk` 为同步服务转告的公钥与灵魂仓库登记的一致、且与钉住的一致；`registered` 为本机灵魂仓库里有没有它的登记（没有就连不上，等灵魂同步拉到）；`error` 也包括最近一次拒绝它的连接请求的原因；`settings` 为与它最近一次对齐设置的结果 `{at, took: [采用了它的哪些设置，中文名], error?}` 或 `null`；`pinMismatch` 为真表示它在灵魂仓库里的公钥变了或从灵魂桥变成了运行基座，确认（`mesh.acceptPin`）之前不连接）；`binding` 为进行中的绑定 `{code, uri, expires}` 或 `null`。也在 `status` 的 `mesh` 字段里 |
| `mesh` 的 `coordinator` 字段 | — | 此刻持有心跳的身体（没有连上其他身体时就是自己）；`status.heart.follower` 为真表示这具身体的心脏在跟随协调者 |
| `mesh.setServer` | `{server}` | 设置同步服务地址（只接受 HTTPS；本机地址除外）；换地址需要重新绑定。空字符串恢复官方同步服务（没有绑定时网状层不连接） |
| `mesh.bind` | — | 开始绑定：向同步服务申请设备码，返回的状态里 `binding.code` 是要在网页上输入的短码、`binding.uri` 是带短码的链接；批准后自动保存令牌并连上（经 `mesh` 事件推送进展） |
| `mesh.setPriority` | `{priority}` | 这具身体当协调者的优先级（0–100，越大越优先；适合一直开着、接着电源的身体） |
| `mesh.cancelBind` / `mesh.unbind` | — | 取消进行中的绑定 / 解绑（通知同步服务作废令牌，删除本机的绑定；节点密钥保留） |
| `mesh.acceptPin` | `{body}` | 确认某具身体新的节点公钥（或从灵魂桥变成运行基座）：钉住灵魂仓库里现在登记的，重新连接；返回同 `mesh`。只在 `peers` 里那一项 `pinMismatch` 为真、并且核对过指纹时用 |

推送事件 `mesh`：数据同 `mesh` 方法，网状层状态变化时推送（绑定进展、同步服务连接、各身体的连接与路径）。

**账户**（`mesh/account.ts`）：控制台管理同步服务上的整个账户，与官网的账户页是同一套接口（[sync/docs/PROTOCOL.md](../sync/docs/PROTOCOL.md) §5）。前提是这具身体已绑定；再做一次控制台登录，账户令牌存在 `secrets/sync-account.json`（0600）。这些方法只给持网关令牌的控制台用，agent 的工具里没有；agent 的命令在沙箱里运行，那里没有密钥目录（沙箱为 `none` 时没有这层保护，见 `status.sandbox`）。

| 方法 | 参数 | 说明 |
|---|---|---|
| `account` | — | `{server, bound, signedIn, account, signing: {code, uri, expires} \| null, error}`：`bound` 为这具身体已绑定同步服务；`signing` 为进行中的控制台登录（`uri` 指向官网的「批准设备」页） |
| `account.signIn` / `account.cancel` | — | 开始 / 取消控制台登录（身体令牌向同步服务申请码，后台轮询；批准后保存账户令牌，经 `account` 事件推送） |
| `account.signOut` | — | 退出这个控制台的登录（同步服务作废令牌，删除本地文件） |
| `account.get` | — | 账户：`{user, limits, agents: [{id, name, bodies: [...]}], consoles: [...]}`（同 `/v1/web/account`） |
| `account.lookup` / `account.decide` | `{code}` / `{code, approve}` | 批准设备：核对一个码（另一具身体的绑定或另一个 App 的控制台登录），批准或拒绝 |
| `account.removeBody` / `account.removeAgent` | `{agent, body}` / `{agent}` | 解绑一具身体 / 删除一个 agent |
| `account.revokeConsole` | `{id}` | 吊销一个控制台登录 |
| `account.delete` | — | 删除整个账户 |

令牌失效（被吊销、过期、账户删除）时，账户方法报错「账户登录已失效」，本地令牌随即删除，`signedIn` 变为假。错误信息为同步服务的错误码（`bad_code`、`not_yours` 等，见协议 §5.1）。

**模型**

| 方法 | 参数 | 说明 |
|---|---|---|
| `providers` | — | `{config, version}`，Key 只含末四位 |
| `saveProviders` | `{config, expected}` | 整份保存；`expected` 为加载时的版本号，不符返回 `STALE_CONFIG` |
| `catalog` / `refreshCatalog` | — | 公共模型目录（models.dev） |
| `remoteModels` | `{providerId}` | 从供应商接口拉取模型 ID 列表 |
| `testModel` | `{providerId, model}` | `{ok, latencyMs, message}` |
| `moveModel` / `toggleModel` | `{modelId, delta}` / `{modelId}` | 快捷调整全局顺序与启停 |

供应商配置结构：

```ts
interface Provider {
  id: string; catalogId: string; name: string; baseUrl: string; enabled: boolean;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  keys: { id: string; label: string; lastFour: string; enabled: boolean; secret?: string /* 仅新增时提交 */ }[];
  models: { id: string; name: string; enabled: boolean; context: number; maxTokens: number; sortOrder: number; cost?: { input: number; output: number } }[];
}
interface ProviderConfig { providers: Provider[]; quickModelId?: string }
```

**飞书**

| 方法 | 参数 | 说明 |
|---|---|---|
| `feishu.status` | — | `{connected, error, registering, enabled, appId, owner, bindCode}` |
| `feishu.register` | — | 开始一键创建机器人，扫码链接通过 `feishu.qr` 事件推送 |
| `feishu.set` | `{appId?, appSecret?, enabled?, ownerOpenId?}` | 手动配置 |
| `feishu.setHolder` | `{body}` | 多具身体时指定持有飞书长连接的身体（全网共用的设置；空为各自连，只适合一具身体）；`feishu.status` 含 `holder` 与 `holds`（这具身体是否持有） |

## 2. 身体适配器

定义见 `runtime/src/body/adapter.ts`。适配器是一个独立构建的 ES 模块，默认导出：

```ts
interface BodyAdapter {
  name: string;
  describe: string;                        // 一句话描述这具身体，进入她的自我认知
  init?(): Promise<void>;
  sample(): Promise<RawSample>;            // 一次物理采样，字段全部可选
  notify?(title: string, text: string): Promise<void>;  // 本地系统通知
  speak?(text: string): Promise<void>;
  playAudio?(file: string): Promise<void>; // 播放音频文件（语音合成的结果）
  stopAudio?(): Promise<void>;             // 停止播放（对方插嘴时让她停下）
  tools?: AdapterTool[];                   // 设备动作，每个声明所属能力类别
  hands?: Hands;                           // 预留：看屏幕与操作其他应用
  supervision?: { status(): Promise<SupervisionState>; set(enabled: boolean): Promise<void> }; // 守护开关：开机自启 + 退出后自动重启；SupervisionState = {available, enabled, kind, detail}
  upgrade?(): Promise<string>;             // 从控制台升级：后台重跑安装，立即返回一句说明（Linux 适配器有；安卓由 App 升级）
}
interface RawSample {
  battery?: { level: number; charging: boolean; tempC?: number; health?: string };
  lux?: number; motion?: number; screenOn?: boolean;
  extra?: Record<string, string | number | boolean>;
}
```

约束：

- 适配器提供的 `notify()` 的内容可能含配对码（连同证书的短指纹）：写日志时应当只在没有别的办法让人看到时才写内容（Linux 适配器：有桌面通知时日志只记标题）；

- 适配器只能 `import type` 本文件的类型，不得依赖核心的其他实现；仓库自带几个平台级实现：`runtime/adapters/android/`（任意安卓手机）构建为 `dist/android.mjs`，随 Quetzal App 内置；`runtime/adapters/termux/`（旧的 Termux 安装：安卓手机 + Termux:API）构建为 `dist/termux.mjs`；`runtime/adapters/linux/`（任意 Linux 机器）构建为 `dist/linux.mjs`，由 npm 包 `@plutokeating/quetzal` 随运行基座放到 `~/quetzal/current/`；
- 适配器从 `QUETZAL_ADAPTER` 环境变量或配置项 `adapter` 指定的路径加载；加载失败时核心回退到通用适配器（无传感器）；
- 工具的 `permission` 必须是闸门已知的能力类别之一（见 `guard/guard.ts`），否则按「允许」处理。

安卓适配器经 Quetzal App 的**身体接口**取得身体能力：App 在 127.0.0.1 的随机端口提供 HTTP/1.1 接口（`Authorization: Bearer <令牌>`，令牌 256 位、每次启动重新生成），端口与令牌写在 `QUETZAL_HOME/secrets/body.json`（`{port, token}`，0600）。接口：`GET /v1/info`（机型、光线与加速度传感器名、有没有相机与闪光灯）、`GET /v1/sample`（`battery {level, charging, tempC, health}`、`plugged`、`lux`、`motion`、`screenOn`）、`GET /v1/sensors`、`POST /v1/sensor {name}` → `{values}`、`POST /v1/notify {title, text}`、`POST /v1/play {file}`、`POST /v1/stop`、`POST /v1/vibrate {ms}`、`POST /v1/torch {on}`、`POST /v1/clipboard {text?}` → `{text}`、`POST /v1/location` → `{latitude, longitude, accuracy, ageMinutes}`（定不到新位置时为最近一次已知位置）、`POST /v1/photo {camera, file}`、`POST /v1/record {seconds, file}`、`GET/POST /v1/supervision {enabled}`。成功 `{ok: true, …}`，失败 `{ok: false, error}`；文件路径必须在 `QUETZAL_HOME` 之内；请求体最大 64 KiB。工具与 Termux 适配器同名同参数。

Termux 适配器提供：`sample()` 的电量 / 充电 / 体温 / 健康（`termux-battery-status`）、光照与运动（`termux-sensor`，传感器按名字探测，没有就不报）；`notify()`（带「打开 Quetzal」按钮）、`playAudio()` / `stopAudio()`（`termux-media-player`）；工具 `take_photo`（camera）、`record_audio`（microphone）、`location`（location）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device）。不提供 `speak`（很多手机没有系统 TTS 引擎），说话由运行基座的 `voice_speak` 完成。环境变量：`QUETZAL_HOME`（媒体保存位置 `data/media/`）、`QUETZAL_CONSOLE_ACTIVITY`（通知按钮打开的界面，默认 `xyz.quetzal.console/.MainActivity`）。

Linux 适配器提供：`sample()` 的电量 / 充电 / 健康（`/sys/class/power_supply`，跳过蓝牙鼠标等外设电池；`charging` 在「Not charging」且外接电源在线时也为真）、电池自身温度（`temp` 节点，笔记本少有），`extra` 里的 CPU 温度（`/sys/class/thermal`，不冒充体温，因为心脏与听觉按手机电池的 45°C 抑制）与电源来源；`describe` 含发行版（`/etc/os-release`）、是否笔记本、有没有桌面、摄像头与声卡；`notify()`（有桌面时 `notify-send`，同时写到标准输出即服务日志，没有桌面的机器从日志里看配对码）、`playAudio()` / `stopAudio()`（`pw-play` / `paplay` / `ffplay` / `mpv`，WAV 还可 `aplay`）；工具 `take_photo`（camera：`ffmpeg` + `/dev/video0`）、`record_audio`（microphone：`arecord` / `pw-record` / `parecord` / `ffmpeg`）、`screenshot`（hands：Wayland 下 `grim` / `gnome-screenshot` / `spectacle`，X11 下 `scrot` / `gnome-screenshot` / `spectacle` / `import`）、`clipboard`（device：`wl-clipboard` / `xclip` / `xsel`）、`open`（device：`xdg-open`）。没有图形界面时与界面相关的工具直接说明，不报错崩溃。同样不提供 `speak`。环境变量只有 `QUETZAL_HOME`。

## 3. 配置项（`config/quetzal.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `body` | `default` | 身体名称（日记目录名）；安装器写为机型名 |
| `adapter` | `""` | 适配器模块路径（安卓 App 与 Termux 部署用环境变量 `QUETZAL_ADAPTER` 指定） |
| `timezone` | 系统时区（拿不到时 `Asia/Shanghai`） | 生物钟与日记使用的时区 |
| `heart.activity` / `baseRatePerHour` / `paused` | 1 / 4 / false | 活跃度、饱和醒来率、暂停 |
| `budget.*` | 2,000,000 tokens / $5 / 15% / 45°C | 每日预算（多具身体时按全网合计）与身体限制 |
| `channels.feishuHolder` | "" | 多具身体时持有飞书长连接的身体（全网共用）；空为这具身体自己连 |
| `sharedRev` | {} | 多具身体共用的设置分区最近一次被修改的时刻（基座维护，较新的修改在身体之间生效） |
| `permissions.*` | `camera` / `microphone` / `location` / `hands` / `tool_write` 为 `ask`，其余 `allow` | 能力授权（类别含 `session`：会话与子 agent；`body`：跨身体操作；`tool_write`：造工具，写之后会被执行的代码）。一个工具按它所属类别中最严的一个检查：自造工具 = 声明的类别 + `shell`，`tool_write` = `self_modify` + `tool_write`。**`shell`（执行命令）为 `allow` 时，其他类别的限制挡不住她**：命令能做设备工具、联网、改文件能做的一切（沙箱只藏起密钥目录等，见 ARCHITECTURE §8.1）。默认允许是产品上的取舍；想真正收紧，先把 `shell` 改成 `ask` |
| `brain.maxOutputTokens` | 4096 | 每次模型调用的输出上限（步数不设上限，由 agent 决定何时结束） |
| `feishu.*` | — | 飞书（Secret 在 `secrets/`） |
| `soul.remote` / `branch` | "" / main | 灵魂仓库（常驻记忆 MEMORY / USER 没有长度上限） |
| `gateway.port` / `gateway.host` / `gateway.lan` / `gateway.lanPort` | 7788 / `127.0.0.1` / false / 7789 | 网关（§1）：明文 HTTP 只监听本机回环的 `port`；`lan` 为真或 `host` 不是回环地址（旧配置的 `0.0.0.0`）时，在 `host`（回环时为 `0.0.0.0`）:`lanPort` 上另开 HTTPS / WSS（自签名证书，`secrets/gateway-tls.*`）。Linux 安装器的 `--lan` 写 `host: 0.0.0.0, lan: true`，`--no-lan` 写回 `127.0.0.1` 与 `false` |
| `mesh.server` / `mesh.priority` | `https://sync.quetzal.plutokeating.beer` / 0 | 同步服务地址（HTTPS；缺省为官方同步服务 `OFFICIAL_SYNC`，旧配置里为空时加载即补上；绑定令牌在 `secrets/sync.json`，节点密钥在 `secrets/mesh_ed25519`）；当协调者的优先级（越大越优先，适合一直开着、接着电源的身体） |
| `hearing.enabled` / `windowMin` / `sensitivity` / `language` / `minChars` | false / 10 / 2 / ""（取她的偏好语言）/ 2 | 听觉：开关；最近会话多少分钟内有更新就并入（0 为每句新开）；灵敏度 1 迟钝 / 2 适中 / 3 灵敏（App 的 VAD 模式）；识别语言；短于此字数当没听清 |
| `speech.region` / `endpoint`（只接受 Azure 的 HTTPS 域名） / `voice` / `style` / `rate` / `pitch` / `volume` / `format` | "" / "" / zh-CN-XiaoxiaoNeural / "" / 0% / 0% / 100 / audio-24khz-48kbitrate-mono-mp3 | Azure 语音（密钥在 `secrets/azure_speech_key`）；控制台「语音」页或她自己用 `voice_config` 修改 |
