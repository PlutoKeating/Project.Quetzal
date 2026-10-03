---
title: 网关 API
description: 本地网关的 HTTP 接口、WebSocket RPC 与推送事件、方法一览。Windler App 与飞书通道使用的就是这一套。
---

## 概览

网关只监听 `127.0.0.1:<gateway.port>`（默认 7788）。所有控制入口（App、飞书、主机工具）共用同一个操作层，行为一致、都写审计。

## HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, safeMode, mode}`，无需令牌 |
| POST | `/pair/start` | 生成 6 位配对码（5 分钟有效），通过适配器通知与飞书下发 |
| POST | `/pair/finish` | `{code}` → `{ok, token}`；403 不正确、410 失效或尝试超过 5 次 |
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

`activity.kind`：`start` / `queued` / `steer` / `step` / `delta`（流式片段）/ `text` / `tool`（执行中与执行后各一条）/ `alive`（15 秒心跳）/ `done` / `error`。进行中的每一轮同时保存为快照（`sessions.live`），客户端随时可以完整重建界面。

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

**记忆**

| 方法 | 说明 |
|---|---|
| `memory` / `editMemory` / `setSoul` | 常驻记忆与人格 |
| `journalList` / `journal` | 日记 |
| `notes` / `note` / `search` | 笔记与检索 |
| `soulConfig` / `setSoulConfig` / `soulKey` / `syncSoul` | 灵魂仓库地址（只接受 SSH）、本机公钥、立即同步 |
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
> 这里是概览。字段级的完整描述见仓库里的 [docs/API.md](https://github.com/PlutoKeating/Project.Windler/blob/main/docs/API.md)，以代码为准。
