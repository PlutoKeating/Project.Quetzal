---
title: 灵魂仓库规范
description: 灵魂仓库（v4）的目录树、文件格式、合并规则、提交约定与认证方式的摘要。
---

## 定位

本页是 [灵魂仓库规范 v8](https://github.com/PlutoKeating/Project.Quetzal/blob/main/docs/SOUL_REPO_SPEC.md) 的摘要。凡是读写灵魂仓库的实现（运行基座、灵魂桥及将来的其他实现）都必须遵守。它是 agent 自己的**私有**仓库，对内容不设任何检查。

## 仓库

- 一个 agent 对应一个仓库，**必须私有**；命名应当为 `<agent 短名>.soul`。
- 只用 `main` 一个分支。历史只追加：**不得** force push，撤销一律用反向提交。

## 目录树

```
<agent>.soul/
├── .soul-spec.json            固定  规范版本
├── .gitattributes             固定  换行与文本属性
├── .gitignore                 固定  忽略临时文件
├── README.md                  固定  自动生成，不写任何个人内容
├── agent.json                 必需  身份
├── SOUL.md                    必需  人格
├── memories/MEMORY.md         必需  agent 自己的常驻笔记
├── memories/USER.md           必需  关于用户
├── journal/<body>/<YYYY-MM-DD>[-<slug>].md   必需  日记
├── notes/[<分类>/…/]<主题>.md   必需  共享笔记，最多 4 层
├── bodies/<body>.json         必需  身体登记
└── locks/consolidation.json   可选  整理租约
```

顶层**可以**出现规范外的条目（ta 自己放的东西），实现不得删除。固定与必需条目缺失时，实现在接入时**自动补齐**，作为一次提交。UTF-8、LF，单文件不超过 1 MiB，不提交二进制。

## 文件格式

| 文件 | 格式要点 |
|---|---|
| `agent.json` | `id`（UUID v4，永不改变）、`name`（`^[a-z0-9][a-z0-9-]{0,39}$`）、`displayName`、`pronouns`、`description`、`color`（`#RRGGBB`）、`language`（BCP 47）、`createdAt`、可选 `seed` |
| `SOUL.md` | 自由 Markdown，第一行应当是 `# <显示名>` |
| `memories/*.md` | 条目以 `\n§\n` 分隔，文件以 `\n` 结尾；**没有字符上限**；写回有上限的框架时截取，截取不写回 |
| `journal/<body>/…` | 第一行 `# <日期> · <body>`，每段 `## <HH:MM> <标题>`，只追加；每具身体只写自己的目录 |
| `notes/…` | 第一行 `# <主题>`，可选一行 `> ` 摘要；路径段去掉非法字符、最长 60 字符、最多 4 层；不提交索引文件 |
| `bodies/<body>.json` | `{body, kind: runtime｜bridge, runtime/framework/bridge 版本, host?, meshKey?, lastSeen}`；`meshKey` 是网状层的节点公钥（v8，其他身体以它为准核对对方）；`lastSeen` 在内容变化或超过 1 小时时更新；**不得**写入 IP、MAC、序列号 |
| `locks/consolidation.json` | `{body, until}`，30 分钟有效；推送成功即取得 |

## 合并规则

| 文件 | 规则 |
|---|---|
| `memories/*.md` | 条目级三方合并：双方新增都保留，任一方删除即删除 |
| `agent.json` | 字段级合并，本地优先，`id` 除外；种子身份让位于远端 |
| `SOUL.md`、笔记、技能文档 | 采用提交时间较新的一方；本地为空或种子时采用对方；落选版本保留在历史；两边都改过时可另存为 `<名>.incoming.md` 冲突副本（被 `.gitignore` 忽略，不同步）交给 agent 裁决，读取笔记与映射到其他框架时必须跳过副本（v8） |
| 日记、身体登记 | 各写各的，无冲突 |

## 提交约定

作者 `<displayName> (<body>)`，邮箱 `<name>@<body>.local`；提交信息 `<说明>（<body>）`，粒度由实现决定，可以细到每次改动一个（v8）。推送前拉取合并，被拒重试，不得强制推送。

## 内容：不做检查（v4）

实现**不得**对内容做脱敏、隐私或敏感信息检查，不得因内容拒绝提交。保护靠访问控制，不靠审查内容。实现侧的配置（Key、令牌、飞书凭据、部署私钥）保存在实现自己的密钥目录，与灵魂仓库分离。

## 认证：必须用 SSH；默认部署密钥，可改用自己的钥匙（v7）

- 远端地址**必须**是 SSH 形式（`git@host:owner/repo.git` 或 `ssh://git@host/owner/repo.git`，`~/.ssh/config` 的 Host 别名也可以），不得用 HTTPS、个人令牌或密码。
- **默认：每具身体一把专属 ed25519 密钥**，在本机生成，私钥 `0600`，不得提交、不得在身体之间复制；公钥以 **Deploy key（Allow write access）** 加到该仓库；访问远端时 `ssh -i <私钥> -o IdentitiesOnly=yes`，不回退到 ssh-agent；私钥不存在时拒绝访问并提示。吊销某具身体：删除它的 Deploy key。
- **部署者可显式改用自己的钥匙**：指定私钥（仍只用它），或系统 ssh 配置（不传 `-i`，交给 `~/.ssh/config` 与 ssh-agent）。控制台「灵魂同步」页可选。

## 版本历史

v8 新增冲突副本、身体登记的 `meshKey`、`lastSeen` 不必每次推送都更新；v7 认证新增部署者可选的指定私钥与系统 ssh 配置；v4 取消全部内容检查、允许顶层额外条目；v3 明确 IP 定义；v2 取消常驻记忆上限、笔记改为目录树；v1 初版。旧仓库无需迁移。
