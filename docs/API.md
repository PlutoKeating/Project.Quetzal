# 接口

Windler 对外有两类接口：**网关 API**（控制台、主机工具使用）和**身体适配器接口**（设备仓库实现）。

## 1. 网关

只监听 `127.0.0.1:<gateway.port>`（默认 7788）。

### 1.1 HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, safeMode, mode}`，无需令牌，供点火器探活 |
| POST | `/pair/start` | 生成 6 位配对码（5 分钟有效），通过适配器的系统通知与飞书下发 |
| POST | `/pair/finish` | `{code}` → `{ok, token}`；错误码 403（不正确）、410（失效或尝试超过 5 次） |
| POST | `/hear?started=<毫秒时刻>&token=<令牌>[&stream=1&id=<标识>]` | 听觉。`stream=1`：请求体为边说边送的 16 kHz 单声道 16 位 PCM（分块传输），基座用官方 SDK 流式识别，中间结果经 `hearing` 事件推送；否则请求体为一整句 WAV（最多 4 MiB）一次识别。→ `{ok, id, text, conv?, dropped?}`；`started` 为这句话开始的时刻，用于判断是不是她自己在说话（丢弃）。识别后以「环境声音」进入会话，见 §1.3 听觉 |
| POST | `/upload?name=<文件名>&token=<令牌>` | 上传一个附件，请求体为文件内容（单个最多 50 MiB）→ `{ok, file: {id, name, path, rel, mime, size, kind: image｜text｜file}}`；保存在 `WINDLER_HOME/data/uploads/<日期>/` |
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
| `say` | Windler 主动说的话（字符串） |
| `activity` | 进展 `{session, conv, origin: chat｜think｜dream, channel, ts, kind, …}`：`session` 为这一轮，`conv` 为所属会话（醒来为空），见下表 |
| `secret` | 保密输入（`pass_secret`）的状态 `{id, conv, channel, status: open｜progress｜done｜cancelled｜expired, purpose, items: [{name, hint}], got, spell, expires}`：`got` 为已收到（结束时为已保存）的项数，`spell` 为结束口令；永远不含值 |
| `hearing` | 听觉 `{id, status: partial｜final｜dropped｜kept｜ignored, text, conv?, reason?}`：`partial` 识别中的文字（流式显示）；`final` 识别完成并进入会话 `conv`；`dropped` 没进会话（太短、没听清、她自己在说话、没在听）；`kept` 她回应了（保留显示）；`ignored` 她判断不是对她说的（这条消息的 `mode` 标为 `ignored`，控制台隐藏） |
| `speaking` | `{until}`：她要播放合成语音了（`voice_speak`、试听），到 `until`（毫秒时刻）为止；App 据此捂住耳朵，免得把她自己的声音当成有人说话 |
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
| `timeline` | `{limit?, before?, kind?}` | 时间线（倒序；`kind` 另有 `hear`（听到有人说话，没有回应）、`tool`（造了 / 改了 / 删了一个工具）、`identity`（她改了自己的身份））。`detail` 随 `kind` 而异：`think` / `dream` 为 `{reason, intent, journal, feeling, thought?, process, steps, tokens, model}`（中断时为 `{reason, intent, error, process}`），`chat` 为 `{channel, conv, text, reply, process, steps, tokens, model}`；`process` 是这一轮的执行过程（与 `sessions.messages` 的 `process` 同构：工具卡片与中途叙述），`steps` 是每次工具调用的完整参数与结果（结果最多 1500 字） |
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
| `sessions.messages` | `{id, limit?, before?}` | 某个会话的对话 `[{id, ts, role, channel, text, session, process, attachments, mode}]`；`role` 为 `user`（对方）、`agent`（她）或 `ambient`（环境声音：麦克风听到并识别的话，通道 `语音`，不是对方发的消息；`mode` 为 `ignored` 表示她判断不是对她说的，控制台不显示）；`process` 里的 `{type: "steer", msg, text, mode, ambient}` 是插话 / 打断到达的那一刻（控制台据此把之前的过程截断在插话消息上方，之后的从它下面重新开出）；`process` 为这轮回复的执行过程（工具卡片与中间叙述） |
| `sessions.live` | — | 进行中的轮次快照 `[{turn, conv, origin, text, msg, status, step, live, items}]` |
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
| `stop` / `unstop` | `{reason?}` / — |
| `permissions` / `setPermission` | — / `{id, level: allow｜ask｜deny}` |
| `approvals` / `decide` | — / `{id, approve, note?}` |
| `budget` / `setBudget` | — / `{dailyTokens?, dailyCostUsd?, minBattery?, maxTempC?}` |
| `config` / `setConfig` | — / `{timezone?, brain?, heart?}` |
| `restart` | — （进程退出，由守护者拉起） |

**记忆**

