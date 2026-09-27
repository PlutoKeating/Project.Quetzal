# 灵魂仓库规范（Soul Repository Specification）v1

本规范定义用于灵魂同步的 git 仓库：它的目录树、固定内容、文件格式、提交约定与认证方式。凡是读写灵魂仓库的实现（运行基座 `runtime/src/memory/soul-repo.ts`、灵魂桥 `bridge/`，以及将来的其他实现）都**必须**遵守。文中「必须 / 不得 / 应当 / 可以」对应 MUST / MUST NOT / SHOULD / MAY。

实现会强制执行其中可以机器检查的部分：远端地址与私钥检查、固定内容补齐、提交前检查。

## 1. 仓库

- **一个 agent 对应一个仓库**，仓库**必须**是私有的。
- 命名**应当**为 `<agent 短名>.soul`，例如 `kaoru.soul`。
- 默认分支为 `main`，只使用这一个分支。
- 历史只追加：**不得**强制推送（force push），**不得**改写历史。撤销一律用反向提交。

## 2. 目录树（固定）

```
<agent>.soul/
├── .soul-spec.json            固定  规范版本
├── .gitattributes             固定  换行与文本属性
├── .gitignore                 固定  忽略临时文件
├── README.md                  固定  说明这是什么仓库（自动生成，不写任何个人内容）
├── agent.json                 必需  身份
├── SOUL.md                    必需  人格
├── memories/                  必需
│   ├── MEMORY.md              必需  agent 自己的常驻笔记
│   └── USER.md                必需  关于用户的认识
├── journal/                   必需  情节记忆（含 .gitkeep）
│   └── <body>/
│       └── <YYYY-MM-DD>[-<slug>].md
├── notes/                     必需  共享的长期笔记（含 .gitkeep）
│   └── <主题>.md
├── bodies/                    必需  身体登记（含 .gitkeep）
│   └── <body>.json
└── locks/                     可选  协调锁（按需创建）
    └── consolidation.json
```

- 顶层**只允许**出现上面列出的条目。实现发现其他顶层条目时应当报告，不应当删除。
- 标「固定」与「必需」的条目缺失时，实现**必须**在接入时自动补齐（见 §4）。
- 所有文本文件使用 UTF-8 编码、LF 换行。单个文件**不得**超过 1 MiB。**不得**提交二进制文件。

## 3. 文件格式

### 3.1 `.soul-spec.json`（固定内容）

```json
{ "spec": "soul-repo", "version": 1 }
```

### 3.2 `.gitattributes`（固定内容）

```
* text=auto eol=lf
*.md text diff=markdown
*.json text
```

### 3.3 `.gitignore`（固定内容）

```
*.tmp
*.swp
.DS_Store
*.incoming*.md
```

### 3.4 `README.md`（固定内容）

说明这是一个灵魂仓库、指向本规范，并提醒保持私有、不要手动修改。内容由实现按模板生成（模板见 `soul-repo.ts` 的 `README_TEMPLATE`）。不写入任何个人信息。

### 3.5 `agent.json`（身份）

```json
{
  "id": "0b6d2c1e-6c1f-4a53-9a57-2f1f0f3c9d10",
  "name": "kaoru",
  "displayName": "显示名",
  "pronouns": "",
  "description": "",
  "color": "#7C6CF2",
  "language": "zh-CN",
  "createdAt": "2026-09-28T02:00:00.000Z"
}
```

| 字段 | 规则 |
|---|---|
| `id` | UUID v4，诞生时生成，**永不改变**；实现用它拒绝合并属于另一个 agent 的仓库 |
| `name` | `^[a-z0-9][a-z0-9-]{0,39}$` |
| `displayName` | 非空，界面与称呼使用 |
| `color` | `#RRGGBB` |
| `language` | BCP 47 语言标签 |
| `seed` | 可选。`true` 表示自动生成、尚未被修改过的种子身份。种子身份遇到远端身份时让位 |

合并规则：字段级合并，本地优先，`id` 除外。

### 3.6 `SOUL.md`（人格）

自由 Markdown，作为系统提示的第一段。第一行应当是 `# <显示名>`。

合并规则：采用提交时间较新的一方；本地为空或仍是种子人格时采用对方。落选版本保留在历史中。

### 3.7 `memories/MEMORY.md`、`memories/USER.md`（常驻记忆）

- 由若干条目组成，条目之间用 `\n§\n` 分隔，文件以 `\n` 结尾，空文件表示没有条目。
- 条目是去掉首尾空白后的非空文本，可以多行，但**不得**包含单独成行的 `§`。
- 字符上限（整个文件）：`MEMORY.md` 默认 2200，`USER.md` 默认 1375。仓库里**可以**暂时超限；写回有上限的框架时截取，由做梦整理压缩。
- 语义与 Hermes Agent 的 `memory` 工具一致：add / replace / remove。

