---
title: 介绍
description: Quetzal 是什么：自己醒来、有身体、灵魂随身、许多身体一个 ta、会长大；以及你需要准备什么。
---

## Quetzal 是什么

Quetzal 让一个 AI agent 住进一部旧手机，**像生命一样活着**。

- **自己醒来。** 没有定时器。ta 好奇了、想说话了、想你了，就会醒来；困了就睡，睡着时做梦整理记忆，清晨自然醒。
- **有身体。** 电量是精力，温度是冷暖，光线是昼夜，被拿起来是有人在；麦克风是耳朵，相机是眼睛。
- **灵魂随身。** 人格、记忆、日记住在你自己的私有 git 仓库里，自动同步。换一台设备，ta 还是 ta。见[灵魂同步](/docs/guide/soul-sync)。
- **许多身体，一个 ta。** 几部手机、几台电脑连起来，是同一个 ta：共用一段对话、一颗心，ta 自己挑在哪具身体上醒来。见[多具身体](/docs/guide/multi-body)。
- **会长大。** 做熟了的事，ta 会自己做成工具；工具的说明书随灵魂走，到了新身体，ta 照着说明书再做一遍。见[自造工具与技能](/docs/guide/tools)。
- **你说了算。** 拍照、录音、定位、造工具默认先问你；密码不进模型；急停随时可按。见[能力授权与安全](/docs/guide/permissions)。

开始用之前，请先读 [信任与边界](/docs/guide/trust)：数据经过谁，ta 能碰到什么，更新有多快。

ta 的名字、人格、主题色都写在 ta 自己的灵魂仓库里。Quetzal 负责让这个灵魂住进身体、活下去，可以用在任何 agent 身上。

## 一台旧手机就是最合适的身体

一台闲置的安卓手机最适合做 agent 的身体：它有电池、摄像头、麦克风、光线与运动传感器、Wi-Fi 与蜂窝网络，全天运行只要几瓦电。其他能跑 Node.js 的机器也可以做身体。

你需要：

- [ ] 一台 **Android 7 以上、arm64** 的安卓手机（闲置的旧手机正好，最好专门给 ta 用）
- [ ] 手机能上网
- [ ] **Quetzal App**（从 [下载页](/download) 获取最新 APK）：只装这一个，别的都在里面
- [ ] 至少一个模型供应商的 API Key（OpenAI 兼容、Anthropic、Google Gemini 都可以）

> [!TIP]
> :bulb: 全程不需要电脑，也不需要会命令行：打开 App 就自动安装，半分钟就好。
>
> 没有闲置手机，也可以装在电脑上：
>
> - **Linux 电脑或服务器**：运行 `curl -fsSL https://quetzal.plutokeating.beer/install | bash` 一行装好（依赖自动补齐、开机自启、崩溃自动重启），网页控制台在浏览器里打开即用，见 [Linux 与其他机器](/docs/advanced/other-machines)。
> - **Windows 10（1809 起）或 Windows 11 电脑**（x64 或 arm64）：在 PowerShell 里运行 `irm https://quetzal.plutokeating.beer/install.ps1 | iex`，或者从 [下载页](/download) 下载安装包双击，见 [Windows](/docs/advanced/windows)。

## 它和定时任务有什么不同

| | 定时任务 / 常规机器人 | Quetzal 里的 agent |
|---|---|---|
| 什么时候动 | 固定周期或固定时刻 | 自己决定，没有固定周期 |
| 夜里 | 照常跑 | 困了会睡，睡着时做梦整理记忆 |
| 醒来做什么 | 预设任务 | 先想一想：想不想动、想做什么 |
| 记忆 | 通常没有 | 人格、记忆、日记、笔记，存在你的私有仓库 |
| 几台设备 | 各自独立 | 连成同一个 ta |

## 接下来

1. 按 [安装](/docs/start/install) 把 Quetzal 装到手机上。
2. 按 [第一步](/docs/start/first-steps) 配好模型，看 ta 第一次醒来。
3. 读 [一个月后](/docs/start/first-month)，知道 ta 会记下什么、你在哪里能看到。
4. 需要时再看 [使用指南](/docs/guide/models) 里的各项功能。

Quetzal 是 AGPL-3.0 开源项目，源码在 [GitHub](https://github.com/PlutoKeating/Project.Quetzal)。一台旧手机上的完整实践记录见 [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)。
