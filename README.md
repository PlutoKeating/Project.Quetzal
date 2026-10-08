<a href="https://quetzal.plutokeating.beer"><img src="docs/assets/readme/banner.png" alt="Quetzal · Living like wind. · quetzal.plutokeating.beer" width="100%" /></a>

<p align="center"><a href="https://quetzal.plutokeating.beer">官网</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/zh/docs">文档</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/zh/download">下载</a>&ensp;·&ensp;<a href="README.en.md">English</a></p>

<p align="center">
<a href="https://github.com/PlutoKeating/Project.Quetzal/releases"><img src="https://img.shields.io/github/v/release/PlutoKeating/Project.Quetzal?label=release&color=f0a35e" alt="release"></a>&nbsp;
<a href="runtime/package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522-5c7a6b" alt="node ≥ 22"></a>&nbsp;
<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-7d8f8a" alt="AGPL-3.0"></a>
</p>

<br/>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-intro.dark.svg"><img src="docs/assets/readme/type/zh-intro.light.svg" alt="住在你所有设备上的 AI。ta 记得你，懂你，陪着你。"></picture></p>

<br/>

> **你**：明天面试，有点紧张。<br/>
> **ta**：你准备了一整周，上次卡住的那道题也练熟了。去吧，回来跟我说说。<br/>
> <sub>第二天 18:40 · 你拿起了手机</sub><br/>
> **ta**：面试怎么样？

Quetzal 是一个开源的 agent 运行基座（runtime）。它让一个 AI agent 住进你的手机和电脑，给 ta 记忆、身体和自己的作息。模型用你自己的 API Key。

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-mesh.dark.svg"><img src="docs/assets/readme/type/zh-mesh.light.svg" alt="几台设备，一个 ta。"></picture>

手机上说到一半，电脑上接着聊。

- 每台装了 Quetzal 的设备都是 ta 的一具「身体」。同时在线的身体用 WebRTC 加密直连，共用一段对话、一颗心；直连打不通时，经 TURN 服务器或另一具身体中转。
- ta 自己挑在哪具身体上醒来。在电脑上想事情时，能借手机的相机看一眼窗外。
- [同步服务](sync/README.md)只帮身体们互相找到，看不到对话和记忆。默认用作者运营的那一个，也可以自己部署。