| 方法 | 参数 |
|---|---|
| `memory` | — → `{soul, memory[], user[], loops[]}` |
| `editMemory` | `{target: memory｜user, action: add｜replace｜remove, content?, oldText?}` |
| `setSoul` | `{text}` |
| `journalList` / `journal` | — / `{body, day}` |
| `notes` / `note` / `search` | — → `[{name, title, summary, mtime, size}]`（`name` 为目录树中的相对路径，如 `身体/honor9/硬件`）/ `{name}` / `{query}`（按相关度检索笔记、日记与常驻记忆） |
| `soulConfig` / `setSoulConfig` / `soulKey` / `syncSoul` | 灵魂仓库地址（只接受 SSH 地址，见规范 §7）、本机部署公钥、立即同步 |
| `agent` / `setAgent` | — / `{displayName?, name?, pronouns?, description?, color?, language?}`（写入 agent.json 并同步；她自己改用工具 `edit_identity`，留时间线 `identity`） |
| `bodies` | — → 灵魂仓库中登记的身体 |
| `soulHistory` / `soulShow` / `soulRevert` | `{limit?}` / `{hash}` / `{hash}`：记忆历史、查看差异、撤销（生成反向提交） |

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
  tools?: AdapterTool[];                   // 设备动作，每个声明所属能力类别
  hands?: Hands;                           // 预留：看屏幕与操作其他应用
}
interface RawSample {
  battery?: { level: number; charging: boolean; tempC?: number; health?: string };
  lux?: number; motion?: number; screenOn?: boolean;
  extra?: Record<string, string | number | boolean>;
}
```

约束：

- 适配器只能 `import type` 本文件的类型，不得依赖核心的其他实现；仓库自带的 `runtime/adapters/termux/`（安卓手机 + Termux:API）是参考实现，构建为 `dist/termux.mjs`，由 Windler App 的安装器随运行基座一起放到手机上；
- 适配器从 `WINDLER_ADAPTER` 环境变量或配置项 `adapter` 指定的路径加载；加载失败时核心回退到通用适配器（无传感器）；
- 工具的 `permission` 必须是闸门已知的能力类别之一（见 `guard/guard.ts`），否则按「允许」处理。

Termux 适配器提供：`sample()` 的电量 / 充电 / 体温 / 健康（`termux-battery-status`）、光照与运动（`termux-sensor`，传感器按名字探测，没有就不报）；`notify()`（带「打开 Windler」按钮）、`playAudio()`（`termux-media-player`）；工具 `take_photo`（camera）、`record_audio`（microphone）、`location`（location）、`vibrate` / `torch` / `clipboard` / `read_sensor`（device）。不提供 `speak`（很多手机没有系统 TTS 引擎），说话由运行基座的 `voice_speak` 完成。环境变量：`WINDLER_HOME`（媒体保存位置 `data/media/`）、`WINDLER_CONSOLE_ACTIVITY`（通知按钮打开的界面，默认 `xyz.windler.console/.MainActivity`）。

## 3. 配置项（`config/windler.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `body` | `default` | 身体名称（日记目录名）；安装器写为机型名 |
| `adapter` | `""` | 适配器模块路径（Termux 部署用环境变量 `WINDLER_ADAPTER` 指定） |
| `timezone` | 系统时区（拿不到时 `Asia/Shanghai`） | 生物钟与日记使用的时区 |
| `heart.activity` / `baseRatePerHour` / `paused` | 1 / 4 / false | 活跃度、饱和醒来率、暂停 |
| `budget.*` | 2,000,000 tokens / $5 / 15% / 45°C | 每日预算与身体限制 |
| `permissions.*` | `camera` / `microphone` / `location` / `hands` 为 `ask`，其余 `allow` | 能力授权 |
| `brain.maxOutputTokens` | 4096 | 每次模型调用的输出上限（步数不设上限，由 agent 决定何时结束） |
| `feishu.*` | — | 飞书（Secret 在 `secrets/`） |
| `soul.remote` / `branch` | "" / main | 灵魂仓库（常驻记忆 MEMORY / USER 没有长度上限） |
| `gateway.port` | 7788 | 网关端口 |
| `hearing.enabled` / `windowMin` / `sensitivity` / `language` / `minChars` | false / 10 / 2 / ""（取她的偏好语言）/ 2 | 听觉：开关；最近会话多少分钟内有更新就并入（0 为每句新开）；灵敏度 1 迟钝 / 2 适中 / 3 灵敏（App 的 VAD 模式）；识别语言；短于此字数当没听清 |
| `speech.region` / `endpoint` / `voice` / `style` / `rate` / `pitch` / `volume` / `format` | "" / "" / zh-CN-XiaoxiaoNeural / "" / 0% / 0% / 100 / audio-24khz-48kbitrate-mono-mp3 | Azure 语音（密钥在 `secrets/azure_speech_key`）；控制台「语音」页或她自己用 `voice_config` 修改 |
