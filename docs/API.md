# 接口

Quetzal 对外有两类接口：**网关 API**（控制台、主机工具使用）和**身体适配器接口**（设备仓库实现）。

## 1. 网关

缺省只监听 `127.0.0.1:<gateway.port>`（默认 7788）；配置 `gateway.host` 为 `0.0.0.0` 可对局域网开放（`npx @plutokeating/quetzal --lan`），此时配对码与令牌是唯一门槛，只在可信的局域网里这样做。`main.cjs` 旁边有 `web/index.html`（npm 安装器放的网页控制台；或环境变量 `QUETZAL_WEB_DIR` 指定）时，网关同时托管这些静态文件：`GET /` 就是控制台。

### 1.1 HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, safeMode, mode}`，无需令牌，供点火器探活 |
| GET | `/auth/local` | `{ok, token}`：只给**同一台机器上的浏览器**（连接来自回环地址、Host 是本机名、Origin（若有）也是本机），网页控制台打开即登录；其他来源 403。任何本机进程本来就读得到 `secrets/gateway.token`，所以这不扩大信任边界；ssh 隧道转发来的连接也算本机 |
| GET | `/<静态文件>` | 网页控制台（`web/` 目录存在时）：`/` → `index.html`，没有扩展名的未知路径也回退到 `index.html`（单页应用），带 ETag |
| POST | `/pair/start` | 生成 6 位配对码（5 分钟有效），通过适配器的系统通知与飞书下发 |
| POST | `/pair/finish` | `{code}` → `{ok, token}`；错误码 403（不正确）、410（失效或尝试超过 5 次） |
| GET | `/media/<文件名>?token=<令牌>` | 她的声音：控制台 App 取合成语音（`data/media/` 里的音频文件）来播放，见 `speak` 事件 |
| POST | `/hear?started=<毫秒时刻>&token=<令牌>[&stream=1&id=<标识>&bargein=1]` | 听觉。`bargein=1`：这句话打断了她的播放（App 本地已停播），以「打断」并入。`stream=1`：请求体为边说边送的 16 kHz 单声道 16 位 PCM（分块传输），基座用官方 SDK 流式识别，中间结果经 `hearing` 事件推送；否则请求体为一整句 WAV（最多 4 MiB）一次识别。→ `{ok, id, text, conv?, dropped?}`；`started` 为这句话开始的时刻，用于判断是不是她自己在说话（丢弃）。识别后以「环境声音」进入会话，见 §1.3 听觉 |
| POST | `/upload?name=<文件名>&token=<令牌>` | 上传一个附件，请求体为文件内容（单个最多 50 MiB）→ `{ok, file: {id, name, path, rel, mime, size, kind: image｜text｜file}}`；保存在 `QUETZAL_HOME/data/uploads/<日期>/` |
| GET | `/uploads/<rel>?token=<令牌>` | 下载附件（控制台预览图片）；只能访问 uploads 目录内的文件 |