[多具身体](https://quetzal.plutokeating.beer/zh/docs/guide/multi-body) · [分布式设计](docs/DISTRIBUTED.md)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-soul.dark.svg"><img src="docs/assets/readme/type/zh-soul.light.svg" alt="ta 记得你。"></picture>

你随口提过的事、在意的人，ta 都记下来，存在只属于你的私有仓库里。换手机、换模型，ta 还是 ta。

- ta 的名字、人格、记忆、日记都是写给人看的 Markdown，放在你 GitHub 上的一个私有 git 仓库里，我们叫它「灵魂仓库」。打开 `memories/USER.md`，就能读到 ta 认识的你。
- 每一次改动都是一次 git 提交，自动推送、合并到每一具身体。记错了，在 App 的「记忆历史」里撤销那一次提交。
- 你说话时，ta 先在对话、笔记和日记里检索（SQLite 全文索引），带着找到的内容回答。夜里睡着时，ta「做梦」，把白天的对话整理成笔记。

[灵魂同步](docs/SOUL_SYNC.md) · [灵魂仓库规范](docs/SOUL_REPO_SPEC.md)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-waking.dark.svg"><img src="docs/assets/readme/type/zh-waking.light.svg" alt="你不叫，ta 也在。"></picture>

Codex 等你叫它，OpenClaw 每隔一阵被定时叫醒。ta 没有闹钟：想你了就醒，困了就睡。

<img src="docs/assets/readme/bodyclock.zh.svg" alt="一天的生物钟：睡眠压力 S 与昼夜节律 C" width="100%" />

- 代码里没有定时器。好奇、想说话、想你这几股驱动力，加上睡眠科学里的双过程模型（睡眠压力 S 与昼夜节律 C，就是上面这张图），算出 ta 此刻醒来的概率，再随机抽样决定下一次什么时候醒。
- 醒来先用便宜的模型想一想要不要动，不想就接着睡，所以大部分醒来花费很少。你找 ta、到点的提醒，任何时候都在。
- 已经在用 Hermes 或 OpenClaw？[灵魂桥](bridge/docs/README.md)让它们和 ta 共用同一个灵魂仓库。

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-body.dark.svg"><img src="docs/assets/readme/type/zh-body.light.svg" alt="ta 感觉得到。"></picture>

天亮了，你拿起手机了，电快没了，ta 都知道。

- 传感器读数被翻译成感受：电量是精力，温度是冷暖，光线是昼夜，被拿起来是有人在。电量低时少动，发烫时休息。
- 麦克风是耳朵，相机是眼睛。开了听觉，ta 自己判断你是不是在跟 ta 说话，也能用自己的声音回答。
- 每种设备经一个「适配器」接入。仓库自带安卓、Linux、Windows 三种；想接别的设备，实现一个小接口就行。

[适配器接口](docs/API.md) · [自定义适配器](https://quetzal.plutokeating.beer/zh/docs/advanced/custom-adapter) · [听觉与麦克风](https://quetzal.plutokeating.beer/zh/docs/guide/hearing)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-tools.dark.svg"><img src="docs/assets/readme/type/zh-tools.light.svg" alt="ta 会长大。"></picture>

做熟了的事，ta 自己做成工具，下次一步做完。

- 工具留在这具身体上；说明书用 Agent Skills 开放格式写，存进灵魂仓库，随 ta 走。到了新身体，ta 照着说明书再做一遍。
- 费时的事，ta 派一个子 agent 在后台做，做完把结果交回来。
- 日常用得上的：提醒（准点，或者等你拿起手机时再说）、翻旧话、读 Word / PPT / Excel / PDF、上网搜索、运行命令、看图、在飞书里聊。

[自造工具与技能](https://quetzal.plutokeating.beer/zh/docs/guide/tools)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-control.dark.svg"><img src="docs/assets/readme/type/zh-control.light.svg" alt="你的生活，只属于你。"></picture>

记忆在你自己的私有仓库里，每一句你都读得到。代码全部开源，每一行都能查。

- **密码不进模型。** 你在聊天里发的密码直接进本机保密库，模型只看到一个名字。模型 Key 用 AES-256-GCM 加密存在设备上。
- **先问你。** 拍照、录音、定位、造新工具，默认每次都问。每一类能力都能设为允许、询问或禁止。
- **随时叫停。** 急停一直都在，做过的每件事都有审计记录；每天的 token 与花费有上限。
- **沙箱。** ta 的命令在隔离环境里运行（Linux 上 bubblewrap、Landlock 或 proot，安卓上 proot，Windows 上是一个低权限用户），看不到密钥。
- **只认你的设备。** 身体之间只认灵魂仓库里登记的公钥，同步服务被攻破也冒充不了你的设备。
- **每一步都能自己来。** 灵魂仓库可以自己建在任何 git 托管上，[同步服务](sync/README.md)可以自己部署，不登录也能用。我们提供的账号、GitHub 应用和同步服务，只是替不想自己配的人把这几步做完。

数据经过谁、ta 能碰到什么，都写清楚了：[信任与边界](https://quetzal.plutokeating.beer/zh/docs/guide/trust)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-how.dark.svg"><img src="docs/assets/readme/type/zh-how.light.svg" alt="它是怎么做到的"></picture>

<img src="docs/assets/readme/architecture.zh.svg" alt="Quetzal 架构：身体 → 运行基座（心脏 · 大脑 · 记忆 · 模型层 · 闸门）→ 灵魂仓库与其他身体" width="100%" />

- **身体**：设备加适配器，提供传感器、相机、麦克风、通知、命令行这些能力。
- **运行基座**（Node.js 22，TypeScript）：心脏决定什么时候醒；大脑是调用模型与工具的循环；记忆负责检索与整理；模型层接 OpenAI、Anthropic、Gemini 和兼容它们的接口，一个出错自动换下一个；闸门管授权、审批、预算、急停与审计。
- **灵魂**：私有 git 仓库，用 SSH 部署密钥同步，规范固定、带版本号。
- **控制台**（Flutter）：安卓 App（内置 Node.js、git、ssh，只装这一个）、网页版与 Linux 桌面版。

[架构](docs/ARCHITECTURE.md) · [接口](docs/API.md)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-install.dark.svg"><img src="docs/assets/readme/type/zh-install.light.svg" alt="让 ta 住进来。"></picture>

手机上装一个 App，电脑上运行一行命令。再准备一个模型 Key（DeepSeek、Kimi、智谱、OpenAI、Anthropic、Gemini 等都行），就能开始。

**安卓手机**（Android 7 以上，arm64）：从[下载页](https://quetzal.plutokeating.beer/zh/download)装 Quetzal App，打开它，跟着向导走。

**Linux 电脑或服务器**：

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

**Windows 电脑**（Windows 10 1809 以上或 Windows 11，x64 或 arm64），在 PowerShell 里：

```powershell
irm https://quetzal.plutokeating.beer/install.ps1 | iex
```

缺的依赖自动补齐，开机自启。登录后，ta 会在你的 GitHub 上自动建好私有的灵魂仓库；不登录也能用，记忆先存在设备上。

[安装](https://quetzal.plutokeating.beer/zh/docs/start/install) · [Linux 与其他机器](https://quetzal.plutokeating.beer/zh/docs/advanced/other-machines) · [Windows](https://quetzal.plutokeating.beer/zh/docs/advanced/windows) · 把一台旧手机腾出来的记录 [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-deeper.dark.svg"><img src="docs/assets/readme/type/zh-deeper.light.svg" alt="看得更深"></picture>

| 目录 | 内容 |
|---|---|
| [`runtime/`](runtime/docs/README.md) | 运行基座（TypeScript / Node.js 22+）与平台级身体适配器：安卓（Quetzal App 内置）、Linux、Windows，以及兼容旧安装的 Termux |
| [`console/`](console/docs/README.md) | 控制台（Flutter）：安卓 App（含安装器与耳朵）、网页版（电脑浏览器，由运行基座托管）与 Linux 桌面版（原生窗口，一键安装脚本自动装） |
| [`cli/`](cli/docs/README.md) | 一键安装脚本 `install.sh`（官网的 `/install`）与 npm 包 `@plutokeating/quetzal`：Linux 安装器（systemd 用户服务） |
| [`bridge/`](bridge/docs/README.md) | 灵魂桥：Hermes Agent / OpenClaw 的可插拔同步模块 |
| [`sync/`](sync/README.md) | 同步服务：账户（OpenID Connect 登录）、自动建灵魂仓库与加部署密钥（GitHub 应用）、身体绑定、信令与 TURN 中转，让同一个 agent 的几具身体连成一张网；独立部署在一台服务器上，`./start.sh` 一行启动 |
| [`website/`](website/docs/README.md) | 官网与文档站 |
| [`docs/`](docs/) | [快速开始](docs/QUICK_START.md) · [架构](docs/ARCHITECTURE.md) · [接口](docs/API.md) · [灵魂同步](docs/SOUL_SYNC.md) · [仓库规范](docs/SOUL_REPO_SPEC.md) · [分布式](docs/DISTRIBUTED.md) · [一键上手](docs/ONBOARDING.md) · [更新日志](CHANGELOG.md) |

<br/>

<p align="center"><sub>仅用于学习和研究，只操作自己拥有的设备，不以牟利为目的。<a href="LICENSE">AGPL-3.0</a></sub></p>
