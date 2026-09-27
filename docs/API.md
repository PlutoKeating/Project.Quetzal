# 接口

Amani 对外有两类接口：**网关 API**（控制台、主机工具使用）和**身体适配器接口**（设备仓库实现）。

## 1. 网关

只监听 `127.0.0.1:<gateway.port>`（默认 7788）。

### 1.1 HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, safeMode, mode}`，无需令牌，供点火器探活 |
| POST | `/pair/start` | 生成 6 位配对码（5 分钟有效），通过适配器的系统通知与飞书下发 |
| POST | `/pair/finish` | `{code}` → `{ok, token}`；错误码 403（不正确）、410（失效或尝试超过 5 次） |

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
| `say` | Amani 主动说的话（字符串） |
| `feishu.qr` / `feishu.registered` / `feishu.error` | 飞书一键接入流程 |

### 1.3 方法

操作者（actor）统一记为「控制台」，所有修改类操作写入审计。

**观察**

| 方法 | 参数 | 返回 |
|---|---|---|
| `status` | — | `{agent, version, body, adapter, heart, physical, stopped, paused, activity, usage, budget, approvals, soul, models}` |
| `timeline` | `{limit?, before?, kind?}` | 时间线（倒序） |
| `messages` | `{limit?}` | 对话记录（正序） |
| `audit` | `{limit?}` | 审计记录 |

`heart` 字段：`mode`（awake / asleep / active）、`S`、`C`、`sleepiness`、`alertness`、`drives{curiosity, expression, social, openLoops}`、`unconsolidated`、`ratePerHour`、`inhibitors[]`、`lastReason`、`nextCandidateAt`、`personality`。

**交流**

| 方法 | 参数 | 说明 |
|---|---|---|
| `chat.send` | `{text}` | 与她对话，返回她的回复 |
| `poke` | `{note?}` | 戳一下：推高想念与好奇并立即重新抽样，不强制醒来 |

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
| `memory` | — → `{soul, memory[], user[], limits, loops[]}` |
| `editMemory` | `{target: memory｜user, action: add｜replace｜remove, content?, oldText?}` |
| `setSoul` | `{text}` |
| `journalList` / `journal` | — / `{body, day}` |
| `notes` / `note` / `search` | — / `{name}` / `{query}` |
| `soulConfig` / `setSoulConfig` / `soulKey` / `syncSoul` | 灵魂仓库地址、本机部署公钥、立即同步 |
| `agent` / `setAgent` | — / `{displayName?, name?, pronouns?, description?, color?, language?}`（写入 agent.json 并同步） |
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

- 适配器只能 `import type` 本文件的类型，不得依赖核心的其他实现；
- 适配器从 `AMANI_ADAPTER` 环境变量或配置项 `adapter` 指定的路径加载；加载失败时核心回退到通用适配器（无传感器）；
- 工具的 `permission` 必须是闸门已知的能力类别之一（见 `guard/guard.ts`），否则按「允许」处理。

## 3. 配置项（`config/amani.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `body` | `default` | 身体名称（日记目录名） |
| `adapter` | `""` | 适配器模块路径 |
| `timezone` | `Asia/Shanghai` | 生物钟与日记使用的时区 |
| `heart.activity` / `baseRatePerHour` / `paused` | 1 / 4 / false | 活跃度、饱和醒来率、暂停 |
| `budget.*` | 2,000,000 tokens / $5 / 15% / 45°C | 每日预算与身体限制 |
| `permissions.*` | 全部 `allow` | 能力授权 |
| `brain.maxSteps` / `maxOutputTokens` | 12 / 4096 | 每次醒来的工具步数与输出上限 |
| `feishu.*` | — | 飞书（Secret 在 `secrets/`） |
| `soul.remote` / `branch` / `memoryCharLimit` / `userCharLimit` | "" / main / 2200 / 1375 | 灵魂仓库 |
| `gateway.port` | 7788 | 网关端口 |
