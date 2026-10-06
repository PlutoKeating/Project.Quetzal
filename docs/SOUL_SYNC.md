# 灵魂同步：同一个 agent 的多地人格与记忆

> 仓库的目录树、固定内容、文件格式与认证方式由 [灵魂仓库规范](SOUL_REPO_SPEC.md) 规定（内容不做任何检查）；本文说明同步如何运作。

同一个 agent 可以同时住在多具「身体」里：一台手机上的运行基座、一台装着 Hermes Agent 的电脑、一台装着 OpenClaw 的服务器……它们共享一个 **git 私有仓库**（推荐 GitHub Private），称为「灵魂仓库」。

**同步与版本管理完全由基座自动完成**，agent 不需要也不能操作它；agent 感知到同步发生了什么（作为一种知觉），只有推送失败或真正的冲突（两边都改了同一个文件）才会被提醒去处理。

## 1. 数据模型

```
<agent>.soul/                       私有 git 仓库，一个 agent 一个
├── agent.json                      身份：id（UUID，全局唯一）、name、displayName、pronouns、description、color、language、createdAt
├── SOUL.md                         人格
├── memories/
│   ├── MEMORY.md                   她自己的常驻笔记（条目以「\n§\n」分隔；运行基座不限长度，写回 Hermes 时按其上限截取）
│   └── USER.md                     关于用户的认识（同上）
├── journal/<身体>/<日期>.md        情节记忆：每具身体只写自己的目录
├── notes/<分类>/…/<主题>.md         语义记忆：共享的长期笔记（目录树，最多 4 层）
├── bodies/<身体>.json              身体登记：类型（runtime / bridge）、框架、版本、最近同步时间
└── locks/consolidation.json        整理记忆的租约（做梦时）
```

- 格式与 Hermes Agent 的 `~/.hermes` 兼容；其他框架通过桥接模块转换。
- **git 历史就是自传**：每次提交的作者是「显示名 (身体)」，提交信息说明发生了什么（醒来、做梦、对话、合并、撤销……）。

## 2. 身体与接入方式

```mermaid
flowchart LR
  R[("灵魂仓库<br/>GitHub Private")]
  subgraph Phone["手机：运行基座"]
    RT["runtime/src/memory/soul-sync.ts"]
  end
  subgraph PC["电脑：Hermes Agent"]
    BH["soul-bridge（hermes 映射）"] <--> HF["~/.hermes/SOUL.md<br/>memories/*.md"]
  end
  subgraph Server["服务器：OpenClaw"]
    BO["soul-bridge（openclaw 映射）"] <--> OF["workspace/SOUL.md · MEMORY.md · USER.md<br/>memory/*.md · memory/notes/"]
  end
  RT <-- "git（SSH 部署密钥）" --> R
  BH <-- git --> R
  BO <-- git --> R
```

| 身体 | 同步者 | 触发 |
|---|---|---|
| 运行基座 | 内置（`SoulRepo`） | **触碰即同步**：她的每次工具调用（包括 `shell`、自造工具、子 agent 的工具）之后看一眼灵魂目录，有变化就立即提交，3 秒去抖后推送；一轮（醒来、做梦、对话）结束与身份修改时立即推送。醒来与对话前拉取 |
| Hermes Agent | soul-bridge | memory 工具调用后与会话收尾（Hermes 钩子）、文件变化（watch）、定期拉取远端 |
| OpenClaw | soul-bridge | 启动、/new、/reset、压缩后（OpenClaw 钩子）、文件变化（watch）、定期拉取远端 |

「定期拉取远端」只是传输层手段（没有公网地址的机器收不到推送通知），与 agent 的醒来无关；运行基座一侧没有任何定时同步。

## 3. 同步协议（`runtime/src/memory/soul-repo.ts`，运行基座与桥接共用）

```mermaid
sequenceDiagram
  participant B as 某具身体
  participant R as 灵魂仓库
  B->>B: 提交本地变更（拉取前保存）
  B->>R: fetch
  B->>B: 身份守卫：远端 agent.json.id ≠ 本地 → 拒绝（本地仍是种子身份时采用远端身份）；远端没有 agent.json 却有规范以外的顶层内容（例如一个代码仓库）→ 不是灵魂仓库，拒绝
  B->>B: merge，冲突全自动解决
  B->>B: 写 bodies/<身体>.json
  B->>R: push（先把 origin 校正为配置里的地址；被拒 → 再拉取合并后重推）
```