合并规则：条目级三方合并，双方新增都保留，任一方删除即删除。

### 3.8 `journal/<body>/<YYYY-MM-DD>[-<slug>].md`（日记）

- **每具身体只写自己的目录**，因此天然没有冲突。
- 格式：第一行 `# <YYYY-MM-DD> · <body>`；每段经历为 `## <HH:MM> <标题>` 加正文，只追加。
- 从框架导入的日记（例如 OpenClaw 的 `memory/YYYY-MM-DD*.md`）保持原文件名与内容。

### 3.9 `notes/<主题>.md`（共享笔记）

- 文件名由主题得到：去掉 `\ / : * ? " < > |` 与空白（替换为 `-`），最长 60 个字符。
- 第一行 `# <主题>`，其余为自由 Markdown。
- 合并规则：采用提交时间较新的一方，落选版本保留在历史中。

### 3.10 `bodies/<body>.json`（身体登记）

```json
{ "body": "honor9", "kind": "runtime", "runtime": "0.1.0", "lastSeen": "2026-09-28T02:00:00.000Z" }
{ "body": "hermes-pc", "kind": "bridge", "framework": "hermes", "bridge": "0.2.0", "host": "pc", "lastSeen": "…" }
```

- `body` 与文件名相同，只能用 `[a-z0-9-]`。每具身体只写自己的文件，每次推送时更新 `lastSeen`。
- **不得**写入 IP 地址、MAC 地址、序列号等可以定位设备或个人的标识。

### 3.11 `locks/consolidation.json`（整理租约）

```json
{ "body": "honor9", "until": 1790530000000 }
```

- 表示某具身体正在整理常驻记忆，`until` 为毫秒时间戳，有效期 30 分钟。
- 取得方式：写入租约后推送成功，即为取得（比较并交换）。释放时删除该文件。

## 4. 接入与补齐

实现接入仓库时（克隆或本地初始化之后）**必须**补齐 §2 中缺失的固定与必需条目：
- 固定文件按 §3 的固定内容写入；
- `agent.json` 缺失时生成种子身份；
- `SOUL.md` 缺失时按身份生成种子人格；
- 空目录放入 `.gitkeep`。

补齐产生的变更作为一次提交：`补齐灵魂仓库规范结构（<body>）`。

## 5. 提交约定

- 作者：`<displayName> (<body>)`，邮箱 `<name>@<body>.local`。
- 提交信息：`<说明>（<body>）`。例如 `做梦：……（honor9）`、`同步 Hermes Agent 的变更（hermes-pc）`、`撤销 1a2b3c4（honor9）`。
- 每次推送前拉取合并，推送被拒时重新拉取合并后再推送；**不得**强制推送。

## 6. 禁止内容

以下内容**不得**进入灵魂仓库。实现**必须**在提交前检查，命中时拒绝这次提交，报告原因，并保持本地工作区不变，以便修正：

- 密钥与凭据：私钥块（`-----BEGIN … PRIVATE KEY-----`）、GitHub 令牌（`ghp_`、`github_pat_`、`gho_`……）、`sk-` 开头的 API Key、AWS 访问密钥（`AKIA…`）、飞书 App Secret 等；
- 设备与个人标识：MAC 地址、IP 地址、序列号、IMEI、手机号；
- 二进制文件，以及超过 1 MiB 的文件。

实现侧的配置（API Key、网关令牌、飞书凭据、部署私钥）一律保存在实现自己的密钥目录中，与灵魂仓库完全分离。

## 7. 认证：必须使用私钥（SSH 部署密钥）

- 远端地址**必须**是 SSH 形式：`git@<host>:<owner>/<repo>.git` 或 `ssh://git@<host>/<owner>/<repo>.git`。**不得**使用 HTTPS、个人访问令牌或密码。
- **每具身体一把专属密钥**：ed25519，在本机生成。私钥只存放在本机、权限 `0600`（运行基座为 `AMANI_HOME/secrets/soul_ed25519`，灵魂桥为 `~/.agent-soul/<agent>/id_ed25519`），**不得**提交到任何仓库，**不得**在身体之间复制。
- 公钥以 **Deploy key（勾选 Allow write access）** 的形式添加到该灵魂仓库。**不得**使用个人账号的 SSH 密钥，保证每把密钥只能访问这一个仓库。
- 实现访问远端时**必须**只使用这把私钥：`ssh -i <私钥> -o IdentitiesOnly=yes`。不得回退到 ssh-agent 或默认密钥。私钥不存在时拒绝访问远端，不静默回退。
- **吊销**某具身体：在仓库 Settings → Deploy keys 删除它的公钥。
- 例外：只在自动化测试中，可以通过环境变量 `SOUL_ALLOW_LOCAL_REMOTE=1` 使用本地路径作为远端。
