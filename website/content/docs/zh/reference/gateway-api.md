---
title: 网关 API
description: 本地网关的 HTTP 接口、WebSocket RPC 与推送事件、方法一览。Quetzal App、网页控制台与飞书通道使用的就是这一套。
---

## 概览

网关的明文 HTTP 只监听本机 `127.0.0.1:<gateway.port>`（默认 7788，另有 `[::1]`）。

对局域网开放时（`gateway.lan` 为真，或 `gateway.host` 不是回环地址，如 `0.0.0.0`），网关另在 `<gateway.host>:<gateway.lanPort>`（默认 7789）开 HTTPS / WSS，接口完全相同，局域网上没有明文。证书是运行基座自己生成的自签名证书（ECDSA P-256，10 年，`secrets/gateway-tls.key` / `gateway-tls.crt`）；**指纹**是证书 DER 的 SHA-256，写成小写十六进制，原生控制台钉住它。

所有控制入口（App、网页控制台、飞书、主机工具）共用同一个操作层，行为一致，都写审计。`main.cjs` 旁边有 `web/index.html`（npm 安装器放的网页控制台）时，网关同时托管这些静态文件。

## HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, safeMode, mode}`，无需令牌 |
| GET | `/auth/local` | `{ok, token}`：只在本机明文监听上提供，只给同一台机器上的浏览器（连接来自回环地址、Host 是本机名、有 Origin 时也是本机），让网页控制台打开即登录；其他来源返回 403。本机进程本来就读得到令牌文件，所以信任边界没有扩大；ssh 隧道转发来的连接也算本机 |
| GET | `/`、`/<静态文件>` | 网页控制台（`web/` 存在时）：没有扩展名的未知路径回退到 `index.html`，带 ETag |
| GET | `/pair/info` | `{ok, fingerprint, short, body, version, tls: true}`，无需令牌：证书指纹（完整与「1a2b 3c4d 5e6f 7a8b」短格式）、身体名、版本 |
| POST | `/pair/start` | 生成 8 位配对码（字母数字，5 分钟有效；有效期内重复申请不换码，输错多次会锁定），连同证书短指纹通过适配器通知与飞书下发 |
| POST | `/pair/finish` | `{proof}`（或本机明文连接上的 `{code}`）→ `{ok, token, fingerprint}`；`proof` = hex(PBKDF2-HMAC-SHA256(配对码（大写、去掉空格与连字符）, `"quetzal-pair-v2\|" + 客户端握手时看到的证书指纹`, 100000 次, 32 字节))。HTTPS 上只收 `proof`（带 `code` 回 400），中间人换了证书就对不上；客户端再核对返回的 `fingerprint`。400 缺少证明、403 不正确、410 失效或尝试超过 5 次、429 锁定 |
| POST | `/upload?name=&token=` | 上传一个附件（≤ 50 MiB）→ `{ok, file: {id, name, path, rel, mime, size, kind}}` |
| GET | `/uploads/<rel>?token=` | 下载附件（只能访问 uploads 目录） |

## WebSocket `/rpc?token=<令牌>`

```json
{ "id": 1, "method": "status", "params": {} }
{ "id": 1, "result": { } }
{ "id": 1, "error": { "code": "", "message": "" } }
{ "event": "state", "data": { } }
```

### 推送事件

| 事件 | 数据 |
|---|---|
| `hello` | `{version, safeMode}` |
| `state` | 与 `status` 相同的完整状态（去抖 500ms） |
| `timeline` | 新的时间线条目 `{id, ts, kind, title, detail}` |
| `approval` | 审批 `{id, action, reason, args, status}` |
| `say` | ta 主动说的话 |
| `activity` | 进展 `{session, conv, origin, channel, ts, kind, …}`，`kind` 见下 |
| `secret` | 保密输入状态（永远不含值） |
| `feishu.qr` / `feishu.registered` / `feishu.error` | 飞书一键接入 |

`activity.kind`：`start` / `queued` / `steer` / `step` / `delta`（流式片段）/ `text` / `tool`（执行中与执行后各一条）/ `alive`（15 秒心跳）/ `done` / `error`。进行中的每一轮同时保存为快照（`sessions.live`），客户端随时可以用它完整重建界面。