**触碰即同步与推送失败**（运行基座，`runtime/src/memory/soul-sync.ts`）

```mermaid
sequenceDiagram
  participant A as 她（某一轮）
  participant T as 工具
  participant S as 基座（soul-sync）
  participant R as 灵魂仓库
  A->>T: 调用工具（memory、note_save、shell……）
  T-->>S: 工具结束
  S->>S: git status：灵魂目录变了？→ 立即提交「note_save：笔记 身体/硬件（honor9）」
  S->>S: 3 秒去抖（一轮结束时立即）
  S->>R: push（被拒 → 拉取合并后重推）
  alt 网络类失败
    S->>S: 静默退避重试 5 次（约 4 分钟）
  end
  alt 仍失败 / 其他原因（密钥被拒、主机密钥不符、仓库不存在、身份不符）
    S-->>A: 插话「基座提醒（灵魂同步）」：失败原因、哪些改动还在本机、建议
  end
```

- 每次提交的说明来自改动的路径（常驻记忆、关于对方的记忆、人格、身份、笔记 <路径>、技能 <名>、日记），所以 git 历史仍然读得懂。
- 提醒送给**碰过这些文件的那一轮**：还在进行就作为插话并入（醒来与子 agent 直接放进收件箱；对话经插话机制，控制台与飞书里看得到）；已经结束就在原会话里以环境输入开新的一轮；醒来或子 agent 的那一轮已结束时，放进「主动消息」会话。提醒的口吻是「基座提醒」，不是对方说的话；她可以回复「沉默」。
- 提醒过的改动不会重复提醒；它们仍在本地提交里，下一次推送自动带上。
- 控制台触发的操作（改身份、撤销、立即同步）推送失败时不插话，失败原因显示在「高级 · 同步」页。
- **只推到配置的地址**：推送与拉取直接使用配置里的灵魂仓库地址（`git push <地址> HEAD:refs/heads/<分支>`、`git fetch <地址> …`），不经 `origin`；`origin` 仍按配置校正（有人改了就改回并记日志），但它被改了也不影响推到哪里。系统提示也告诉 agent 不要自己在灵魂目录里运行 git。
- **不执行灵魂目录里的东西**（规范 §5.2）：每次执行 git 都带 `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.symlinks=false -c protocol.ext.allow=never -c protocol.file.allow=never`，环境 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`；每次提交、拉取、推送前删掉 `.git/config` 白名单以外的键（`url.*.insteadOf` / `pushInsteadOf`、`core.sshCommand`、`filter.*`、`include.*` 等）。私钥路径必须是绝对路径，在 `GIT_SSH_COMMAND` 里加单引号。
- **GitHub 的 22 端口不通时改走 443**：远端是 `git@github.com:…` / `ssh://git@github.com/…` 时，clone、fetch、push、ls-remote 遇到连接层面的失败（连接被断开、超时、连不上；ssh 连接超时 20 秒），自动用 `-o HostName=ssh.github.com -o Port=443 -o HostKeyAlias=github.com` 再试一次（GitHub 官方的 443 端口 SSH，同一把钥匙，按 github.com 的主机密钥核对）；走通的那条路在这个进程里记下来，之后先走它。不少网络（以及 VPN、代理）只拦 22 端口。`~/.ssh/config` 里的 Host 别名不改。报错里「连接被断开」不再误报成部署公钥被拒（git 末尾通用的 `Could not read from remote repository` 不作为判据）。
- **不收符号链接**：暂存区里的符号链接不提交（记日志）；远端分支里有符号链接时拒绝合并，`lastError` 写明，交给人处理。
- **内容不做检查**（规范 v11 §6）：提交前不检查改动里有没有密钥或其他敏感值，她写什么就提交什么（v10 的密钥检查把身体名之类并不保密的值也当成密钥、挡住同步，已取消）。灵魂桥复用 `soul-repo.ts`，前几条同样生效。
- **只同步灵魂仓库自己的历史**（规范 §5.1）：每个克隆在第一次同步（身份与「是不是灵魂仓库」的检查都通过后）记下灵魂仓库的根提交，存在 `.git/quetzal-soul-roots.json`（连同远端地址；部署者换了灵魂仓库地址时重新记录）。之后本地或远端出现陌生的根提交——例如有人在灵魂目录里 `reset` 到了一个代码仓库——基座停止同步（不合并、不推送），在时间线与控制台提醒一次，交给人处理（干净的做法是备份后重新克隆灵魂仓库）。例外（v12）：只经过陌生根提交的那些提交，顶层条目都在规范 §2 之内（同一个 agent 的身体接入时在本地建立的历史）就接受并记下（`soulShaped`）。接入时克隆失败、先在本地初始化的身体，第一次连上远端时发现两边没有共同历史（`merge-base` 失败），合并后把合并提交换成只有远端一个父提交的普通提交（`flatten`），本地那段独立的历史不推上去。
- **agent 的 shell 碰不到灵魂仓库的 git**：边界是沙箱——agent 的命令在 `sandbox.ts` 的沙箱里运行，灵魂目录的工作区可写、`.git` 只读（Linux bwrap；Termux 的 proot 做不到只读，靠上面几条兜底）。另外 `shell` 工具拦下针对灵魂目录的 git 命令（只是提示，换个写法就绕得过去）（`cd soul`、`git -C …/soul`、含灵魂目录路径的命令），返回说明而不执行；主 agent 与子 agent 的系统提示都有「红线」一节：不在灵魂目录里运行 git、灵魂仓库与任何代码仓库（包括 Quetzal 源代码）无关、同步出错不要自己修、不可逆或对外的操作先问人。
- **不会退到别的仓库**：基座执行 git 时设置 `GIT_CEILING_DIRECTORIES` 为灵魂目录的上一级，灵魂目录的 `.git` 丢失时 git 报错，而不是把改动提交进上层目录里的别的仓库。

