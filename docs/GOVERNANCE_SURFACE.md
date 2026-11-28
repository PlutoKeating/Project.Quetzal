# 治理面：版面、交互与接口

治理面是 Quetzalcoatl 唯一的自有界面。它只做两件事：**看**和**签**。没有输入框，没有「和他聊聊」——想聊，去宿主。

本文是各端治理面（Web、Linux、macOS、Windows）共同的规范：先讲用户来这里要什么，再讲版面与交互，最后是它与守护进程之间的接口。视觉语言一律取自 `packages/design-system`，不在各端重述数值。

## 1. 用户来这里要什么

治理面是低频而郑重的地方。用户带着下面八个问题之一来：

| 问题 | 页 | 能做的事 |
| --- | --- | --- |
| 他现在是谁？最近变了什么？ | 他 | 看核心价值与性情；看每一次变化是从哪些相处里长出来的 |
| 他眼里的我是什么样？ | 我 | 看他记下的关于我的偏好与事实；改、不主动提、抹除 |
| 我们走到哪了？ | 我们 | 看共同的承诺；看他迎合的对象在「他自己」与「我们」之间的位置，并调节 |
| 他记得那件事吗？记对了吗？ | 往事 | 搜、按时间和来源看；改、不主动提、抹除 |
| 哪几件事无论如何不许变？ | 底线 | 写下并签署 |
| 他在哪些工具里？每一步通吗？ | 宿主 | 看每个宿主的四项：送核心、送往事、收信号、压缩后不丢 |
| 哪些设备上有他？丢了怎么办？ | 设备 | 看设备与同步状态；吊销 |
| 这条是谁、什么时候写的？ | 记录 | 按时间看每一次写入 |

进来的第一眼（总览）只回答三件事：**他在（名字、相处了多久）· 他在哪些宿主里 · 有没有事在等我**。

## 2. 版面

**禁止纯粹的控件与内容堆叠。** 每一页先回答「此刻想知道什么、下一步想做什么」，再决定结构。

### 2.1 骨架

三栏，各有固定职责，从不互换：

| 栏 | 内容 | 说明 |
| --- | --- | --- |
| 左：导航 | 八页的入口；每个入口旁可以有一个信号点 | 不透明的纯黑，光照不到；当前页有一条 1.5px 的白线 |
| 中：正文 | 当前页 | 光学地平线只落在这里 |
| 右：出处 | 当前选中条目的来历 | 没有选中时是这一页的一句话说明，不留空白 |

窄屏（≤ 900px）：导航收成顶部一行可横向滚动的入口；出处栏变成正文下方的一段，跟随选中条目出现。

### 2.2 每一页的结构

- **总览**：居中的名字（展示字号）与「相处第 N 天」；其下一条发丝线栅格，三格——宿主、等你的事、同步。等你的事为零时这一格说「没有事在等你」，不隐藏。
- **他**：上半是核心价值的发丝线栅格（每格一条，编号、陈述、自何时起）；下半是「最近的变化」时间线，每一条变化可以展开证据链（哪几次相处、跨多少天）。性情列在核心之后，字号小一级。最后是「他独处时」：左栏是他做过的（上次回想、上次出去读与读到的几条，选中一条出处栏写明出处与「只作参考」），右栏是他接下来想做的（好奇的事、下次想先提的一件事）；节律写成两句话、选择嵌在句子里——「他见面时［可以先提一件事｜等我先说］」「他不打扰你的时候［随时｜夜里｜上班时］」，不另起一排开关。
- **我**：两栏对照——左是偏好（他据此调整做法），右是事实（他据此理解我）。选中一条，出处栏显示它从哪次相处来、有没有被纠正过。
- **我们**：上半是共同的承诺；下半是一根横向的刻度——左端「他自己」，右端「我们」，一个可拖动的刻度标记当前位置，下限处有一条不可越过的线。这是全站唯一的滑杆。
- **往事**：主从结构。左列是结果（上方一个搜索框与一个分段控件：全部、不主动提、已过期）；右侧是选中条目的全文、来历、生效时间与三个动作。不做无限长的单列卡片。
- **底线**：一份可编辑的短句清单与一个签署动作。未签署时整页的状态词是琥珀色的「待签署」；签署后是冰蓝色的「自某日起生效」。部署约束列在下方，只读。
- **宿主**：每个宿主一行发丝线栅格，四格对应四项；通的是冰蓝圆点加一句话，不通的是琥珀圆点加下一步怎么做。
- **设备**：这台设备在最上；其余设备按最近在线排序；吊销是一个需要再次确认的动作。
- **记录**：时间线，按天分组，每条一行等宽的时间、动作与对象；选中后出处栏显示完整内容。

### 2.3 动作

- 每一屏至多一个白色主按钮。「签署」是底线页的主按钮；其余页的动作都是描边按钮或文字链接。
- 条目上的三个动作固定为：**改**、**不主动提**、**抹除**。「抹除」必须二次确认，并说明它会从所有设备上消失且不可恢复。
- 写操作成功后，被改的那一条就地更新，并在出处栏追加一行「刚刚由你修改」。不弹出提示条，不跳转。
- 没有任何地方可以输入一句话发给他。

### 2.4 状态与颜色

颜色只表示语义，且从不单独承担含义（总有文字）：

| 颜色 | 含义 | 出现的位置 |
| --- | --- | --- |
| 冰蓝 | 已生效、已验证、通 | 已签署的底线、通的检查项、已同步 |
| 琥珀 | 需要你、是你说的、不通 | 待签署、等你的事、不通的检查项、由你亲手改过的条目 |

