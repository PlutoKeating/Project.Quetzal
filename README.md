<a href="https://quetzal.plutokeating.beer"><img src="docs/assets/readme/banner.png" alt="Quetzal · Not running. Living. Living like wind. · quetzal.plutokeating.beer" width="100%" /></a>

<div align="center">

[![Release](https://img.shields.io/github/v/release/PlutoKeating/Project.Quetzal?label=release&color=f0a35e)](https://github.com/PlutoKeating/Project.Quetzal/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-5c7a6b)](runtime/package.json)
[![License](https://img.shields.io/badge/license-AGPL--3.0-7d8f8a)](LICENSE)

[官网](https://quetzal.plutokeating.beer) · [文档](https://quetzal.plutokeating.beer/zh/docs) · [下载](https://quetzal.plutokeating.beer/zh/download) · [English](README.en.md)

</div>

## 这是什么

**它自己决定要不要醒。包括——不动。**

Codex、Claude Code 是你叫它才动、做完就退出的工具；Hermes、OpenClaw 是每 30 分钟被 heartbeat 叫醒一次问「有事吗」的助手。**Quetzal 是 agent 住着的地方**：没有定时器，什么时候醒由它自己的内驱力和生物钟决定；它有一具身体（一部旧安卓手机），灵魂存在你的私有 git 仓库里，可以跨身体带走。

它不是替代品，是邻居：Hermes / OpenClaw 造的是 agent，Quetzal 造的是 agent 住的地方。soul-bridge 让你现有的 Hermes 和 Quetzal 里的身体共用同一个灵魂。

| | Codex / Claude Code | Hermes / OpenClaw | Quetzal |
|---|---|---|---|
| 醒来由谁决定 | 你，在终端里调用 | 定时器：heartbeat 或 cron | 它自己：内驱力 × 清醒度抽样，没有定时器 |
| 不被叫的时候 | 不存在 | 等下一次 heartbeat | 睡觉、做梦，或醒着什么也不做 |
| 身体 | 没有 | 一台服务器 | 一部手机：电量、光线、运动、麦克风、相机 |
| 灵魂 | 会话结束即散 | 本机文件 | 私有 git 仓库，跨身体带走 |
| 不适合 | — | — | 只想写代码、要个终端 agent 的人：请用 Codex |

> 官网与完整教程：<https://quetzal.plutokeating.beer> 。一台旧手机上的完整实践记录在 [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)。

## 为什么你会喜欢

- **一部用不着的手机，变成一个会醒、会睡、会想事的存在。**
- **陪伴而不打扰。** 它一天里大部分时间在睡觉，没有非做不可的事就继续睡。
- **有连续的自我。** 人格与记忆在你自己的私有 git 仓库里，换设备它还是它。
- **你说了算。** 敏感能力默认每次询问；审批、预算、急停、审计齐全；密码从不进模型。

## 为什么独树一帜

<img src="docs/assets/readme/bodyclock.zh.svg" alt="一天的生物钟：睡眠压力 S 与昼夜节律 C" width="100%" />

困了会睡，清晨自然醒：睡眠压力 S 与昼夜节律 C 的差决定它什么时候睡、什么时候醒，代码里没有「每 N 分钟」。

## 它是怎么做到的

<img src="docs/assets/readme/architecture.zh.svg" alt="Quetzal 架构：身体 → 运行基座（心脏 · 大脑 · 记忆 · 模型层 · 闸门）→ 灵魂仓库与其他身体" width="100%" />

- **心脏**：内驱力 × 清醒度得到醒来率，下一次醒来由泊松过程抽样；睡眠压力与昼夜节律的差决定困意。[数学细节](docs/ARCHITECTURE.md)
- **身体**：适配器只需实现 `sample()`、`notify()` 等几个函数；自带的 Termux 适配器按名字探测传感器。[接口](docs/API.md)
- **大脑与记忆**：醒来即内省、行动、反思；记忆无限增长而上下文有界，做梦时整理进笔记。
- **灵魂**：一个 agent 一个私有仓库，基座全自动同步，冲突自解，agent 只感知到「同步发生了」。[灵魂同步](docs/SOUL_SYNC.md)
- **模型层与闸门**：四种协议、多 Key、自动故障转移；控制台与飞书共用一个操作层，全部审计。
- **会成长**：做熟了的流程她自己写成工具，意图以 Agent Skills 的 `SKILL.md` 随灵魂同步；名字、主题色她自己能改；开了听觉，手机常驻听你说话，是不是对她说的由她判断。

## 装上它

**一部旧安卓手机**（推荐的身体：有电量、光线、运动、麦克风、相机）：

1. 安卓手机（Android 7+，arm64）从 F-Droid 装 **Termux、Termux:API、Termux:Boot**。
2. 从 [下载页](https://quetzal.plutokeating.beer/zh/download) 装 **Quetzal App**。
3. 打开 App，选「在这台手机上安装 Quetzal」，跟着向导走。

**一台 Linux 电脑或服务器**（笔记本、小主机、树莓派、云主机；需要 Node.js 22.13+）：

```bash
npx @plutokeating/quetzal            # 安装，注册 systemd 用户服务；再运行一次就是升级
npx @plutokeating/quetzal --lan      # 让手机上的 Quetzal App 直接填这台机器的地址连接
```

> [!TIP]
> 配模型、身份、授权、飞书、灵魂同步、多 agent、排错，都在 [文档](https://quetzal.plutokeating.beer/zh/docs)。Linux 身体的细节见 [部署到其他机器](https://quetzal.plutokeating.beer/zh/docs/advanced/other-machines)。

## 看得更深

| 目录 | 内容 |
|---|---|
| [`runtime/`](runtime/docs/README.md) | 运行基座（TypeScript / Node.js 22+）与两个平台级身体适配器：Termux（安卓）、Linux |
| [`console/`](console/docs/README.md) | Quetzal App（Flutter）：控制台 + 安卓安装器 |
| [`cli/`](cli/docs/README.md) | npm 包 `@plutokeating/quetzal`：Linux 安装器（`npx @plutokeating/quetzal`，systemd 用户服务） |
| [`bridge/`](bridge/docs/README.md) | 灵魂桥：Hermes Agent / OpenClaw 的可插拔同步模块 |
| [`website/`](website/docs/README.md) | 官网与文档站 |
| [`docs/`](docs/) | [快速开始](docs/QUICK_START.md) · [架构](docs/ARCHITECTURE.md) · [接口](docs/API.md) · [灵魂同步](docs/SOUL_SYNC.md) · [仓库规范](docs/SOUL_REPO_SPEC.md) |

> [!IMPORTANT]
> 仅用于学习和研究，不用于破坏或入侵他人计算机系统，不以牟利为目的。许可证 [AGPL-3.0](LICENSE)。