**冲突解决（自动，仓库不会卡住；真正的分歧交给她）**

| 文件 | 规则 |
|---|---|
| `memories/*.md` | 条目级三方合并：双方新增都保留，任一方删除即删除 |
| `agent.json` | 字段级合并，本地优先 |
| 其他（`SOUL.md`、笔记、技能文档……） | 先采用提交时间较新的一方，同步继续；本地为空或仍是种子人格时采用对方。**两边都真的改过**的文本文件，落选的一版另存为同目录的 `<名>.incoming.md`（冲突副本，不入库、不同步），并提醒最近改过它的那一轮去裁决；副本一直列在系统提示的「灵魂同步」一节里，直到她删掉它。落选版本也完整保留在 git 历史中 |
| `journal/<身体>/`、`bodies/<身体>.json` | 每具身体只写自己的路径，天然无冲突 |

**整理租约**：做梦会改写常驻记忆，两具身体同时整理容易产生重复。做梦前写入 `locks/consolidation.json`（30 分钟有效）并推送——git 推送成功即取得（比较并交换）；另一具身体持有未过期的租约时，这次只是浅睡，不整理。

**知觉**：每次拉取到其他身体的变更，运行基座会写入时间线（「灵魂同步：来自 xx 的 n 次变更，自动处理冲突 m 处」），触发一个 `soul_synced` 感官事件（轻微提升好奇与想念），并在系统提示里加入「灵魂同步（知觉）」段落（含还在本机等待推送的改动数、待裁决的冲突副本）。日常的同步她不需要做任何事；只有推送失败、或两边都改过同一个文件时，基座会直接提醒她。

**历史与撤销**：控制台「高级 · 记忆历史」页列出每次提交（哪具身体、何时、改了什么），可查看差异；撤销会生成反向提交（历史保留），所有身体同步，并在日记里写下「有人撤销了一段记忆变更」。

## 4. 桥接模块（soul-bridge）

独立、可随时插拔的小守护进程（`bridge/`），装在运行 Hermes 或 OpenClaw 的机器上。它**复制**文件而不是创建软链接：OpenClaw 拒绝软链接的 `MEMORY.md`，框架的原子写入也可能替换掉软链接。

**双侧基线合并**：对每个映射，桥接记住「上次写给框架的内容」和「上次在灵魂里看到的内容」：

