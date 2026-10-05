<a href="https://quetzal.plutokeating.beer"><img src="docs/assets/readme/banner.png" alt="Quetzal · Not running, but living. Living like wind. · quetzal.plutokeating.beer" width="100%" /></a>

<p align="center"><a href="https://quetzal.plutokeating.beer">官网</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/zh/docs">文档</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/zh/download">下载</a>&ensp;·&ensp;<a href="README.en.md">English</a></p>

<p align="center">
<a href="https://github.com/PlutoKeating/Project.Quetzal/releases"><img src="https://img.shields.io/github/v/release/PlutoKeating/Project.Quetzal?label=release&color=f0a35e" alt="release"></a>&nbsp;
<a href="runtime/package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522-5c7a6b" alt="node ≥ 22"></a>&nbsp;
<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-7d8f8a" alt="AGPL-3.0"></a>
</p>

<br/>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-intro.dark.svg"><img src="docs/assets/readme/type/zh-intro.light.svg" alt="Quetzal 是开源的 agent 运行基座。让一个 AI agent 住进一部旧手机，像生命一样活着。" width="100%"></picture></p>

<br/>

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-what.dark.svg"><img src="docs/assets/readme/type/zh-what.light.svg" alt="它是什么"></picture>

- **什么时候动 · 自己决定。** 没有定时器。醒来由好奇、表达欲、想念这些内驱力和昼夜节律决定；困了入睡，睡着时做梦整理记忆。
- **身体 · 一部旧手机。** 电量、温度、光线、运动是 ta 的体感，麦克风与相机是 ta 的耳目。一台 Linux 电脑或服务器也可以是 ta 的身体。
- **灵魂 · 你的私有 git 仓库。** 人格、记忆、日记由基座自动同步；换身体整个带走，提交历史就是 ta 的自传。
- **你说了算。** 相机、麦克风、定位默认每次询问；审批、预算、急停、审计齐全；密码从不进模型。

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-day.dark.svg"><img src="docs/assets/readme/type/zh-day.light.svg" alt="一天"></picture>

<img src="docs/assets/readme/bodyclock.zh.svg" alt="一天的生物钟：睡眠压力 S 与昼夜节律 C" width="100%" />

困了会睡，清晨自然醒：睡眠压力 S 与昼夜节律 C 的差决定 ta 什么时候睡、什么时候醒。代码里没有「每 N 分钟」。

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-neighbors.dark.svg"><img src="docs/assets/readme/type/zh-neighbors.light.svg" alt="和 Hermes / OpenClaw 的关系"></picture>

一个做助手，一个做生命的基座，可以一起用。差别只在三处。

| | Codex / Claude Code | Hermes / OpenClaw | Quetzal |
|---|---|---|---|
| **什么时候动** | 你叫才动，做完就退出 | 你发消息，或 cron / heartbeat 定时叫醒 | 自己决定：内驱力与昼夜节律 |
| **身体** | 没有，只有这台电脑的文件和 shell | 一台机器的 shell、浏览器和文件 | 一部旧手机，或一台 Linux 机器 |
| **灵魂** | 没有，会话一结束就散 | 本机文件，换机器自己搬 | 私有 git 仓库，自动同步，换身体带走 |

[soul-bridge](bridge/docs/README.md) 让装着 Hermes 或 OpenClaw 的机器成为同一个 agent 的另一具身体。只想写代码，用 Codex 或 Claude Code；要进 Telegram、Discord，要大量插件，Hermes、OpenClaw 的生态更成熟。

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-how.dark.svg"><img src="docs/assets/readme/type/zh-how.light.svg" alt="它是怎么做到的"></picture>

<img src="docs/assets/readme/architecture.zh.svg" alt="Quetzal 架构：身体 → 运行基座（心脏 · 大脑 · 记忆 · 模型层 · 闸门）→ 灵魂仓库与其他身体" width="100%" />