### 1.2 WebSocket `/rpc?token=<令牌>`

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
| `status` | — | `{agent, version, body, adapter, heart, physical, stopped, paused, activity, usage, budget, approvals, soul, models, thought}`；`thought` 为她想分享的一句话 `{text, ts}` 或 `null`，由她用 `share_thought` 维护，更新时推送 `state` |
| `timeline` | `{limit?, before?, kind?}` | 时间线（倒序；`kind` 另有 `place`（多具身体时，这次醒来选在了哪具身体上 `{kind, reason, intent, where}`）、`mesh`（网状层的事：绑定、心跳交接、安全提醒）、`hear`（听到有人说话，没有回应）、`tool`（造了 / 改了 / 删了一个工具）、`identity`（她改了自己的身份）、`session`（切到新会话 / 压缩了上下文）、`agent`（派出 / 完成 / 停止子 agent，完成的条目带 `journal`、`process`、`steps`））。`detail` 随 `kind` 而异：`think` / `dream` 为 `{reason, intent, journal, feeling, thought?, process, steps, tokens, model}`（中断时为 `{reason, intent, error, process}`），`chat` 为 `{channel, conv, text, reply, process, steps, tokens, model}`；`process` 是这一轮的执行过程（与 `sessions.messages` 的 `process` 同构：工具卡片与中途叙述），`steps` 是每次工具调用的完整参数与结果（结果最多 1500 字） |
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
| `speech` / `setSpeech` | — / `{region?, endpoint?, key?, voice?, style?, rate?, pitch?, volume?, format?}` | 查看 / 修改配置；密钥只返回末四位，留空不改 |
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
| `permissions` / `setPermission` | — / `{id, level: allow｜ask｜deny}` |
| `approvals` / `decide` | — / `{id, approve, note?}`（多具身体时含其他身体上等待批准的，带 `body`；批准转给那具身体处理） |
| `budget` / `setBudget` | — / `{dailyTokens?, dailyCostUsd?, minBattery?, maxTempC?}` |
| `config` / `setConfig` | — / `{timezone?, brain?, heart?}` |
| `restart` | — （进程退出，由守护者拉起） |
| `selfUpdate` | — | 让这具身体在后台重跑一键安装脚本，把运行基座、网页控制台与原生控制台升到最新发布并重启服务一次：`{started, message}`。由适配器的 `upgrade()` 实现（Linux：`systemd-run --user` 起临时单元脱离服务的 cgroup，没有 systemd 用 `setsid`；日志 `logs/upgrade.log`）；安卓没有（App 自己升级） |
| `supervision` / `setSupervision` | — / `{enabled}` | 守护开关（开机自启 + 退出后自动重启，一个开关管两件事）：`{available, enabled, kind: systemd｜runit｜loop｜none, detail}`。由身体适配器实现：Linux 是 systemd 用户服务（关 = disable + 覆盖片段 `Restart=no`）或一键安装脚本的守护循环（关 = 标志文件 `state/supervise.off` + 删开机项），安卓是 runit `down` 文件 + Termux:Boot 开机脚本；`available` 为假（手动部署）时控制台不显示开关。关闭只影响之后：正在运行的进程不受影响 |

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
| `mesh` | — | `{server, bound, account, fingerprint, available, state, error, clockSkewMs, peers, binding}`：`state` 为 `off`（没配地址、没绑定或缺组件）/ `connecting` / `online` / `offline` / `unauthorized`（令牌失效，需重新绑定）；`fingerprint` 为本机节点公钥指纹（绑定时与网页上的核对）；`available` 为原生组件能否加载；`peers` 为同一 agent 的其他身体 `[{body, kind, version, online, lastSeen, link: none｜idle｜connecting｜authenticating｜open｜closed, path?: {local, remote, rtt}, error?, keyOk, fingerprint}]`（`path` 的 `local` / `remote` 为候选类型 host / srflx / prflx / relay，不含地址；`keyOk` 为同步服务转告的公钥与灵魂仓库登记的一致）；`binding` 为进行中的绑定 `{code, uri, expires}` 或 `null`。也在 `status` 的 `mesh` 字段里 |
| `mesh` 的 `coordinator` 字段 | — | 此刻持有心跳的身体（没有连上其他身体时就是自己）；`status.heart.follower` 为真表示这具身体的心脏在跟随协调者 |
| `mesh.setServer` | `{server}` | 设置同步服务地址（只接受 HTTPS；本机地址除外）；换地址需要重新绑定。空字符串关闭网状层 |
| `mesh.bind` | — | 开始绑定：向同步服务申请设备码，返回的状态里 `binding.code` 是要在网页上输入的短码、`binding.uri` 是带短码的链接；批准后自动保存令牌并连上（经 `mesh` 事件推送进展） |
| `mesh.setPriority` | `{priority}` | 这具身体当协调者的优先级（0–100，越大越优先；适合一直开着、接着电源的身体） |
| `mesh.cancelBind` / `mesh.unbind` | — | 取消进行中的绑定 / 解绑（通知同步服务作废令牌，删除本机的绑定；节点密钥保留） |

推送事件 `mesh`：数据同 `mesh` 方法，网状层状态变化时推送（绑定进展、同步服务连接、各身体的连接与路径）。

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

- 适配器只能 `import type` 本文件的类型，不得依赖核心的其他实现；仓库自带两个平台级实现：`runtime/adapters/termux/`（安卓手机 + Termux:API）构建为 `dist/termux.mjs`，由 Quetzal App 的安装器随运行基座放到手机上；`runtime/adapters/linux/`（任意 Linux 机器）构建为 `dist/linux.mjs`，由 npm 包 `@plutokeating/quetzal` 随运行基座放到 `~/quetzal/current/`；
- 适配器从 `QUETZAL_ADAPTER` 环境变量或配置项 `adapter` 指定的路径加载；加载失败时核心回退到通用适配器（无传感器）；
- 工具的 `permission` 必须是闸门已知的能力类别之一（见 `guard/guard.ts`），否则按「允许」处理。

