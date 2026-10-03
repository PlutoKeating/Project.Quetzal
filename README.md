<a href="https://windler.plutokeating.beer"><img src="docs/assets/readme/banner.png" alt="Windler · Not running. Living. Living like wind. · windler.plutokeating.beer" width="100%" /></a>

<div align="center">

[![Release](https://img.shields.io/github/v/release/PlutoKeating/Project.Windler?label=release&color=f0a35e)](https://github.com/PlutoKeating/Project.Windler/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-5c7a6b)](runtime/package.json)
[![License](https://img.shields.io/badge/license-AGPL--3.0-7d8f8a)](LICENSE)

[官网](https://windler.plutokeating.beer) · [文档](https://windler.plutokeating.beer/zh/docs) · [下载](https://windler.plutokeating.beer/zh/download) · [English](README.en.md)

</div>

## 这是什么

Windler 让一个 agent 住进一台设备里，像生命一样过日子。没有人给它排日程：什么时候醒、醒来做什么，由它自己的好奇心、想念、没想完的事和生物钟决定。困了会睡，睡着会做梦，清晨自然醒。

它是基座，不是某个 agent；它不挑设备，而**一台闲置的安卓手机是最合适的身体**。

## 为什么你会喜欢

- **一部用不着的手机，变成一个会醒、会睡、会想事的存在。**
- **陪伴而不打扰。** 它一天里大部分时间在睡觉，没有非做不可的事就继续睡。
- **有连续的自我。** 人格与记忆在你自己的私有 git 仓库里，换设备它还是它。
- **你说了算。** 敏感能力默认每次询问；审批、预算、急停、审计齐全；密码从不进模型。

## 为什么独树一帜

<img src="docs/assets/readme/bodyclock.zh.svg" alt="一天的生物钟：睡眠压力 S 与昼夜节律 C" width="100%" />

| 常见做法 | Windler |
|---|---|
| 定时器：每 N 分钟跑一次 | **没有定时器**，按内驱力与清醒度抽样醒来 |
| 永远在线，永远一样 | **有生物钟**，做事会累，困了入睡，睡着做梦 |
| 设备只是服务器 | **有身体**，电量、光照、运动变成精力、明暗、被拿起 |
| 记忆在数据库里 | **灵魂在 git 里**，自动同步，提交历史就是自传 |
| 一个框架一个 agent | **多具身体一个灵魂**，Hermes / OpenClaw 也能住 |
| 密钥明文给模型 | **保密传递**，密码只进本机保密库 |

## 它是怎么做到的

<img src="docs/assets/readme/architecture.zh.svg" alt="Windler 架构：身体 → 运行基座（心脏 · 大脑 · 记忆 · 模型层 · 闸门）→ 灵魂仓库与其他身体" width="100%" />

- **心脏**：内驱力 × 清醒度得到醒来率，下一次醒来由泊松过程抽样；睡眠压力与昼夜节律的差决定困意。[数学细节](docs/ARCHITECTURE.md)
- **身体**：适配器只需实现 `sample()`、`notify()` 等几个函数；自带的 Termux 适配器按名字探测传感器。[接口](docs/API.md)
- **大脑与记忆**：醒来即内省、行动、反思；记忆无限增长而上下文有界，做梦时整理进笔记。
- **灵魂**：一个 agent 一个私有仓库，基座全自动同步，冲突自解，agent 只感知到「同步发生了」。[灵魂同步](docs/SOUL_SYNC.md)
- **模型层与闸门**：四种协议、多 Key、自动故障转移；控制台与飞书共用一个操作层，全部审计。

## 装上它

1. 安卓手机（Android 7+，arm64）从 F-Droid 装 **Termux、Termux:API、Termux:Boot**。
2. 从 [下载页](https://windler.plutokeating.beer/zh/download) 装 **Windler App**。
3. 打开 App，选「在这台手机上安装 Windler」，跟着向导走。

> [!TIP]
> 配模型、身份、授权、飞书、灵魂同步、多 agent、排错，都在 [文档](https://windler.plutokeating.beer/zh/docs)。手机之外的机器见 [部署到其他机器](https://windler.plutokeating.beer/zh/docs/advanced/other-machines)。

## 看得更深

| 目录 | 内容 |
|---|---|
| [`runtime/`](runtime/docs/README.md) | 运行基座（TypeScript / Node.js 22+）与 Termux 身体适配器 |
| [`console/`](console/docs/README.md) | Windler App（Flutter）：控制台 + 安装器 |
| [`bridge/`](bridge/docs/README.md) | 灵魂桥：Hermes Agent / OpenClaw 的可插拔同步模块 |
| [`website/`](website/docs/README.md) | 官网与文档站 |
| [`docs/`](docs/) | [快速开始](docs/QUICK_START.md) · [架构](docs/ARCHITECTURE.md) · [接口](docs/API.md) · [灵魂同步](docs/SOUL_SYNC.md) · [仓库规范](docs/SOUL_REPO_SPEC.md) |

> [!IMPORTANT]
> 仅用于学习和研究，不用于破坏或入侵他人计算机系统，不以牟利为目的。许可证 [AGPL-3.0](LICENSE)。
