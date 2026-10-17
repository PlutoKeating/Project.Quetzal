# 接口

Quetzal 对外有两类接口：**网关 API**（控制台、主机工具使用）和**身体适配器接口**（设备仓库实现）。

网关使用项目自定义的 HTTP / WebSocket RPC；身体间协议见 [分布式设计](DISTRIBUTED.md)。已提供 MCP 客户端工具来源（本机 stdio、远程 Streamable HTTP 与旧版 SSE，OAuth 2.1，tools / resources / prompts）、插件包（Claude Code 插件格式与 Agent Skills）和本机 `chat` / `tui` 客户端；没有 MCP 服务端或远程 TUI。模型可调用的工具在 `runtime/src/mind/tools.ts` 注册，区别于控制台 RPC 方法；上下文与子 agent 的运行边界见 [架构 §5](ARCHITECTURE.md#5-大脑一次醒来)。

各类接口的实现位置、工具扩展点与 MCP / TUI 的现状证据见 [内核工具与交互接口](engine/INTERFACES.md)。独立引擎已从根级 `engine/` 提供模型—工具循环，runtime 保持现有网关协议；MCP 实现与配置见 [MCP 工具来源](engine/MCP.md)，终端命令见 [CLI 文档](../cli/docs/README.md)，剩余接入范围见 [适配计划](engine/ADAPTERS_PLAN.md)。

## 1. 网关

两个监听，共用同一套接口：

| 监听 | 地址 | 协议 | 用途 |
|---|---|---|---|
| 本机 | `127.0.0.1:<gateway.port>`（默认 7788），另加 `[::1]` 同一端口（有 IPv6 时） | 明文 HTTP / WebSocket | 同一台机器上的控制台（App 内置的运行基座与同一个 App、本机的网页控制台与桌面版控制台、命令行）。永远只在回环地址上，不出这台机器 |
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
| GET | `/auth/local` | `{ok, token}`：只给**同一台机器上的控制台**，打开即登录（只在本机明文监听上，HTTPS 监听上一律 403）。两种客户端：**浏览器**（网关托管的网页控制台）与**原生桌面控制台**（Linux，dart:io，请求里没有 Origin；原生桌面控制台——Linux 与 Windows——先直接读 `QUETZAL_HOME/secrets/gateway.token`，经一次带令牌的 `status` 核对才用，读不到才问这里，Windows 只靠读文件）。共同条件：不是安卓（安卓上别的应用也能连 127.0.0.1）；连接来自回环地址、Host 是本机名；发起连接的进程不是运行基座的子孙。原生客户端（没有 `Origin`）：只在 Linux 上，发起连接的 socket 必须属于运行基座同一个系统用户（读 `/proc/net/tcp` 的 uid 列；没有 `Origin` 的请求不可能来自别的网页——跨源 fetch 浏览器一定带 `Origin`，no-cors 请求读不到响应）。浏览器：网关托管着网页控制台（`web/` 存在），`Origin` 必须正好是网关自己的源（`http://127.0.0.1:<端口>`、`http://localhost:<端口>`、`http://[::1]:<端口>`；开发时别的源只能由环境变量 `QUETZAL_DEV_ORIGINS`（逗号分隔）明确列出），CORS 只对这个 Origin 放行；发起连接的进程不是运行基座的子孙（agent 的命令、后台任务、自造工具都是，Linux 上读 `/proc` 判断）。其他情况 403。注意：本机进程并不都读得到 `secrets/gateway.token`——agent 的命令在沙箱里读不到它（ARCHITECTURE §8.1），安卓上别的应用也读不到；`Origin` 头命令行程序能伪造，所以挡 agent 的是子孙进程检查与沙箱。ssh 隧道转发来的连接也算本机 |
| GET | `/<静态文件>` | 网页控制台（`web/` 目录存在时）：`/` → `index.html`，没有扩展名的未知路径也回退到 `index.html`（单页应用），带 ETag |
| GET | `/pair/info` | `{ok, fingerprint, short, body, version, tls: true}`，无需令牌：网关证书的指纹（完整与短格式）、身体名、版本。控制台配对的第一步：原生控制台以「捕获」方式握手，记下自己看到的指纹并显示给人核对；网页版用这里报告的指纹。两个监听上都有（回环上报告的也是 TLS 证书的指纹）。Host 检查同配对接口 |
| POST | `/pair/start` | 生成 8 位配对码（字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，密码学随机，通知里显示为 `控制台配对码 ABCD-EFGH · 证书指纹 1a2b 3c4d 5e6f 7a8b（5 分钟内有效）`；5 分钟有效），通过适配器的系统通知与飞书下发 → `{ok, expires}`。码还有效时再请求不换新码、不清零尝试次数（30 秒后可以再提醒一次）。Linux 适配器有桌面通知时服务日志里只记「控制台配对」，没有桌面的机器才把配对码写进日志 |
| POST | `/pair/finish` | `{proof}` 或 `{code}` → `{ok, token, fingerprint}`。**配对证明** `proof` = hex(PBKDF2-HMAC-SHA256(密码 = 规范化的配对码, 盐 = `"quetzal-pair-v2\|" + 指纹`, 迭代 100000, 32 字节))，小写十六进制 64 位（服务端比较时不区分大小写）；配对码规范化：转大写、去掉空白与连字符；指纹为客户端在 TLS 握手中看到的证书指纹（小写十六进制）、字符串按 UTF-8 编码。服务端用自己的证书指纹与当前有效的配对码算出同样的值（生成配对码时算好），定长比较。**HTTPS 监听上只收 `proof`**（带 `code` 或缺 `proof` 回 400，不计入尝试次数）：配对码不上网络，中间人看到的是自己的证书，转给运行基座的证明对不上。**回环明文监听上收 `{code}`**（同一台机器、旧控制台）也收 `proof`（指纹为 TLS 证书的）。成功时回报 `fingerprint`，客户端核对它等于自己握手时看到的。已知向量：配对码 `ABCDEFGH`、指纹 64 个 `0` → `23473714b2a61fbc2a61de0a7636402e197af0b3fe1ee19be90503518e30e4df`。错误码 403（不正确）、410（失效，或这个码已试过 5 次）、429（累计失败超过 5 次后全局锁定，按 30 秒 × 2^(n−6) 退避，最长 1 小时，`retryAfter` 为秒数；成功一次清零）、413（请求体超过 16 KB）。配对接口（`/pair/info`、`/pair/start`、`/pair/finish`）都检查 Host（防 DNS 重绑定）：回环连接只认本机名；局域网连接认 IP 字面量、`gateway.host` 与环境变量 `QUETZAL_GATEWAY_HOSTS`（逗号分隔，如 `mybox.local`）列出的名字 |
| GET | `/media/<文件名>`（令牌见上） | 她的声音：控制台（安卓 App 或桌面版）取合成语音（`data/media/` 里的音频文件）来播放，见 `speak` 事件 |
| POST | `/hear?started=<毫秒时刻>[&stream=1&id=<标识>&bargein=1]`（令牌见上） | 听觉。`bargein=1`：这句话打断了她的播放（App 本地已停播），以「打断」并入。`stream=1`：请求体为边说边送的 16 kHz 单声道 16 位 PCM（分块传输），基座用官方 SDK 流式识别，中间结果经 `hearing` 事件推送；否则请求体为一整句 WAV（最多 4 MiB）一次识别。→ `{ok, id, text, conv?, dropped?}`；`started` 为这句话开始的时刻（目前只随请求记下；她说话时的声音由耳朵一侧处理：安卓靠回声消除、以 `bargein=1` 送来的是插嘴，桌面版在她说话时不送音频）。识别后以「环境声音」进入会话，见 §1.3 听觉 |
| POST | `/upload?name=<文件名>`（令牌见上） | 上传一个附件，请求体为文件内容（单个最多 50 MiB）→ `{ok, file: {id, name, path, rel, mime, size, kind: image｜text｜file}}`；保存在 `QUETZAL_HOME/data/uploads/<日期>/` |
| GET | `/mcp/oauth/callback?code=…&state=…` | 远程 MCP 的 OAuth 回调（授权服务器把浏览器重定向到这里；redirect_uri 为 `http://127.0.0.1:<gateway.port>/mcp/oauth/callback`）。不需要网关令牌，凭 `state` 认出是哪一次登录（一次有效、10 分钟过期）；只在本机明文监听上。换到令牌后回一页「已登录，可以关掉」并重新连接该来源，失败回 400 与原因。见 [MCP §3](engine/MCP.md) |
| GET | `/uploads/<rel>`（令牌见上） | 下载附件（控制台预览图片）；只能访问 uploads 目录内的文件：路径本身是符号链接的、跟随链接后出了 uploads 的都是 404 |

### 1.2 WebSocket `/rpc`

- 认证：连上后第一条消息 `{"auth": "<令牌>"}`（5 秒内）；或旧式的 `/rpc?token=<令牌>`。单条消息最多 4 MiB。
- 请求：`{"id": 1, "method": "status", "params": {}}`
- 响应：`{"id": 1, "result": …}` 或 `{"id": 1, "error": {"code", "message"}}`
- 推送：`{"event": "<名称>", "data": …}`
- 处理一个请求期间，每 10 秒推送一次 `{"event": "rpc.progress", "data": {"id": <请求的 id>}}`：客户端按「多久没有收到任何东西」判超时，收到它就重新计时（快速接入、立即同步这类要做一阵的请求不会被中途判超时）。

| 推送事件 | 数据 |
|---|---|
| `hello` | `{version, safeMode}`，连接建立时 |
| `state` | 与 `status` 相同的完整状态（去抖 500ms） |
| `timeline` | 新的时间线条目 `{id, ts, kind, title, detail}`（`kind` 含 `soul`：灵魂同步知觉） |
| `approval` | 审批 `{id, action, reason, args, status, kind?}`（`kind: "host"` 为她请求进入真实环境、且配置为人工审批时，控制台据此放在那个对话的顶部）。只有「每次询问」档位与配置为人工的情况才有审批；「交给审核模型」的由审核模型判断，不生成审批（ARCHITECTURE §8.0） |
| `say` | Quetzal 主动说的话（字符串）。推送时已入库：醒来时的主动消息在她选的会话或新开的会话里（通道「主动」），基座发的提醒在 `inbox`（「主动消息」）；推送里不带会话，控制台收到后刷新会话列表与打开的会话页 |
| `activity` | 进展 `{session, conv, origin: chat｜think｜dream｜agent, channel, ts, body, kind, …}`：`session` 为这一轮，`conv` 为所属会话（醒来为空，子 agent 为派出它的会话），`body` 为这一轮在哪具身体上（多具身体时，其他身体上进行的轮次也经同一事件推送），见下表 |
| `secret` | 保密输入（`pass_secret`）的状态 `{id, conv, channel, status: open｜progress｜done｜cancelled｜expired, purpose, items: [{name, hint}], got, spell, expires}`：`got` 为已收到（结束时为已保存）的项数，`spell` 为结束口令；永远不含值 |
| `hearing` | 听觉 `{id, status: partial｜final｜dropped｜kept｜ignored, text, conv?, reason?}`：`partial` 识别中的文字（流式显示）；`final` 识别完成并进入会话 `conv`；`dropped` 没进会话（没有声音、没识别出文字、没在听；不按字数或时长丢弃；多具身体时另一只耳朵也听到了同一句话、由那边交给她）；`kept` 她回应了（保留显示）；`ignored` 她判断不是对她说的（这条消息的 `mode` 标为 `ignored`，控制台隐藏） |
| `speaking` | `{until}`：她在说话（`voice_speak`、试听）到 `until`（毫秒时刻，按码率估计）为止；App 回报播完或被插嘴时 `until` 提前到现在再推一次。界面用它显示「她在说话」；桌面版的耳朵没有回声消除，这段时间不送音频 |
| `projects` | 现存的项目（同 `projects` 方法不带参数的返回）：本机或其他身体改了项目时推送，控制台据此刷新项目与会话列表 |
| `session.switch` | `{from, to, title, done?}`：她用 `session_new` 把对话切到了新会话；控制台把打开的会话页切过去；`done` 为真表示她这一轮的回复已放进新会话 |
| `speak` | `{id, url, text, ms}`：让登记为播放器的控制台播放一段合成语音（`url` 为 `/media/<文件名>`；安卓 App 走通话音频路径，耳朵的回声消除以它为参考；桌面版下载到临时文件后用系统播放器放）；播完或被插嘴后调用 `player.done` |
| `mesh` | 网状层状态（同 `mesh` 方法的返回），绑定进展、同步服务连接、各身体的连接与路径变化时推送 |
| `account` | 账户的控制台登录状态（同 `account` 方法的返回）：申请码、批准、退出、令牌失效时推送 |
| `replica` | `{table: messages｜sessions｜message.mode, from, convs}`：从其他身体复制来的对话或会话已写入本机（`convs` 为涉及的会话），控制台据此刷新会话列表与打开的对话。时间线条目照常经 `timeline` 推送（带 `body`） |
| `canvas.changed` | `{doc, conv, kind: created｜edited｜meta｜deleted｜comment｜run｜replica, author?: agent｜user, version?, comment?, run?, from?}`：一份 canvas 变了（`replica` 为从其他身体复制来的）；控制台的 Canvas 面板据此刷新，`author` 为 `agent` 时 Canvas 按钮加角标（见 ARCHITECTURE §5.5） |
| `plugins` | `{}`：MCP 来源的状态、已装插件、插件目录或她的推荐变了（去抖 300ms）；控制台「插件」页据此重新取 `mcp.list` / `plugins` |
| `feishu.qr` / `feishu.registered` / `feishu.error` | 飞书一键接入流程 |

`activity` 的 `kind`：

| kind | 字段 | 含义 |
|---|---|---|
| `start` / `queued` | `text?`, `msg?`, `ambient?` | 这一轮开始（`msg` 为这句话在对话记录里的 id；`ambient` 为真表示由环境声音触发）/ 排在同一会话前一轮之后 |
| `steer` | `text, msg, mode: steer｜interrupt` | 她工作时对方发来的消息已并入这一轮（进行中的卡片挂到这句话下面） |
| `step` | `step` | 第几次模型调用开始 |
| `delta` | `text` | 流式文字片段（约每 200ms 合并一次） |
| `text` | `step, text, final` | 该步的完整文字；`final` 为真表示这就是回复（不再调用工具） |
| `tool` | `call, name, summary, status: running｜ok｜error｜denied, ms?, result?` | 工具执行中 / 执行后（同一 `call` 先后两条），`summary` 为一行参数摘要。`error` 为没做成：工具抛错或返回失败（命令非零退出、参数不对、那具身体上出错……），不只是程序异常 |
| `alive` | — | 心跳，会话存续期间每 15 秒一次 |
| `done` / `error` | `reply?` / `message, reply?` | 结束；回复与执行过程已写入对话记录 |

进行中的每一轮同时保存为快照（`sessions.live`）：客户端断线重连、从后台切回时据此完整恢复，然后继续接收增量事件。

### 1.3 方法

操作者（actor）统一记为「控制台」，所有修改类操作写入审计。

**观察**

| 方法 | 参数 | 返回 |
|---|---|---|
| `status` | — | `{agent, version, body, adapter, heart, physical, stopped, paused, activity, usage, budget, approvals, soul, models, thought, hearing, mesh, sandbox, reminders, goals, host, plugins}`；`plugins` 为 `{recommended, auth, error, online}`：她推荐、等对方安装的插件数，要登录、出错、已连接的 MCP 来源数（控制台菜单角标）；`reminders` 同 `reminders` 方法；`goals` 同 `goals` 方法（进行中的）；`host` 同 `host` 方法；`sandbox` 为 agent 命令的沙箱 `{kind: bwrap｜landlock｜proot｜srt｜none, hidden[], readonly[], note, allowUnsandboxed}`（`srt`：Windows 的沙箱用户，见 ARCHITECTURE §8.1；`note` 写明她能写哪些目录）（`none` 时她的命令缺省一律不执行，`allowUnsandboxed` 为真时才不隔离执行；控制台应提示重新运行安装命令补上沙箱，见 ARCHITECTURE §8.1）；`thought` 为她想分享的一句话 `{text, ts}` 或 `null`，由她用 `share_thought` 维护（醒来结束的 `finish` 也可顺带更新），更新时推送 `state`；多具身体时全网共用（按 `ts` 后写胜），任一具身体上更新后，其他身体采用时同样推送 `state` |
| `host` / `host.enter` / `host.exit` | — / `{conv}` / `{conv}` | 真实环境（ARCHITECTURE §8.2）：此刻开着真实环境的会话 `[{conv, title, since, last, by: agent｜user, reason, until}]`（`until` 为按空闲时限自动退出的时刻，每条真实环境命令往后推）；`host.enter` 对方在这个会话里自己打开（急停中报错），返回该项；`host.exit` 退出，返回原本是否开着。只属于这具身体、只在内存里（重启即清空）；进出写审计与时间线（`kind` 为 `host`），变化时推送 `state`。她的请求不是单独的接口：缺省（`guard.sentinel.hostMode: "review"`）由审核模型判断，放行时 `host.enter` 审计的执行者为「审核模型」；配置为 `ask` 时是一条 `approval`（`action` 为「进入真实环境（命令不经沙箱）」，`args.conv` 指明会话），用 `decide` 同意或拒绝 |
| `sandbox.allowUnsandboxed` | `{allow}` | 没有可用沙箱时是否允许她的命令不隔离执行（不安全；缺省不允许）。只属于这具身体，不随多具身体同步；返回新的 `sandbox` 状态，记审计 |
| `timeline` | `{limit?, before?, kind?}` | 时间线（倒序；`kind` 另有 `place`（多具身体时，这次醒来选在了哪具身体上 `{kind, reason, intent, where}`）、`mesh`（网状层的事：绑定、心跳交接、安全提醒）、`hear`（听到有人说话，没有回应）、`tool`（造了 / 改了 / 删了一个工具）、`identity`（她改了自己的身份）、`session`（切到新会话 / 压缩了上下文）、`agent`（派出 / 完成 / 停止 / 从检查点续做子 agent，完成的条目带 `journal`、`process`、`steps`）、`sandbox`（没有可用的沙箱，启动时提醒一次）、`host`（进入 / 退出真实环境 `{conv, reason?}`））。`detail` 随 `kind` 而异：`think` / `dream` 为 `{reason, intent, journal, feeling, thought?, process, steps, tokens, model}`（中断时为 `{reason, intent, error, process}`；这具身体离线期间交给另一具身体接着做的为 `{reason, intent, process, handedTo}`），`chat` 为 `{channel, conv, text, reply, process, steps, tokens, model}`（交给另一具身体接着做的带 `handedTo`；续做开始时另有一条 `{conv, turn, from, steps}`：`from` 为原来做这一轮的身体）；`process` 是这一轮的执行过程（与 `sessions.messages` 的 `process` 同构：工具卡片与中途叙述），`steps` 是每次工具调用的完整参数、结果（最多 1500 字）与 `status`（ok / error / denied；1.9.0 之前的记录没有，控制台画成「结果未记录」） |
| `tool.detail` | `{call}` | 一张工具卡片的完整记录 `{call, session, ts, tool, args, result, status, ms, body}`（`call` 为卡片的 `call`；`args` 里的保密值已替换，`result` 为完整结果）或 `null`。完整记录只存在做那一轮的身体上（本机数据库，不复制给其他身体、不进灵魂仓库）：本机没有就经网状层问连着的其他身体，`body` 为在哪具身体上执行的。1.9.3 之前的调用没有完整记录 |
| `messages` | `{limit?}` | 全部会话里最近的对话（正序） |
| `audit` | `{limit?, action?}` | 审计记录（从新到旧）；`action` 只看某个动作，例如 `sentinel.review`（审核结论：`actor` 为 `sentinel`，`args` 为 `{tool, category, label, decision: allow｜revise｜block｜error｜stopped, risk, reason, model, ms, error?, policy?, args}`，`result` 为「结论: 理由」） |

`heart` 字段：`mode`（awake / asleep / active）、`S`、`C`、`sleepiness`、`alertness`、`drives{curiosity, expression, social, openLoops}`、`unconsolidated`、`ratePerHour`、`inhibitors[]`、`lastReason`、`nextCandidateAt`、`personality`。

**交流**

| 方法 | 参数 | 说明 |
|---|---|---|
| `chat.send` | `{text, conv?, turn?, attachments?, mode?}` | 与她对话，返回她的回复。`conv` 为会话（缺省为「最初的对话」）；`turn` 由客户端生成，用于把 `activity` 事件对应到这句话；`attachments` 为 `/upload` 返回的附件（只按 `rel` 解析，最多 20 个）。她正在这个会话里工作时，`mode` 决定这句话怎么处理：`steer`（默认，插话：这次模型调用结束后并入）、`queue`（排队：作为下一轮）、`interrupt`（打断：立即中止当前模型输出并带着新消息继续，不打断正在执行的工具）；插话与打断立即返回。调用不设绝对超时，按「120 秒无进展」判定 |
| `chat.stop` | `{conv?}` | 停止这个会话里她正在进行的一轮（控制台的停止键、桌面上连按两次 Esc）：中止模型输出与正在执行的 `shell` 命令，不再等其他工具（等批准、等保密输入），这一轮以「（这一轮被对方停止了）」结束；这一轮在另一具身体上时转过去停。返回是否停下了一轮（`false`：没有进行中的一轮） |
| `sessions` | `{archived?, channel?, live?, pinned?, project?, from?, to?, sort?, limit?}` | 会话列表 `[{id, title, channel, created, updated, archived, count, last, pinned, project}]`。置顶的（`pinned` 为置顶的时刻，0 为没置顶）总在最前，置顶之间新置顶的在上；其余按 `sort`：`updated`（缺省，最近更新）/ `created`（创建时间）/ `title`（标题）。筛选都可不给：`channel` 来源通道（`控制台`、`飞书`、`主动`、`语音`；`子agent` 为有子 agent 报告送回的会话），`live` 只看此刻有进行中一轮的，`pinned` 只看置顶的，`project` 只看某个项目（`none`：不属于任何项目），`from` / `to` 最近更新落在 `[from, to)`（毫秒）。`project` 为所属项目的 id 或 `null`（归属已删除项目的一律为 `null`）。旧版基座只认 `archived`，其余参数忽略 |
| `sessions.create` | `{title?, project?}` | 新建会话（首条消息自动成为标题）；`project` 为项目 id 时放进这个项目（没有这个项目报错） |
| `sessions.rename` / `sessions.archive` | `{id, title}` / `{id, archived}` | 重命名 / 归档与找回（有新消息的会话自动回到列表） |
| `sessions.pin` | `{id, pinned?}` | 置顶（`pinned` 缺省为真）/ 取消置顶，返回会话；写审计。全网同步 |
| `sessions.move` | `{id, project}` | 把会话归到项目（一个会话至多一个项目；`project` 为 `null` 移出项目），返回会话；写审计。全网同步 |
| `sessions.search` | `{query, limit?}` | 按标题与内容搜索会话（含归档的），每个会话一条：`[{session, title, titleMarks, matches, hit?}]`。`title` 为标题命中（排在前面，按最近更新），其余按内容命中的分数；内容用记忆检索的全文索引（与 `search` / `recall` 同一个对话索引，FTS5 不可用时逐条匹配），她判断不是对她说的环境声音不算。`hit` 为最好的一条命中 `{message, ts, role, snippet, marks}`：`message` 为消息 id（点开时交给 `sessions.messages` 的 `from` 定位），`snippet` 为命中处前后约 120 字，`marks` / `titleMarks` 为高亮位置 `[[起, 止], …]`；`matches` 为命中的消息数。`limit` 缺省 30，最多 100 |
| `sessions.messages` | `{id, limit?, before?, from?}` | 某个会话的对话（`from` 为消息 id 时：从它前面 5 条起到最新，最多 1000 条，用于定位到搜索命中的消息） `[{id, ts, role, channel, text, session, process, attachments, mode, body, via}]`（按时间排列；`before` 为消息 id，取比它更早的；`body` 为这条消息发生在哪具身体上（写入它的那具）；`via` 为对方的话（`user`，以及通道 `语音` 的 `ambient`）从哪具身体进来：对方的控制台连着的、持有飞书长连接的、听到的耳朵所在的那具，转给另一具身体处理时仍是最初进来的那具，旧消息与其他环境输入为 `null`；消息 id 在所有身体上相同）；`role` 为 `user`（对方）、`agent`（她）或 `ambient`（环境输入，不是对方发的消息：通道 `语音` 为麦克风听到并识别的话（`mode` 为 `ignored` 表示她判断不是对她说的，控制台不显示）、`子agent` 为子 agent 送回的报告、`摘要` 为她用 `session_compact` 写下的上下文摘要（之前的历史不再进入上下文）、`交接` 为她用 `session_new` 切会话时写的交接、`续做` 为基座记下的检查点：这一轮之前中断了（基座重启，或做这一轮的身体离线了），由写入它的那具身体在这个会话里接着做（她接着的回复通道也是 `续做`），见 ARCHITECTURE §6.2「续做」）；`process` 里的 `{type: "steer", msg, text, mode, ambient}` 是插话 / 打断到达的那一刻（控制台据此把之前的过程截断在插话消息上方，之后的从它下面重新开出）；`process` 为这轮回复的执行过程（工具卡片与中间叙述） |
| `sessions.live` | — | 进行中的轮次快照 `[{turn, conv, origin, body, text, msg, status, step, live, items}]`（含其他身体上进行中的轮次，`body` 为在哪具身体上） |
| `workspace` | `{conv}` | 会话的工作区与各具身体的工作区概况 `{workspace, bodies}`：`workspace` 为 `{key, body, uuid, dir, changed, source, author, online}` 或 `null`（`source`：`auto` 基座按她的命令自动登记、`agent` 她用 `workspace` 工具设定、`user` 对方在控制台设定）；`bodies` 为 `[{body, online, overview}]`，`overview` 为 `{root, repos: [{path, remote?, branch?}], truncated?, at}`（工作目录下深度 2 以内的 git 仓库，远端地址去掉了凭据；其他身体的是连上时取回的，可能为空）。见 ARCHITECTURE.md §6.2「工作区跟着任务走」 |
| `workspace.set` | `{conv, body?, dir}` | 设定会话的工作区：`body` 为身体名（缺省为这具身体，另一具要在线），`dir` 相对路径从那具身体的工作目录算，要已经存在（基座的家目录与密钥目录不行）；之后这个会话的每一轮放在那具身体上执行。她自动登记的工作区不会覆盖对方设定的（新的 `git clone` / `git init` 除外）。返回同 `workspace` |
| `workspace.clear` | `{conv}` | 清除会话的工作区（留墓碑，其他身体也清掉）：之后的每一轮由收到消息的身体执行。返回同 `workspace` |
| `poke` | `{note?}` | 戳一下：推高想念与好奇并立即重新抽样，不强制醒来 |

**项目**（#30：把相关的会话组织在一起；全网同步，见 [分布式 §2.1](DISTRIBUTED.md)）

项目 `{id, name, description, instructions, color?, icon?, created, updated, archived?}`：`id` 为 16 位十六进制；`name` 最长 60 字、不能重名（不分大小写）；`description` 简介最长 500 字；`instructions` 项目说明最长 8000 字，作为这个项目下所有会话的额外上下文注入系统提示；`color` 为 `#rrggbb`；`icon` 为控制台认得的图标名（小写字母与下划线）。

| 方法 | 参数 | 说明 |
|---|---|---|
| `projects` | `{archived?}` | 项目列表（按名字；`archived` 为真只看归档的、为假只看没归档的、不给全都要） |
| `projects.create` | `{name, description?, instructions?, color?, icon?}` | 新建，返回项目；写审计 |
| `projects.update` | `{id, name?, description?, instructions?, color?, icon?, archived?}` | 修改（`color` / `icon` 给空字符串表示去掉；`archived` 归档与找回），返回项目；写审计 |
| `projects.delete` | `{id}` | 删除（留墓碑，其他身体跟着删）：会话不删，只解除归属，返回 `{sessions}`（解除了几个）；写审计 |

**保密库（`pass_secret`）**

会话处于保密输入中时，`chat.send` 的 `text` 被当作一项保密值（或结束口令）消费：不入库、不进入上下文，立即返回一条不含内容的回执。任何接口都不返回值。

| 方法 | 参数 | 说明 |
|---|---|---|
| `secrets` | — | 保密库里的各项 `[{name, hint, ts, channel, bytes, path, sync}]`（`sync`：多端同步为真，仅本机为假） |
| `secrets.delete` | `{name}` | 删除一项，返回是否存在（多端同步的项其他身体上一起删除） |
| `secrets.sync` | `{name, sync}` | 改一项的同步方式：多端同步 / 仅本机（改成仅本机时其他身体上的副本删除），返回是否存在 |
| `secrets.pending` | — | 进行中的保密输入（结构同 `secret` 事件），客户端重建界面时取回 |
| `secrets.end` | `{id, cancel?}` | 结束一次保密输入，与对方发回结束口令（`cancel` 为真时与「口令 取消」）等价；返回结束后的状态，已结束则为 `null` |

**语音（Azure 语音服务）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `speech` / `setSpeech` | — / `{region?, endpoint?, key?, voice?, style?, rate?, pitch?, volume?, format?}` | 查看 / 修改配置；密钥只返回末四位，留空不改。给了 `key`、没给 `region`、也没有自定义端点时，自动找出密钥所属的区域（向各区域官方的 `*.api.cognitive.microsoft.com/sts/v1.0/issueToken` 各申请一次令牌，认它的就是，几个都认时保留原区域）；都不认就不保存并报错。`endpoint` 只接受 Azure 语音服务的 HTTPS 地址（`*.microsoft.com`、`*.azure.com`、`*.cognitiveservices.azure.com`），否则报错；配置文件里或其他身体同步来的不合规端点会被清空。她的 `voice_config` 不能改端点 |
| `speechVoices` | `{locale?}` | 可选音色（含支持的风格） |
| `speechTest` | `{text?}` | 用当前配置合成并播放一句 |

**听觉（耳朵在控制台——安卓 App 或桌面版，识别在基座）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `player.set` / `player.done` | `{enabled}` / `{id, interrupted?, utterance?}` | 控制台的耳朵开着时登记为她的播放器（之后 `voice_speak` 的声音由控制台播放：安卓 App 经通话路径，桌面版用系统播放器；没有播放器时交给身体适配器）；播完或被插嘴后回报（桌面版不能插嘴，`interrupted` 恒为假），`utterance` 为打断播放的那句话的标识（耳朵送 `/hear` 时带的 `id`），那句话以「打断」并入 |
| `hearing` / `setHearing` | — / `{enabled?, windowMin?, sensitivity?, language?}` | 查看 / 修改：`{…配置, listening, reasons[], speaking, last}`。`listening` 为 App 该不该开麦克风（开关、未急停、Azure 语音已配置、电量与温度在预算限制内），`reasons` 为没在听的原因，`speaking` 为她此刻在说话，`last` 为最近一次识别 |
| `status` 的 `hearing` 字段 | — | 同 `hearing`，随 `state` 推送；控制台据此启停本机的耳朵（安卓是麦克风前台服务，桌面版在控制台进程里） |

**图表（控制台桌面版的兜底）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `mermaid.render` | `{code, dark}` | 把一段 Mermaid 源码画成 SVG → `{svg}`。只在桌面版控制台没有网页引擎（Linux 没装 WebKitGTK、Windows 没有 WebView2 运行时）时调用，其余情况控制台自己用内置的 mermaid.js 画。`svg` 由 flutter_svg 显示，须是自包含的静态 SVG：颜色写成具体值（不用 CSS 变量与 `color-mix`）、不含 `<style>` / `@import` / `<foreignObject>` / `<marker>`（箭头直接画成路径）、文字用 `<text>`；`dark` 为真时按深色背景配色、背景透明。画不出来时返回错误（控制台显示源码）。运行基座还没提供这个方法时控制台同样显示源码 |

**自造工具（她用 `tool_write` 造的，这里只看、启停与删除）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `tools` | — | `{tools: [{name, description, parameters, permission, runtime, timeout, requires, enabled, updatedAt, missing[], hasSkill, skillSummary}], skills: [{name, description, implemented}]}`；`skills` 为灵魂仓库里的全部技能文档（含其他身体写的） |
| `tools.read` | `{name}` | `{manifest, source, skill}`；只有技能文档没有本机实现时 `manifest` 为 `null` |
| `tools.toggle` | `{name, enabled}` | 停用 / 启用（写入她的日记） |
| `tools.delete` | `{name, skill?}` | 删除实现；`skill` 为真时连技能文档一起删（灵魂仓库历史可找回） |

**Canvas（对话旁边的编辑区，见 ARCHITECTURE §5.5）**

`CanvasView` = `{id, conv, title, kind: markdown｜code, lang, created, changed, deleted, body, version, versionId, versions, updated, author, size, open, content, threads, runs}`：`version` 为第几版（从 1 起）、`versionId` 为版本 id、`author` 为这一版的作者（`agent` 她 / `user` 对方）、`open` 为未解决的评论数；`threads` 为评论串 `[{id, author, ts, text, quote, start, end, version, prefix, suffix, resolved, changed, suggestion, at: {start, end, status: exact｜moved｜stale, line, endLine}, replies: [...]}]`（`at` 为按当前内容重新定位的位置，`stale` 为原文已改掉）；`runs` 为最近 5 次运行 `[{id, doc, version, ts, by, body, lang, code, out, err, images: [{name, size, mime}], ms, dir, note}]`。修改类操作写审计。

| 方法 | 参数 | 说明 |
|---|---|---|
| `canvas.list` | `{conv?}` | 一个会话的 canvas（不给 `conv` 为全部，不含已删除的），最近修改的在前：`CanvasView` 去掉 `content` / `threads` / `runs` |
| `canvas.get` | `{id, version?}` | 一份 canvas 的完整视图；`version` 为版本号或版本 id（缺省当前版本） |
| `canvas.versions` | `{id}` | 版本历史 `[{n, id, ts, author, body, note, size}]`（第 1 版在前） |
| `canvas.create` | `{conv, title?, kind?, lang?, content?}` | 对方新建一份（`lang` 的别名合一：py → python、js → javascript……；给了代码语言就是代码） |
| `canvas.edit` | `{id, content, base?, note?}` | 对方保存：整体替换为 `content`，存为新版本 → `{canvas, conflict, changed}`。`base` 为编辑时基于的版本 id；当前版本已不是它（她刚改过）时照样保存为最新，`conflict` 为真（她的那版在历史里）；内容没变时 `changed` 为假、不生成新版本 |
| `canvas.update` | `{id, title?, lang?, kind?}` | 改标题 / 语言 / 类型（按较新的修改同步给其他身体） |
| `canvas.delete` | `{id}` | 删除（标记，同步给其他身体；她也看不到了） |
| `canvas.restore` | `{id, version}` | 恢复到某一版：把它的内容存为一个新版本 |
| `canvas.run` | `{id, version?, timeout?}` | 运行代码（Python / JavaScript / TypeScript / shell / PowerShell）：按「执行命令」类别过闸门（询问时生成审批、等批准；禁止或急停时报错），在与她的命令同一个沙箱里执行，写审计 → 一次运行的记录（见上）。`timeout` 为多少秒没有任何输出就结束（默认 60，最多 600），总时长 15 分钟；解释器不存在时不执行，`code` 为 127、`err` 写明原因 |
| `canvas.runImage` | `{run, name}` | 一次运行生成的图片 `{mime, data}`（`data` 为 base64）；运行发生在别的身体上（图片不复制）时为 `null` |
| `canvas.comment` | `{id, text, start?, end?, send?}` | 对方加评论：`start` / `end` 为当前版本里选中的范围（不给是评论整份文档）。`send` 缺省为真：作为对方的一条消息发给她（进对话，带被评论的片段、行号与评论 id）；为假时只留在面板里 → 评论串 |
| `canvas.reply` | `{thread, text, send?}` | 回复一条评论（`thread` 为评论或其中一条回复的 id；已解决的随之重新打开）；`send` 同上 |
| `canvas.resolve` | `{thread, resolved?}` | 标为已解决（缺省）/ 重新打开 |
| `canvas.apply` | `{thread}` | 采纳她的编辑建议：把评论定位到的原文换成建议的文字（新版本），评论标为已解决；原文已改掉（过时）时报错 |

她自己用工具操作（不是这些方法）：`canvas_create` / `canvas_read` / `canvas_edit` / `canvas_list` / `canvas_comment`（会话与子 agent 类别）与 `canvas_run`（执行命令类别）。

**插件与 MCP 来源**（`plugins/ops.ts`；设计见 [MCP 与插件](engine/MCP.md)）

只给持网关令牌的控制台；她的工具里只有 `plugin_search` / `plugin_recommend` / `plugin_prompt`。修改类操作写审计。

| 方法 | 参数 | 说明 |
|---|---|---|
| `mcp.list` | — | `{sources: [SourceView], error, max}`：`error` 为 `config/mcp.json` 读不了的原因（此时当作没有来源，不覆盖文件），`max` 为来源上限（32）。`SourceView` = `{id, title, transport: stdio｜http｜sse, enabled, sync, plugin?, command?, args?, sandbox?, url?, oauth, loggedIn, loginPending, state: off｜starting｜auth｜online｜error｜denied, error?, protocol?, tools, resources, prompts, secrets[]}`：`state` 的 `auth` 为需要 OAuth 登录、`denied` 为启动没被闸门允许；`secrets` 为配置里引用了、这具身体上还没有值的凭据（多端同步来的来源常见） |
| `mcp.detail` | `{id}` | `SourceView` 加 `permissions: {start, tools, perTool: [{tool, name, level}]}`（这具身体上 `mcp_start.<id>`、`mcp.<id>` 与每个工具 `mcp.<id>.<name>` 的档位，没单独设置的是继承来的；改用 `setPermission`）与 `contents: {tools: [{name, description}], resources: [{uri, name, description, mimeType?}], templates: [{uriTemplate, name, description}], prompts: [{name, description, arguments: [{name, required, description}]}]}`（连上之后才有）；没有这个来源为 `null` |
| `mcp.add` | `{server, secrets?}` | 新增来源：`server` 同 `config/mcp.json` 的一项（`id` 可省，按 `title` 生成；见 MCP §1）；`secrets` 为要存进 `secrets/` 的凭据（stdio：环境变量名 → 值；远程：请求头名 → 值，如 `{"Authorization": "Bearer …"}`），写成 `secrets/mcp_<来源>_<名字>`（0600），配置里只留引用，任何接口都不再返回值。返回 `SourceView`；启用的立即尝试启动（经 `mcp_start.<id>`） |
| `mcp.update` | `{id, enabled?, sync?}` | 启停、改同步方式（多端同步 / 仅本机；改成仅本机时其他身体上的副本删除）；即时启停 |
| `mcp.remove` | `{id}` | 删除来源，连同 OAuth 令牌与为它保存的凭据；多端同步的其他身体一起删。返回是否存在 |
| `mcp.restart` | `{id}` | 重新连接（登录之后、出错之后、手改配置之后） |
| `mcp.login` | `{id}` | OAuth 登录：`{url}` 为要在系统浏览器里打开的授权地址（https；回调回到 `/mcp/oauth/callback`），或 `{authorized: true}`（已有可用令牌或刷新成功，已重新连接） |
| `mcp.loginFinish` | `{url}` | 控制台不在运行基座那台设备上时：把浏览器最后停下的 `http://127.0.0.1:…/mcp/oauth/callback?…` 地址粘贴回来，与回调等价 → `{id}` |
| `mcp.logout` | `{id}` | 删除这具身体上该来源的 OAuth 令牌，重新连接（之后显示需要登录） |
| `plugins` | — | `{installed: [{name, version, description, source, catalog?, marketplace?, commit?, installedAt, mcp[], skills[], commands: [{name, description}], agents: [...]}], marketplaces: [{name, source, added, updated, description, owner, plugins: [{name, description, version, category, keywords, homepage, license, author, source, installed}], error?}], recommendations: [{id, name, reason, conv, ts}], catalog: [{id, name, description, category, license, source, maintainer, transport, installed, outward?}]}` |
| `plugins.catalog` | `{query?}` | 推荐目录里与查询相关的条目（完整定义，含安装方式与要填的值） |
| `plugins.preview` | `{source}` 或 `{catalog}` 或 `{marketplace, plugin}` | 预览：`source` 为本地目录的绝对路径、https git 地址或 GitHub 的 `owner/repo`。返回 `{plan, kind: plugin｜catalog, name, version, description, author, homepage, license, source, mcp: [{key, id, title, transport, command?, args?, url?, oauth, sync, inputs: [{key, label, target: env｜header｜arg, name?, secret?, required?, format?, placeholder?}], problem?}], skills: [{name, description, files[], skipped[], conflict?}], commands, agents, hooks, warnings[], installed?, outward?, setup?}`：`problem` 为这一项在这具身体上装不了的原因（找不到命令、地址不是 HTTPS），`conflict` 为灵魂仓库里已有同名技能（不覆盖），`installed` 为已装的版本（这次是更新），`outward` / `setup` 为推荐目录条目的对外操作提醒与首次设置说明。预览 30 分钟有效 |
| `plugins.install` | `{plan, inputs?, skip?, enable?, replace?}` | 确认安装：`inputs` 为 `{来源 key: {输入 key: 值}}`（`secret` 的进 `secrets/`），`skip` 为 `{mcp?: [key], skills?: [名]}`，`enable` 缺省真（装好就启用，启动仍经闸门），`replace` 更新已装的同名插件（沿用来源 id、登录与凭据）。缺必填值时报错、什么都不写。技能写进灵魂仓库并推送，返回安装记录（同 `plugins` 的 `installed` 一项）；写时间线 `kind: plugin` 与她的日记 |
| `plugins.cancel` | `{plan}` | 放弃一次预览（删暂存目录），返回是否存在 |
| `plugins.uninstall` | `{name, keepSkills?}` | 卸载：去掉它加的来源（连同登录与凭据）、技能（`keepSkills` 为真时保留）与包，返回是否存在 |
| `plugins.marketplace.add` / `.refresh` / `.remove` | `{source}` / `{name}` / `{name}` | 插件目录（Claude Code 插件市场的 `.claude-plugin/marketplace.json`）：`source` 为本地目录、https git 地址、`owner/repo`，或直接指向 marketplace.json 的 https 地址；返回 `{name, owner, description, plugins, warnings}`；去掉目录不影响已装的插件 |
| `plugins.dismiss` | `{id}` | 不采纳她的一条推荐，返回是否存在 |

**调节与安全**

| 方法 | 参数 |
|---|---|
| `activity` | `{value}`（0–4） |
| `pause` | `{paused}` |
| `personality` | `{changes: {"tau.curiosity": 2, …}}`（有界） |
| `stop` / `unstop` | `{reason?, scope?: all｜body}` / —（多具身体时急停缺省全网生效；`scope: "body"` 只停这具身体，别处的解除清不掉它） |
| `permissions` / `setPermission` | — / `{id, level: allow｜review｜ask｜deny}`（`review` 交给审核模型；见 §3 `permissions.*`：「执行命令」为允许时，其他类别挡不住她；档位不认得时报错） |
| `sentinel` / `setSentinel` | — / `{enabled?, model?, timeoutMs?, classes?, onFailure?, hostMode?}` | 安全审核（ARCHITECTURE §8.0）：`{config, classes: [{id, label, risk: low｜high}], models: [{id, label}]}`；`config` 同 §3 `guard.sentinel.*`，`classes` 为可选的风险类别，`models` 为可选的审核模型（模型页里启用的）。`setSentinel` 只改给出的键，类别只收认得的，范围外的值取缺省；全网共用，写审计 `sentinel.config`，返回新的同一结构 |
| `approvals` / `decide` | — / `{id, approve, note?, body?}`（多具身体时含其他身体上等待批准的，带 `body`；批准转给那具身体处理。`body` 取审批列表里的那一项：给了就只找那具身体上的；不给而编号在几具身体上都有时不处理，返回 `false`） |
| `budget` / `setBudget` | — / `{dailyTokens?, dailyCostUsd?, minBattery?, maxTempC?}` |
| `config` / `setConfig` | — / `{timezone?, brain?, heart?}` |
| `restart` | — （进程退出，由守护者拉起） |
| `gateway.rotateToken` | — → `{token}`：换一个新的网关令牌并保存，断开其他所有连接（关闭码 4001，它们手里的旧令牌作废），新令牌只返回给发起的这个连接；写审计 |
| `selfUpdate` | `{version?}` | 让这具身体在后台重跑一键安装脚本，把运行基座、网页控制台与原生控制台升到 `version`（控制台看到的最新发布；不给时装 npm 的 latest，它可能晚于发布）并重启服务一次：`{started, message, status}`。同一时间只跑一个升级（进行中再调只返回说明）。由适配器的 `upgrade(version?)` 实现（Linux：`systemd-run --user` 起临时单元脱离服务的 cgroup，没有 systemd 用 `setsid`；日志 `logs/upgrade.log`，每次升级的开始与退出码带编号）；Windows：在后台脱离进程树重跑 `install.ps1`（环境变量 `QUETZAL_VERSION` / `QUETZAL_UPGRADE=1` / `QUETZAL_UPGRADE_ID`），有人登录时经身体助手在用户桌面里启动，以便需要提权时能弹 UAC，日志同样写 `logs\upgrade.log`；安卓没有（App 自己升级） |
| `quit` | — | 退出（桌面托盘的「退出」）：这一次停掉后台服务，开机自启照旧。由适配器的 `quit()` 实现（Linux：systemd 用户服务 `stop --no-block`；守护循环放 `state/quit`，循环在运行基座退出后看到它就自己也退出；都没有直接结束进程）；没有的身体直接结束进程（安卓的前台服务会重新拉起） |
| `selfUpdateStatus` | — | 最近一次升级：`{running, id?, startedAt?, target?, exitCode?, step?, stalled?}`（`step` 为安装脚本最后一步或报错；升级日志 15 分钟没有新内容、又还没结束为 `stalled`）。控制台据此显示进度、失败原因与「重试」，重开控制台时接着显示进行中的升级 |
| `supervision` / `setSupervision` | — / `{enabled}` | 守护开关（开机自启 + 退出后自动重启，一个开关管两件事）：`{available, enabled, kind: systemd｜runit｜loop｜task｜none, detail}`。由身体适配器实现：Windows 是安装包注册的计划任务 `\Quetzal\Runtime-Boot` / `Runtime-Logon`（`kind: task`；关 = 标志文件 `state\supervise.off`，并试着停用两个任务），Linux 是 systemd 用户服务（关 = disable + 覆盖片段 `Restart=no`）或一键安装脚本的守护循环（关 = 标志文件 `state/supervise.off` + 删开机项），安卓（App 内置）是 App 前台服务的「开机与升级后自启、退出后重启」开关（`kind: loop`，经身体接口），旧的 Termux 安装是 runit `down` 文件 + Termux:Boot 开机脚本；`available` 为假（手动部署）时控制台不显示开关。关闭只影响之后：正在运行的进程不受影响 |

**记忆**

结构化版本键为 `id@version`。下列 dotted RPC 是认证管理者入口；个人确认和整体结果反馈不暴露为 agent 模型工具。模型侧 `memory_records` / `memory_evolve` 另按当前用户/会话/任务范围限制。

| 方法 | 参数与返回 | 说明 |
|---|---|---|
| `memory` | — → `{soul, memory[], user[], loops[]}`（`loops` 为进行中的目标的旧视图 `[{id, text, ts}]`：#23 起未完成的念头就是没有步骤的目标，见 `goals`） |
| `memory.records` | `{state?, kind?}` | 当前 agent 的结构化记忆全部版本；可过滤 candidate/active/superseded/archived 与 fact/preference/episode/experience；含 scope、来源、验证及父版本 |
| `memory.confirm` | `{key}` | 管理者明确确认个人事实或偏好语义；核对真实用户来源，返回确认后的 MemoryRecord。模型工具不能调用此管理确认入口 |
| `memory.feedback` | `{episodeId, status: success / failure, session?}` | 管理者确认已完成轨迹的整体任务结果；核对当前 agent 及 prime.origins 中原会话，可选 session 须一致；新增真实 user 消息作为晚到反馈，不重跑工具。按 brain 学习限额返回 `{episode, records, learned, status: learned / skipped / failed, reason?}` |
| `memory.archive` / `memory.rollback` | `{key}` | 当前 agent 版本归档 / 从合格历史版本生成新活动版本，保留来源与历史；返回 true，修改经审计与自动灵魂同步 |
| `memory.evolve` | `{operation, keys}` | rewrite/generalize/combine 的生产经验提案与独立评价；1–4个当前 agent 版本键，返回 `{records, status: evolved / failed, reason?}`；缺基线不自动替代原经验 |
| `context.status` | `{conv}` | 本机最近一次该会话的准备计划或 null：turn/model、保守 estimate、selectedIds/skippedMemoryIds/compactedIds、projections、summary、state、at；不是原始秘密或真实tokenizer计数 |
| `editMemory` | `{target: memory｜user, action: add｜replace｜remove, content?, oldText?}` |
| `setSoul` | `{text}` |
| `journalList` / `journal` | — / `{body, day}` |
| `notes` / `note` / `search` | — → `[{name, title, summary, mtime, size}]`（`name` 为目录树中的相对路径，如 `身体/handset/硬件`）/ `{name}` / `{query}`（按相关度检索对话、笔记、日记与常驻记忆） |
| `goals` / `goals.close` | `{closed?}` / `{id, outcome?: done｜dropped, note?}` | 她的长期目标（#23，全网同步）`[{id, title, detail, steps: [{id, text, status: todo｜doing｜done｜skipped, updated}], status: open｜done｜dropped, note, created, updated, progressed, convs[], body, progress: {done, total, ratio}｜null}]`（`progressed` 为最近推进的时刻，`convs` 为关联的会话，`body` 为最近在哪具身体上改的；`progress` 不算跳过的步骤，没有步骤时为 `null`；`closed` 为真时连同 30 天内关闭的）/ 替她关闭一个（缺省标为完成，`note` 缺省写明是控制台关闭的；记审计），返回进行中的。新建与推进由她用 `goal` 工具（`open_loop` 是没有步骤的目标） |
| `reminders` / `reminders.cancel` | — / `{id}` | 她答应的提醒 `[{id, text, at, when, repeat}]`（`when` 为下一次的当地说法，软提醒是时间窗的说法，`repeat` 为重复规则的说法、一次性为空）/ 取消一条，返回剩下的。设提醒由她用 `reminder` 工具 |
| `soulConfig` / `setSoulConfig` / `soulKey` / `syncSoul` | 灵魂仓库地址（只接受 SSH 地址，见规范 §7）与访问方式 `sshMode`（`deploy` 本机部署密钥 / `custom` 指定私钥 `sshKeyPath` / `system` 系统 ssh 配置）、本机部署公钥（没有则生成）、立即同步；`status` 含 `lastPull`、`lastPush`、`lastError`（落盘，重启不归零）与 `unpushed`（她碰过、已提交但还在本机等待推送的改动数）。她每次工具调用后碰了灵魂目录都会立即提交、3 秒去抖推送（见 SOUL_SYNC.md）；推送失败与冲突副本由基座直接提醒她，时间线 `kind` 为 `soul` |
| `agent` / `setAgent` | — / `{displayName?, name?, pronouns?, description?, color?, language?}`（写入 agent.json 并同步；她自己改用工具 `edit_identity`，留时间线 `identity`） |
| `bodies` | — → 灵魂仓库中登记的身体 |
| `soulHistory` / `soulShow` / `soulRevert` | `{limit?}` / `{hash}` / `{hash}`：记忆历史、查看差异、撤销（生成反向提交） |

**网状层（多具身体直连，见 ARCHITECTURE §6.2）**

| 方法 | 参数 | 说明 |
|---|---|---|
| `mesh` | — | `{server, bound, account, fingerprint, available, state, error, clockSkewMs, peers, binding}`：`state` 为 `off`（没配地址、没绑定或缺组件）/ `connecting` / `online` / `offline` / `unauthorized`（令牌失效，需重新绑定）；`fingerprint` 为本机节点公钥指纹（绑定时与网页上的核对）；`available` 为原生组件能否加载；`peers` 为同一 agent 的其他身体 `[{body, kind, version, online, lastSeen, link: none｜idle｜connecting｜authenticating｜open｜closed, path?: {local, remote, rtt}, via?, error?, attempts, since, lastOpen, candidates?: {local, remote}, keyOk, registered, fingerprint, pinMismatch?, settings}]`（`online` 为同步服务说它在线，或此刻连得上它；`link` 为 `open` 时连得上：直连，或直连不通、经 `via` 这具身体中转（此时没有 `path`）；`path` 的 `local` / `remote` 为候选类型 host / srflx / prflx / relay，不含地址；`attempts` 为直连连续失败的次数，`since` 为直连进入当前状态的时刻，`lastOpen` 为最近一次直连上的时刻（毫秒，没有为 0）；`candidates` 为最近一次直连尝试双方交换过的候选类型（诊断：哪一方拿不到中转地址）；`keyOk` 为同步服务转告的公钥与灵魂仓库登记的一致、且与钉住的一致；`registered` 为本机灵魂仓库里有没有它的登记（没有就连不上，等灵魂同步拉到）；`error` 也包括最近一次拒绝它的连接请求的原因；`settings` 为与它最近一次对齐设置的结果 `{at, took: [采用了它的哪些设置，中文名], error?}` 或 `null`；`pinMismatch` 为真表示它在灵魂仓库里的公钥变了或从灵魂桥变成了运行基座，确认（`mesh.acceptPin`）之前不连接）；`binding` 为进行中的绑定 `{code, uri, expires}` 或 `null`。也在 `status` 的 `mesh` 字段里 |
| `mesh` 的 `coordinator` 字段 | — | 此刻持有心跳的身体（没有连上其他身体时就是自己）；`status.heart.follower` 为真表示这具身体的心脏在跟随协调者 |
| `mesh.setServer` | `{server}` | 设置同步服务地址（只接受 HTTPS；本机地址除外）；换地址需要重新绑定。空字符串恢复官方同步服务（没有绑定时网状层不连接） |
| `mesh.bind` | — | 开始绑定：向同步服务申请设备码，返回的状态里 `binding.code` 是要在网页上输入的短码、`binding.uri` 是带短码的链接；批准后自动保存令牌并连上（经 `mesh` 事件推送进展） |
| `mesh.setPriority` | `{priority}` | 这具身体当协调者的优先级（0–100，越大越优先；适合一直开着、接着电源的身体） |
| `mesh.cancelBind` / `mesh.unbind` | — | 取消进行中的绑定 / 解绑（通知同步服务作废令牌，删除本机的绑定；节点密钥保留） |
| `mesh.acceptPin` | `{body}` | 确认某具身体新的节点公钥（或从灵魂桥变成运行基座）：钉住灵魂仓库里现在登记的，重新连接；返回同 `mesh`。只在 `peers` 里那一项 `pinMismatch` 为真、并且核对过指纹时用 |

推送事件 `mesh`：数据同 `mesh` 方法，网状层状态变化时推送（绑定进展、同步服务连接、各身体的连接与路径）。

**身体之间的方法**（网状层内部，经节点密钥认证过的连接，不在网关上；只读成员（灵魂桥）只能调用 `presence.digest`）：工作区跟着任务走新增 `workspace.pull`（会话的全部工作区，含墓碑，连上时补齐用）与事件 `workspace`（本机改了的工作区，实时复制；只收发来的身体自己写的）、`body.workspace`（这具身体的工作区概况；带 `{dir}` 时返回 `{dir, exists}`：这个目录在这里能不能用作工作区）、`agent.run`（`{name, goal, persona?, scope?, background?, context?, maxSteps?, dir?, parent: {conv, channel}}`：在这具身体上派出子 agent，按这边「会话」类别的闸门，返回 `{id, name, dir?, record}`，`record` 为它的子 agent 记录，派出的身体立即并入）；续做新增 `work.take`（`{kind: agent｜turn, id, record?}`：请协调者决定由发来的身体续做这件事，返回 `{ok, record?}`：给了与否、最新的记录）与 `agent.status` / `agent.message` / `agent.stop`（`{id, text?}`：查看、对话、停止在这具身体上跑的子 agent，不在这里跑的返回说明；本机派出、续做接手与经工作区在别处派出的都走这一套）；共用设置新增 `goals` / `taskStates` / `agents` / `turns` 分区（按条目合并）；`tool.call` 多一个可选的 `cwd`（在这个目录里执行），结果多一个可选的 `workdir`（这条命令让哪个目录成了工作的地方）。

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
| `providers.quick` | `{catalogId, key}` | 快速接入：按公共目录建（或沿用同一个）供应商并换上这把 Key → 问供应商有哪些模型 → 在目录里挑能调用工具的（稳定版优先、发布日期新的优先），逐个试通，留两个接在全局顺序最后，比主力便宜的那个设为内省模型。返回 `{ok, provider, models, message}`；一个都不通时一切恢复原样（原来的 Key 与模型照常可用），`message` 为原因 |
| `remoteModels` | `{providerId}` | 从供应商接口拉取模型 ID 列表 |
| `testModel` | `{providerId, model}` | `{ok, latencyMs, message}` |
| `moveModel` / `toggleModel` | `{modelId, delta}` / `{modelId}` | 快捷调整全局顺序与启停 |

供应商配置结构：

模型的 `context` 用于带 `prepareForModel` 的生产工具循环请求，每个候选/故障转移重新从完整来源准备窗口视图；无有效 context 时使用 `brain.contextWindow`。文本采用UTF-8字节保守估计，不是真tokenizer。输出实际取请求上限、模型 `maxTokens` 与窗口四分之一中的较小值（至少1）。quick内省、摘要和记忆选择等直接chat请求不等于都经同一个动态上下文管理器。`vision` 为可选看图设置，优先于公共目录。

```ts
interface Provider {
  id: string; catalogId: string; name: string; baseUrl: string; enabled: boolean;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  keys: { id: string; label: string; lastFour: string; enabled: boolean; secret?: string /* 仅新增时提交 */ }[];
  models: { id: string; name: string; enabled: boolean; context: number; maxTokens: number; sortOrder: number; vision?: boolean; cost?: { input: number; output: number } }[];
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
  hands?: Hands;                           // 看屏幕与操作其他应用（计算机使用），见下；没有屏幕的身体不提供（可以是 getter）
  supervision?: { status(): Promise<SupervisionState>; set(enabled: boolean): Promise<void> }; // 守护开关：开机自启 + 退出后自动重启；SupervisionState = {available, enabled, kind, detail}
  upgrade?(): Promise<string>;             // 从控制台升级：后台重跑安装，立即返回一句说明（Linux 适配器有；安卓由 App 升级）
  deviceId?(): Promise<string | undefined>; // 设备自身稳定的标识（取不到为 undefined）：核心只用它的哈希派生身体 uuid（body/uuid.ts），原始值不进日志、审计、灵魂仓库与网状层
  onNetworkChange?(cb: (detail: string) => void): () => void; // 平台知道默认网络换了时立即调用 cb，返回停止监听的函数；网状层据此立即检查连接（另有每 5 秒的轮询兜底）
}
interface RawSample {
  battery?: { level: number; charging: boolean; tempC?: number; health?: string };
  lux?: number; motion?: number; screenOn?: boolean;
  extra?: Record<string, string | number | boolean>;
}
// 手：坐标一律是整屏截图的像素（原点在截图左上角）；多显示器偏移、DPI 由适配器换算。出错抛 Error（消息给她看）。
interface Hands {
  status(): Promise<HandsStatus>;          // {ready, reason?, screenshot, tree, input, detail?}：ready 为假时 reason 说清楚怎么才能用
  screenshot(maxEdge?: number): Promise<{ file: string; width: number; height: number }>; // width / height 是缩之前的屏幕像素
  snapshot(): Promise<ScreenSnapshot>;     // 前台窗口的无障碍树：{width, height, app?, window?, elements: ScreenElement[], note?}
  click(at: ScreenPoint, opts?: { button?: "left" | "right" | "middle"; count?: number; holdMs?: number }): Promise<void>;
  drag(from: ScreenPoint, to: ScreenPoint, durationMs?: number): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", amount: number, at?: ScreenPoint): Promise<void>; // amount：滚轮格数
  type(text: string, at?: ScreenPoint): Promise<void>;
  key(keys: string[]): Promise<void>;      // 规范键名，修饰键在前：["ctrl","shift","t"]、["enter"]、["back"]
  openApp(id: string): Promise<string>;    // 只打开已安装的应用（包名 / 应用 ID / .desktop 名 / 显示名）
  windows?(): Promise<ScreenWindow[]>;     // {id, title, app?, focused?, x?, y?, w?, h?}
  focusWindow?(id: string): Promise<void>;
}
interface ScreenPoint { x: number; y: number; ref?: string } // ref：snapshot 给元素的不透明引用，按编号操作时原样交回
interface ScreenElement {
  role: string;  // button、link、text、input、checkbox、radio、switch、combobox、slider、tab、menu、menuitem、list、item、image、toolbar、dialog、window、group、scroll、other
  name?: string; value?: string; x: number; y: number; w: number; h: number; ref?: string;
  clickable?: boolean; editable?: boolean; scrollable?: boolean; enabled?: boolean; focused?: boolean; selected?: boolean; checked?: boolean;
}
```

键名：修饰键 `ctrl`、`alt`、`shift`、`meta`（Win / Super / Command）；`enter`、`esc`、`tab`、`space`、`backspace`、`delete`、`insert`、`home`、`end`、`pageup`、`pagedown`、方向键 `up` / `down` / `left` / `right`、`f1`–`f24`、单个字符；手机的全局动作 `back`、`home`、`recents`、`notifications`、`quick_settings`、`lock`、`power`。核心先把别名（`cmd`、`win`、`return`、`escape`、`pgup`……）规范好再交给适配器，适配器对按不出来的键抛错。

核心据 `hands` 提供 `screen_read`、`screen_capture`、`screen_click`、`screen_drag`、`screen_scroll`、`screen_type`、`screen_key`、`app_open`（适配器有 `windows` / `focusWindow` 时再加 `window_list` / `window_focus`），全部归能力类别 `hands`（操作屏幕与应用），见 [架构 §5.5](ARCHITECTURE.md#55-手看屏幕与操作应用计算机使用)。她看到与给出的坐标是缩到长边 1280 像素的截图坐标，核心负责与屏幕像素换算；按编号操作时核心把元素中心点与 `ref` 一起交给适配器。

约束：

- 适配器提供的 `notify()` 的内容可能含配对码（连同证书的短指纹）：写日志时应当只在没有别的办法让人看到时才写内容（Linux 适配器：有桌面通知时日志只记标题）；

- 适配器只能 `import type` 本文件的类型，不得依赖核心的其他实现；仓库自带几个平台级实现：`runtime/adapters/android/`（任意安卓手机）构建为 `dist/android.mjs`，随 Quetzal App 内置；`runtime/adapters/termux/`（旧的 Termux 安装：安卓手机 + Termux:API）构建为 `dist/termux.mjs`；`runtime/adapters/linux/`（任意 Linux 机器）构建为 `dist/linux.mjs`，由 npm 包 `@plutokeating/quetzal` 随运行基座放到 `~/quetzal/current/`；
- 适配器从 `QUETZAL_ADAPTER` 环境变量或配置项 `adapter` 指定的路径加载；加载失败时核心回退到通用适配器（无传感器）；
- 工具的 `permission` 必须是闸门已知的能力类别之一（见 `guard/guard.ts`），否则按「允许」处理；
- 工具做不成时抛出错误（核心把这次调用标为失败、写明给她）；不要只返回一句「失败」的文字，那样会被当成成功；
- `hands` 的操作由运行基座进程直接执行，不经过 agent 的命令沙箱：`openApp` 只能打开已安装的应用，不能成为执行任意程序的出口；`snapshot` 不要交出密码框的内容；
- `deviceId()` 返回的是敏感信息：适配器自己也不得写进日志或工具结果。各平台实现：Linux `/etc/machine-id`（退回 `/var/lib/dbus/machine-id`）、Windows 注册表 `HKLM\SOFTWARE\Microsoft\Cryptography` 的 `MachineGuid`、安卓 App 身体接口的 `GET /v1/device-id`、Termux 尽力用 `settings get secure android_id`（多数手机上没有权限，取不到）。

安卓适配器经 Quetzal App 的**身体接口**取得身体能力：App 在 127.0.0.1 的随机端口提供 HTTP/1.1 接口（`Authorization: Bearer <令牌>`，令牌 256 位、每次启动重新生成），端口与令牌写在 `QUETZAL_HOME/secrets/body.json`（`{port, token}`，0600）。接口：`GET /v1/info`（机型、光线与加速度传感器名、有没有相机与闪光灯）、`GET /v1/sample`（`battery {level, charging, tempC, health}`、`plugged`、`lux`、`motion`、`screenOn`）、`GET /v1/sensors`、`POST /v1/sensor {name}` → `{values}`、`POST /v1/notify {title, text}`、`POST /v1/play {file}`、`POST /v1/stop`、`POST /v1/vibrate {ms}`、`POST /v1/torch {on}`、`POST /v1/clipboard {text?}` → `{text}`、`POST /v1/location` → `{latitude, longitude, accuracy, ageMinutes}`（定不到新位置时为最近一次已知位置）、`POST /v1/photo {camera, file}`、`POST /v1/record {seconds, file}`、`GET/POST /v1/supervision {enabled}`、`GET /v1/device-id` → `{id}`（`Settings.Secure.ANDROID_ID`，只用来派生身体 uuid）、手（App 的无障碍服务 `HandsService`，用户在系统设置里开启后才可用，没开时返回 `{ok: false, error}` 说明怎么开）：`GET /v1/hands` → `{enabled, connected, screenshot}`、`POST /v1/hands/snapshot {limit}` → `{width, height, app, window, elements: [{c 类名, n 名字, v 值, b [左, 上, 宽, 高], r 引用, k 可点, e 可编辑, s 可滚动, en, f, se, ch}]}`、`POST /v1/hands/screenshot {file, maxEdge}` → `{width, height}`（Android 11+，JPEG）、`POST /v1/hands/click {x, y, ref?, button?, count?, holdMs?}`、`POST /v1/hands/drag {x1, y1, x2, y2, ms}`、`POST /v1/hands/scroll {direction, amount, x?, y?}`、`POST /v1/hands/type {text, x?, y?, ref?}`、`POST /v1/hands/key {kind: global|edit, action}`（global：back / home / recents / notifications / quick_settings / lock / power；edit：enter / backspace / delete / copy / cut / paste / select_all）、`POST /v1/hands/open {id}` → `{app, package}`、`GET /v1/hands/windows` → `{windows}`、`POST /v1/network {seq}` → `{seq, transport}`（长轮询：App 注册了系统的默认网络回调，网络、传输方式、是否验证过能上网或本机地址变了就把 `seq` 加一；给的 `seq` 与现在的不同就立即返回，否则最多等 50 秒；`transport` 为 wifi / cellular / ethernet / vpn / other / none，不返回地址；安卓适配器的 `onNetworkChange` 用它）。成功 `{ok: true, …}`，失败 `{ok: false, error}`；文件路径必须在 `QUETZAL_HOME` 之内；请求体最大 64 KiB。工具与 Termux 适配器同名同参数。

Termux 适配器提供：`sample()` 的电量 / 充电 / 体温 / 健康（`termux-battery-status`）、光照与运动（`termux-sensor`，传感器按名字探测，没有就不报）；`notify()`（带「打开 Quetzal」按钮）、`playAudio()` / `stopAudio()`（`termux-media-player`）；工具 `take_photo`（camera）、`record_audio`（microphone）、`location`（location）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device）。不提供 `speak`（很多手机没有系统 TTS 引擎），说话由运行基座的 `voice_speak` 完成。环境变量：`QUETZAL_HOME`（媒体保存位置 `data/media/`）、`QUETZAL_CONSOLE_ACTIVITY`（通知按钮打开的界面，默认 `xyz.quetzal.console/.MainActivity`）。

Linux 适配器提供：`sample()` 的电量 / 充电 / 健康（`/sys/class/power_supply`，跳过蓝牙鼠标等外设电池；`charging` 在「Not charging」且外接电源在线时也为真）、电池自身温度（`temp` 节点，笔记本少有），`extra` 里的 CPU 温度（`/sys/class/thermal`，不冒充体温，因为心脏与听觉按手机电池的 45°C 抑制）与电源来源；`describe` 含发行版（`/etc/os-release`）、是否笔记本、有没有桌面、摄像头与声卡；`notify()`（有桌面时 `notify-send`，同时写到标准输出即服务日志，没有桌面的机器从日志里看配对码）、`playAudio()` / `stopAudio()`（`pw-play` / `paplay` / `ffplay` / `mpv`，WAV 还可 `aplay`）；工具 `take_photo`（camera：`ffmpeg` + `/dev/video0`）、`record_audio`（microphone：`arecord` / `pw-record` / `parecord` / `ffmpeg`）、`clipboard`（device：`wl-clipboard` / `xclip` / `xsel`）、`open`（device：`xdg-open`）。没有图形界面时与界面相关的工具直接说明，不报错崩溃。有桌面会话时提供 `hands`（`adapters/linux/hands.ts`）：无障碍树走 AT-SPI（`python3` + gi 的 Atspi 2.0），输入 X11 用 `xdotool`、Wayland 用 `ydotool`（要 `ydotoold`）/ `wtype`，截图 Wayland 下 `grim` / `gnome-screenshot` / `spectacle`、X11 下 `scrot` / `gnome-screenshot` / `spectacle` / `import`，窗口 X11 下 `wmctrl`，打开应用只认 `.desktop`（`gtk-launch` / `gio launch` / `kioclient`）；服务环境里缺 `DISPLAY` / `WAYLAND_DISPLAY` / `DBUS_SESSION_BUS_ADDRESS` 时按 `XDG_RUNTIME_DIR` 与 `/tmp/.X11-unix` 补齐。同样不提供 `speak`。环境变量只有 `QUETZAL_HOME`。

Windows 适配器的 `hands`（`adapters/windows/hands.ts`）：PowerShell 5.1 + .NET 的 UI Automation 读前台窗口的控件视图，`SendInput` / `SetCursorPos`（每显示器 DPI 感知）模拟鼠标键盘与 Unicode 文字，截图按需缩小存 JPEG，顶层窗口列表与 `SetForegroundWindow` 切换，打开应用只认开始菜单里的（`Get-StartApps` → `shell:AppsFolder\<AppID>`）。运行基座在会话 0 时经身体助手 `windows-body.mjs` 的 `POST /call {op: "hands.*", args}` 转交。

## 3. 配置项（`config/quetzal.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `body` | `default` | 身体名称（日记目录名）；安装器写为机型名 |
| `adapter` | `""` | 适配器模块路径（安卓 App 与 Termux 部署用环境变量 `QUETZAL_ADAPTER` 指定） |
| `timezone` | 系统时区（拿不到时 `Asia/Shanghai`） | 生物钟与日记使用的时区 |
| `heart.activity` / `baseRatePerHour` / `paused` | 1 / 4 / false | 活跃度、饱和醒来率、暂停 |
| `budget.*` | 2,000,000 tokens / $5 / 15% / 45°C | 每日 token / 花费预算（多具身体时按全网合计）用尽后，自主醒来倍率乘以 0.05；不是模型调用的硬上限。最低电量与最高温度用于自主活动抑制和听觉状态判断 |
| `channels.feishuHolder` | "" | 多具身体时持有飞书长连接的身体（全网共用）；空为这具身体自己连 |
| `sharedRev` | {} | 多具身体共用的设置分区最近一次被修改的时刻（基座维护，较新的修改在身体之间生效） |
| `permissions.*` | `camera` / `microphone` / `location` / `hands` / `tool_write` 为 `review`，`mcp` / `mcp_start` 为 `ask`，其余 `allow` | 能力授权，四档：`allow` 允许、`review` 交给审核模型（ARCHITECTURE §8.0）、`ask` 每次询问（人工审批）、`deny` 禁止（类别含 `session`：会话与子 agent；`body`：跨身体操作；`tool_write`：造工具，写之后会被执行的代码）。一个工具按它所属类别中最严的一个检查（`deny` > `ask` > `review` > `allow`）：自造工具 = 声明的类别 + `shell`，`tool_write` = `self_modify` + `tool_write`。**`shell`（执行命令）为 `allow` 时，其他类别的限制挡不住她**：命令能做设备工具、联网、改文件能做的一切（沙箱只藏起密钥目录等，见 ARCHITECTURE §8.1）。默认允许是产品上的取舍；`allow` 之下的风险类别（真实环境命令等）另由审核模型把关（`guard.sentinel.classes`）。`host_mode`（真实环境）属于 `shell`：`shell` 为 `deny` 时她连请求都发不出；不为 `deny` 时请求按 `guard.sentinel.hostMode` 交给审核模型或对方。旧配置里前五类为 `ask` 的，升级后第一次启动改为 `review`，审计里对方明确设为 `ask` 的保留 |
| `guard.sentinel.enabled` | true | 安全审核开关。关掉时 `review` 档位退回人工审批，`allow` 之下的风险类别不再审核 |
| `guard.sentinel.model` | ""（快速模型） | 审核用的模型：模型页里的模型 id；空为快速模型（quick 路由），其余照全局顺序作为故障转移 |
| `guard.sentinel.timeoutMs` | 20000 | 一次审核最多等多久，范围 1000–120000 毫秒 |
| `guard.sentinel.classes` | `host_shell`、`remote_exec`、`outbound`、`mcp_write`、`destructive`、`credentials`、`tool_write`、`hands` | `allow` 档位之下也送审的风险类别（按工具语义，不看命令文字）：真实环境里的命令、经 `body_call` 到别的身体执行命令、醒来时对外发消息、MCP 工具里来源没声明只读的、删除找不回的数据（`tool_delete`、MCP 声明破坏性的）、账号与凭据（`secret_sync`、带新密钥的 `voice_config`）、造工具、操作屏幕与应用；另有 `sandbox_shell`（沙箱里的普通命令，缺省不审） |
| `guard.sentinel.onFailure` | `by_risk` | 审核超时或失败：`by_risk` 低风险类放行、高风险类拦下并说明；`allow` 一律放行；`block` 一律拦下；`ask` 转人工审批 |
| `guard.sentinel.hostMode` | `review` | 她请求进入真实环境：`review` 交给审核模型（理由充分即放行），`ask` 每次人工审批 |
| `permissions.mcp_start.<来源ID>` / `permissions.mcp.<来源ID>.<工具别名>` | 继承来源级 / 类别级，缺省 ask | MCP 来源启动与工具调用（含资源与提示词）分别授权；带点子类别属于本机，总类别 mcp / mcp_start 仍按现有权限分区共享；来源配置在 `config/mcp.json`（远程来源缺省多端同步，见 [MCP §5](engine/MCP.md)）。`plugins`（她找插件、推荐、取用插件命令）缺省 allow |
| `brain.maxOutputTokens` | 4096 | 请求输出上限；实际候选还受模型 maxTokens 与窗口四分之一限制，生产步数仍不设硬上限 |
| `brain.contextWindow` | 65536 | 模型没有有效 context 配置时的窗口缺省值；范围1024–2000000，实际候选按自己的 context 重算 |
| `brain.contextSummaryTokens` | 1024 | 动态摘要正文预算，范围128–4096；按UTF-8字节保守估计限制，不是真tokenizer |
| `brain.contextSummaryModelTokens` | 1024 | quick摘要模型生成预算，范围128–4096；含推理开销，不改变最终保留摘要的预算 |
| `brain.contextSummaryTimeoutMs` | 10000 | 自动摘要硬等待预算，范围100–60000毫秒；超时仍按原文引用门禁退路处理 |
| `brain.memorySemantic` | true | 每步使用有界 quick 模型选择合格记忆；失败/超时/预算不足时退回词面门禁检索，关闭后直接词面选择 |
| `brain.memorySelectionTokens` | 256 | 选择模型输出预算，范围128–2400；推理模型可能在低预算时无JSON正文并退回词面检索 |
| `brain.memorySelectionTimeoutMs` | 5000 | 语义选择硬等待预算，范围100–60000毫秒；慢quick模型可调高，超时退回词面选择 |
| `brain.memoryLearning` | true | 轮次收尾及做梦的后台 PRIME 学习/演化；关闭不删除已有记忆，也不把候选变为事实 |
| `brain.memoryLearningTokens` | 1200 | 后台学习请求输出上限，配置范围128–4096；学习器另有自己的预算与上限 |
| `brain.memoryLearningTimeoutMs` | 15000 | 轮次后台学习有界等待，配置范围100–60000毫秒；默认不是前台对话绝对超时 |
| `feishu.*` | — | 飞书（Secret 在 `secrets/`） |
| `soul.remote` / `branch` | "" / main | 灵魂仓库（常驻记忆 MEMORY / USER 没有长度上限） |
| `gateway.port` / `gateway.host` / `gateway.lan` / `gateway.lanPort` | 7788 / `127.0.0.1` / false / 7789 | 网关（§1）：明文 HTTP 只监听本机回环的 `port`；`lan` 为真或 `host` 不是回环地址（旧配置的 `0.0.0.0`）时，在 `host`（回环时为 `0.0.0.0`）:`lanPort` 上另开 HTTPS / WSS（自签名证书，`secrets/gateway-tls.*`）。Linux 安装器的 `--lan` 写 `host: 0.0.0.0, lan: true`，`--no-lan` 写回 `127.0.0.1` 与 `false` |
| `mesh.server` / `mesh.priority` | `https://sync.quetzal.plutokeating.beer` / 0 | 同步服务地址（HTTPS；缺省为官方同步服务 `OFFICIAL_SYNC`，旧配置里为空时加载即补上；绑定令牌在 `secrets/sync.json`，节点密钥在 `secrets/mesh_ed25519`）；当协调者的优先级（越大越优先，适合一直开着、接着电源的身体） |
| `mesh.lan` | 安卓与 Linux 为 `true`，Windows 为 `false` | 同步服务连不上、或它说对方不在线时，经局域网信令（UDP，端口同 `gateway.port`）直接连记得地址的身体（`mesh/lan.ts`，见 ARCHITECTURE.md「局域网信令」）。Windows 上监听端口会弹防火墙询问，所以缺省关 |
| `hearing.enabled` / `windowMin` / `sensitivity` / `language` | false / 10 / 2 / ""（取她的偏好语言） | 听觉：开关；最近会话多少分钟内有更新就并入（0 为每句新开）；灵敏度 1 迟钝 / 2 适中 / 3 灵敏（App 的 VAD 模式）；识别语言 |
| `speech.region` / `endpoint`（只接受 Azure 的 HTTPS 域名） / `voice` / `style` / `rate` / `pitch` / `volume` / `format` | "" / "" / zh-CN-XiaoxiaoNeural / "" / 0% / 0% / 100 / audio-24khz-48kbitrate-mono-mp3 | Azure 语音（密钥在 `secrets/azure_speech_key`）；控制台「语音」页或她自己用 `voice_config` 修改 |