Termux 适配器提供：`sample()` 的电量 / 充电 / 体温 / 健康（`termux-battery-status`）、光照与运动（`termux-sensor`，传感器按名字探测，没有就不报）；`notify()`（带「打开 Quetzal」按钮）、`playAudio()` / `stopAudio()`（`termux-media-player`）；工具 `take_photo`（camera）、`record_audio`（microphone）、`location`（location）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device）。不提供 `speak`（很多手机没有系统 TTS 引擎），说话由运行基座的 `voice_speak` 完成。环境变量：`QUETZAL_HOME`（媒体保存位置 `data/media/`）、`QUETZAL_CONSOLE_ACTIVITY`（通知按钮打开的界面，默认 `xyz.quetzal.console/.MainActivity`）。

Linux 适配器提供：`sample()` 的电量 / 充电 / 健康（`/sys/class/power_supply`，跳过蓝牙鼠标等外设电池；`charging` 在「Not charging」且外接电源在线时也为真）、电池自身温度（`temp` 节点，笔记本少有），`extra` 里的 CPU 温度（`/sys/class/thermal`，不冒充体温，因为心脏与听觉按手机电池的 45°C 抑制）与电源来源；`describe` 含发行版（`/etc/os-release`）、是否笔记本、有没有桌面、摄像头与声卡；`notify()`（有桌面时 `notify-send`，同时写到标准输出即服务日志，没有桌面的机器从日志里看配对码）、`playAudio()` / `stopAudio()`（`pw-play` / `paplay` / `ffplay` / `mpv`，WAV 还可 `aplay`）；工具 `take_photo`（camera：`ffmpeg` + `/dev/video0`）、`record_audio`（microphone：`arecord` / `pw-record` / `parecord` / `ffmpeg`）、`screenshot`（hands：Wayland 下 `grim` / `gnome-screenshot` / `spectacle`，X11 下 `scrot` / `gnome-screenshot` / `spectacle` / `import`）、`clipboard`（device：`wl-clipboard` / `xclip` / `xsel`）、`open`（device：`xdg-open`）。没有图形界面时与界面相关的工具直接说明，不报错崩溃。同样不提供 `speak`。环境变量只有 `QUETZAL_HOME`。

## 3. 配置项（`config/quetzal.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `body` | `default` | 身体名称（日记目录名）；安装器写为机型名 |
| `adapter` | `""` | 适配器模块路径（Termux 部署用环境变量 `QUETZAL_ADAPTER` 指定） |
| `timezone` | 系统时区（拿不到时 `Asia/Shanghai`） | 生物钟与日记使用的时区 |
| `heart.activity` / `baseRatePerHour` / `paused` | 1 / 4 / false | 活跃度、饱和醒来率、暂停 |
| `budget.*` | 2,000,000 tokens / $5 / 15% / 45°C | 每日预算（多具身体时按全网合计）与身体限制 |
| `channels.feishuHolder` | "" | 多具身体时持有飞书长连接的身体（全网共用）；空为这具身体自己连 |
| `sharedRev` | {} | 多具身体共用的设置分区最近一次被修改的时刻（基座维护，较新的修改在身体之间生效） |
| `permissions.*` | `camera` / `microphone` / `location` / `hands` 为 `ask`，其余 `allow` | 能力授权（类别含 `session`：会话与子 agent；`body`：跨身体操作） |
| `brain.maxOutputTokens` | 4096 | 每次模型调用的输出上限（步数不设上限，由 agent 决定何时结束） |
| `feishu.*` | — | 飞书（Secret 在 `secrets/`） |
| `soul.remote` / `branch` | "" / main | 灵魂仓库（常驻记忆 MEMORY / USER 没有长度上限） |
| `gateway.port` / `gateway.host` | 7788 / `127.0.0.1` | 网关端口与监听地址；`0.0.0.0` 对局域网开放（Linux 安装器的 `--lan`） |
| `mesh.server` / `mesh.priority` | "" / 0 | 同步服务地址（HTTPS；绑定令牌在 `secrets/sync.json`，节点密钥在 `secrets/mesh_ed25519`）；当协调者的优先级（越大越优先，适合一直开着、接着电源的身体） |
| `hearing.enabled` / `windowMin` / `sensitivity` / `language` / `minChars` | false / 10 / 2 / ""（取她的偏好语言）/ 2 | 听觉：开关；最近会话多少分钟内有更新就并入（0 为每句新开）；灵敏度 1 迟钝 / 2 适中 / 3 灵敏（App 的 VAD 模式）；识别语言；短于此字数当没听清 |
| `speech.region` / `endpoint` / `voice` / `style` / `rate` / `pitch` / `volume` / `format` | "" / "" / zh-CN-XiaoxiaoNeural / "" / 0% / 0% / 100 / audio-24khz-48kbitrate-mono-mp3 | Azure 语音（密钥在 `secrets/azure_speech_key`）；控制台「语音」页或她自己用 `voice_config` 修改 |