- 条目：结果 = 灵魂当前条目 + 框架新增 − 框架删除。写回框架时按框架的字符上限截取；被截掉的条目仍留在灵魂里，**不会被误判为删除**（Hermes 写入时会校验格式与上限，因此写回必须合规）。
- 文本：只有一侧改动取改动方；两侧都改且不同时采用较新的一方，落选版本先提交进 git 历史再覆盖。
- 文件：本身体的日记单向导出；其他身体的日记单向镜像；共享笔记逐文件双向合并，删除按基线判断。

| 映射 | Hermes | OpenClaw |
|---|---|---|
| 人格 | `SOUL.md` ↔ `SOUL.md` | `SOUL.md` ↔ `SOUL.md` |
| 常驻笔记 | `memories/MEMORY.md`（§，仓库中不限长；写回 Hermes 时按 `memory_char_limit` 截取，截取不写回仓库） | `MEMORY.md`（自由 Markdown，写回为列表；agent 新写的段落被吸收为条目） |
| 关于用户 | `memories/USER.md`（§，上限取 `user_char_limit`） | `USER.md`（同上，上限 4000） |
| 日记 | —（Hermes 没有日记文件） | `memory/YYYY-MM-DD*.md` → `journal/<身体>/`；其他身体 → `memory/bodies/<身体>/`（可被 memory_search 检索） |
| 共享笔记 | — | `memory/notes/**.md` ↔ `notes/**.md`（按目录树逐篇双向） |
| 生效时机 | 下一个会话（Hermes 在会话开始时读取快照） | 下一轮（OpenClaw 每轮重新读取） |

**插拔**：`init` 接入（导入现有人格与记忆、创建身份、安装钩子与后台服务）；`detach` 拔出（移除钩子与服务，框架文件保持原样，可选删除本地副本）。

**自我安装**：安装由框架里的 agent 按技能（`bridge/skills/soul-bridge/SKILL.md`）自己完成：检查并在用户目录安装 Node.js、获取程序、把技能留在自己的技能目录；按「人类给的地址 → 自己的记忆 → GitHub 上已有的 `*.soul` 私有仓库 → 自动创建」的顺序确定灵魂仓库；一条 `init` 完成全部配置（有 gh 或 `GITHUB_TOKEN` 时自动添加部署密钥，Hermes 钩子预先写入 `shell-hooks-allowlist.json` 批准）；再用 `doctor` 自检并按建议修复。只有缺少 GitHub 凭据、缺少 git 且无 sudo、或同一错误重试 3 次仍失败时，才把需要人类做的事合并成一条消息发出。

新增框架：实现 `bridge/src/types.ts` 的 `Framework` 接口（映射列表、钩子安装与移除），登记到 `bridge/src/frameworks/index.ts`。

## 5. 使用 GitHub 私有仓库

1. 为每个 agent 创建一个**私有**仓库（如 `<用户>/<agent>.soul`），可以是空仓库。
2. 默认每具身体一把 **Deploy key**（勾选 Allow write access）：运行基座在控制台「高级 · 同步」页显示公钥；桥接在 `init` 时输出公钥。拔掉某具身体时，删掉它的 Deploy key 即可吊销。部署者也可以在同一页改为**指定私钥**或**系统 ssh 配置**（`~/.ssh/config` + ssh-agent，地址可用 Host 别名），见规范 §7（v7）。同步状态（上次拉取 / 推送 / 最近错误）落在 `state/soul-status.json`，重启不归零；git 的报错会翻译成提示（例如公钥未加到 Deploy keys）。
3. 第一具接入的身体把现有人格与记忆导入仓库；之后的身体接入时，若本地只有种子身份与种子人格，会直接采用仓库里的。
4. 仓库里只有人格与记忆；API Key、飞书凭据、令牌等一律不进入灵魂仓库。

## 6. 多个 agent

每个 agent 有自己的灵魂仓库与身份 id，身份守卫保证它们不会混在一起。同一台设备可以运行多个运行基座实例（不同的 `QUETZAL_HOME` 与网关端口），桥接也可以在同一台机器上接入多个 agent（`--agent` 区分）。控制台保存多个连接，一键切换。