### 方法

**观察**

| 方法 | 参数 | 返回 |
|---|---|---|
| `status` | — | `{agent, version, body, adapter, heart, physical, stopped, paused, activity, usage, budget, approvals, soul, models, thought}` |
| `timeline` | `{limit?, before?, kind?}` | 时间线（倒序），`detail` 含过程与每步工具调用 |
| `messages` | `{limit?}` | 最近对话 |
| `audit` | `{limit?}` | 审计记录 |

**交流**

| 方法 | 参数 | 说明 |
|---|---|---|
| `chat.send` | `{text, conv?, turn?, attachments?, mode?}` | `mode`：`steer`（默认，插话）/ `queue` / `interrupt` |
| `sessions` / `sessions.create` / `sessions.rename` / `sessions.archive` | … | 会话管理 |
| `sessions.messages` | `{id, limit?, before?}` | 某会话的对话（含过程记录） |
| `sessions.live` | — | 进行中轮次的快照 |
| `poke` | `{note?}` | 戳一下 |

**保密库**：`secrets`、`secrets.delete`、`secrets.pending`、`secrets.end`。

**语音**：`speech` / `setSpeech`、`speechVoices`、`speechTest`。

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
| `restart` | — |
| `selfUpdate` | — | 让这具身体在后台重跑一键安装脚本，升到最新发布并重启一次：`{started, message}`（Linux 与 Windows 适配器实现；安卓由 App 自己升级） |
| `supervision` / `setSupervision` | — / `{enabled}` | 守护开关，一个开关同时管开机自启和退出后自动重启：`{available, enabled, kind: systemd｜runit｜loop｜task｜none, detail}`。由身体适配器实现：Linux 是 systemd 用户服务（关 = disable + 覆盖片段 `Restart=no`）或一键安装脚本的守护循环（关 = 标志文件 `state/supervise.off` + 删开机项）；Windows 是安装器注册的计划任务（`kind: task`，关 = 标志文件 `state\supervise.off`）；安卓（App 内置）是 App 前台服务的「开机与升级后自启、退出后重启」开关（`kind: loop`）；旧的 Termux 安装是 runit `down` 文件 + Termux:Boot 开机脚本。`available` 为假（手动部署）时控制台不显示开关。关闭只影响之后的拉起，正在运行的进程照常运行 |

**记忆**

| 方法 | 说明 |
|---|---|
| `memory` / `editMemory` / `setSoul` | 常驻记忆与人格 |
| `journalList` / `journal` | 日记 |
| `notes` / `note` / `search` | 笔记与检索 |
| `soulConfig` / `setSoulConfig` / `soulKey` / `syncSoul` | 灵魂仓库地址（只接受 SSH）与访问方式 `sshMode`（`deploy` / `custom` + `sshKeyPath` / `system`）、本机公钥、立即同步 |
| `agent` / `setAgent` | 身份 |
| `bodies` | 登记的身体 |
| `soulHistory` / `soulShow` / `soulRevert` | 记忆历史、差异、撤销 |

**模型**

| 方法 | 说明 |
|---|---|
| `providers` / `saveProviders` | 读取 / 整份保存（带版本号，不符返回 `STALE_CONFIG`） |
| `catalog` / `refreshCatalog` / `remoteModels` | 模型目录 |
| `testModel` | `{ok, latencyMs, message}` |
| `moveModel` / `toggleModel` | 全局顺序与启停 |

供应商配置结构：

```ts
interface Provider {
  id: string; catalogId: string; name: string; baseUrl: string; enabled: boolean;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  keys: { id: string; label: string; lastFour: string; enabled: boolean; secret?: string }[];
  models: { id: string; name: string; enabled: boolean; context: number; maxTokens: number; sortOrder: number; cost?: { input: number; output: number } }[];
}
interface ProviderConfig { providers: Provider[]; quickModelId?: string }
```

**飞书**：`feishu.status`、`feishu.register`、`feishu.set`。

> [!NOTE]
> 本页是概览。字段级的完整描述见仓库里的 [docs/API.md](https://github.com/PlutoKeating/Project.Quetzal/blob/main/docs/API.md)，两者不一致时以代码为准。