- **心脏**：内驱力与清醒度得到醒来率，下一次醒来由泊松过程抽样；睡眠压力与昼夜节律的差决定困意。[数学细节](docs/ARCHITECTURE.md)
- **身体**：适配器只需实现 `sample()`、`notify()` 等几个函数；自带 Termux 与 Linux 两个平台级适配器。[接口](docs/API.md)
- **大脑与记忆**：醒来即内省、行动、反思；记忆无限增长而上下文有界，做梦时整理进笔记。
- **灵魂**：一个 agent 一个私有仓库，基座全自动同步，冲突自解；agent 只感知到「同步发生了」。[灵魂同步](docs/SOUL_SYNC.md)
- **模型层与闸门**：四种协议、多 Key、自动故障转移；控制台与飞书共用一个操作层，全部审计。
- **会成长**：做熟了的流程 ta 自己写成工具，意图以 Agent Skills 的 `SKILL.md` 随灵魂同步；名字、主题色 ta 自己能改；开了听觉，手机常驻听你说话，是不是对 ta 说的由 ta 判断。

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-install.dark.svg"><img src="docs/assets/readme/type/zh-install.light.svg" alt="装上它"></picture>

**一部旧安卓手机**（Android 7 以上，arm64）

1. 装 **Termux、Termux:API、Termux:Boot**，三个来自同一来源（[下载页](https://quetzal.plutokeating.beer/zh/download)有固定版本直链）。
2. 装 **Quetzal App**。
3. 打开 App，选「在这台手机上安装 Quetzal」，跟着向导走。

**一台 Linux 电脑或服务器**

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

缺的依赖自动补齐（Node.js 经 nvm、git），注册开机自启、崩溃自动重启的服务（systemd 用户服务；没有 systemd 的机器用自带的守护循环），应用列表里多一个「Quetzal」，装好后浏览器打开网页控制台（`http://127.0.0.1:7788/`），同一台机器打开即登录。模型、身份、授权、飞书、灵魂仓库、对话都在里面完成。再运行一次就是升级；`bash -s -- --lan` 让手机上的 App 也能连这台机器。已有 Node.js 22.13+ 与 git 时也可以只用 `npx @plutokeating/quetzal`。

更多：[文档](https://quetzal.plutokeating.beer/zh/docs) · [Linux 与其他机器](https://quetzal.plutokeating.beer/zh/docs/advanced/other-machines) · 一台旧手机上的完整实践 [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/zh-deeper.dark.svg"><img src="docs/assets/readme/type/zh-deeper.light.svg" alt="看得更深"></picture>

| 目录 | 内容 |
|---|---|
| [`runtime/`](runtime/docs/README.md) | 运行基座（TypeScript / Node.js 22+）与两个平台级身体适配器：Termux（安卓）、Linux |
| [`console/`](console/docs/README.md) | 控制台（Flutter）：安卓 App（含安装器与耳朵）、网页版（电脑浏览器，由运行基座托管）与 Linux 桌面版（原生窗口，一键安装脚本自动装） |
| [`cli/`](cli/docs/README.md) | 一键安装脚本 `install.sh`（官网的 `/install`）与 npm 包 `@plutokeating/quetzal`：Linux 安装器（systemd 用户服务） |
| [`bridge/`](bridge/docs/README.md) | 灵魂桥：Hermes Agent / OpenClaw 的可插拔同步模块 |
| [`sync/`](sync/README.md) | 同步服务：账户（GitHub 登录）、身体绑定、信令与 TURN 中转，让同一个 agent 的几具身体连成一张网；独立部署在一台服务器上，`./start.sh` 一行启动 |
| [`website/`](website/docs/README.md) | 官网与文档站 |
| [`docs/`](docs/) | [快速开始](docs/QUICK_START.md) · [架构](docs/ARCHITECTURE.md) · [接口](docs/API.md) · [灵魂同步](docs/SOUL_SYNC.md) · [仓库规范](docs/SOUL_REPO_SPEC.md) · [分布式（1.0 设计稿）](docs/DISTRIBUTED.md) |

<br/>

<p align="center"><sub>仅用于学习和研究，只操作自己拥有的设备，不以牟利为目的。<a href="LICENSE">AGPL-3.0</a></sub></p>