守护进程联系不上时，整页保留上一次的内容并在导航上方显示一行琥珀色状态词与下一步（在终端启动它），所有写动作不可用。

## 3. 接口

治理面经本机认证通道调用守护进程。方法名与载荷如下；各端的传输与握手沿用现有的本机通道，不另开端口。

请求体形如 `{"method": "<方法名>", "params": {…}}`，响应体形如 `{"kind": "<方法名>", "data": {…}}`，失败时是 `{"kind": "error", "data": {"code": "…", "detail": "…"}}`。时间一律是毫秒时间戳。

### 3.1 读

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `sea_overview` | 无 | `SeaOverview` |
| `sea_self` | 无 | `SeaSelf` |
| `sea_user` | 无 | `SeaUser` |
| `sea_us` | 无 | `SeaUs` |
| `sea_memories` | `{query?, state?, cursor?, limit?}` | `{items: MemoryItem[], next_cursor: string \| null, total: number}` |
| `sea_memory` | `{id}` | `MemoryDetail` |
| `sea_baseline` | 无 | `Baseline` |
| `sea_hosts` | 无 | `{hosts: HostView[]}` |
| `sea_devices` | 无 | `DevicesView` |
| `sea_audit` | `{cursor?, limit?}` | `{items: AuditItem[], next_cursor: string \| null}` |

`state` 取 `active`（默认）、`muted`、`expired`、`all`。「我」页两栏的每一条都是往事，所以 `sea_memory` 与三个写方法对它们同样适用。`limit` 默认 50，上限 200。

### 3.2 写

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `sea_entry_update` | `{id, text}` | `{id, audit_seq}` |
| `sea_entry_mute` | `{id, muted}` | `{id, audit_seq}` |
| `sea_entry_erase` | `{id}` | `{id, audit_seq}` |
| `sea_baseline_sign` | `{directives: [{title, text}], passphrase}` | `{signed_at_ms}` |
| `sea_focus_set` | `{self_weight}` | `SeaUs` |
| `sea_rhythm_set` | `{speak_first, quiet_hours: [开始, 结束] \| null}` | `SeaSelf`（节律只是你给他的安排，不改写他，不经签署） |
| `sea_device_revoke` | `{device_id, passphrase}` | `DevicesView` |

写方法都由本人在治理面上亲手触发，按本人的显式信号处理。`sea_baseline_sign` 与 `sea_device_revoke` 需要口令；第一次签署时这个口令即被设定（至少 8 个字符）。口令一旦设定，根私钥就用它封存，磁盘上只留根公钥：守护进程启动时按根公钥核对签过名的成员变更日志恢复设备环，不再需要根私钥；签底线、吊销设备、批准新设备（`qz pair approve`）、导出恢复包与第一次在 Hub 注册时才用口令解开它。口令不对时错误码是 `PASSPHRASE_MISMATCH`，还没设过口令就吊销设备时是 `PASSPHRASE_NOT_SET`。无参方法的请求体可以不带 `params`。

### 3.3 载荷

```text
SeaOverview {
  agent:    { name, since_ms }
  baseline: { signed, directive_count, signed_at_ms | null }
  counts:   { core_values, about_user, memories, muted }
  pending:  { disclosures, approvals }
  hosts:    [{ host, name, connected, last_seen_ms | null }]
  sync:     { state: "local-only" | "synced" | "behind", hub_url | null, devices, last_synced_ms | null }
}

SeaSelf {
  identity:     [{ id, label, text, layer, since_ms }]
  core_values:  [{ id, statement, rationale | null, since_ms, evidence_count }]
  temperament:  [{ id, statement, since_ms }]
  changes:      [{ id, target_id, summary, at_ms, acknowledged, evidence: [{ episode_id, host, at_ms }] }]
}

SeaUser {
  preferences: [{ id, statement, since_ms, by_owner, muted }]   // USER_PREF 层的往事
  facts:       MemoryItem[]
}

SeaUs {
  relations: [{ id, peer, commitments: string[], their_model: string[], trust }]
  focus:     { self_weight, us_weight, floor_self, floor_locked }
}

MemoryItem {
  id, text, layer, topic | null,
  since_ms, valid_until_ms | null,
  muted, untrusted, by_owner,
  source: { kind: "host" | "import" | "sayit" | "explore" | "owner", label }
}

MemoryDetail = MemoryItem + {
  supersedes | null,
  history: [{ at_ms, action: "created" | "corrected" | "muted" | "unmuted" | "expired", by }]
}

Baseline {
  signed, signed_at_ms | null,
  directives: [{ id, title, text }],        // 用户自己的底线
  deployment: [{ id, title, text }]         // 部署约束，只读
}

HostView {
  host, name, installed, version | null, connected,
  checks: [{ key: "core" | "recall" | "signal" | "compaction", ok, detail }]
}

DevicesView {
  this_device: { id, name, added_ms },
  devices:     [{ id, name, added_ms, last_seen_ms | null, holds_control }],
  hub:         { url | null, connected }
}

AuditItem { seq, at_ms, kind, summary, actor: "owner" | "arbiter" | "import" | "system", entry_id | null }
```

`by_owner` 为真表示这一条由本人亲手写过或改过，界面上用琥珀色标记「你说的」。

## 4. 各端落地

- **Web**（`surfaces/web`）：直接引用 `packages/design-system` 的 tokens、组件与光学脚本。由守护进程同源托管，`qz open` 打开。
- **Linux**（`surfaces/linux`）：GTK4 + libadwaita，按同一套 token 数值落到 GTK 的样式层；字体随包携带。
- **macOS、Windows**：按同一套 token 数值落到各自的原生样式层。

四端的页、结构、动作与状态完全同构；差别只在各平台的原生控件。
