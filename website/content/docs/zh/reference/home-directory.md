---
title: 家目录与配置
description: WINDLER_HOME 的目录结构、config/windler.json 的全部配置项，以及安卓 / Termux 部署的文件约定。
---

## `WINDLER_HOME`（默认 `~/windler`）

```
config/windler.json      运行配置（App 可改）
config/providers.json    模型供应商（Key 为密文）
secrets/                 0700：master.key（Key 加密主密钥）、gateway.token、feishu_secret、soul_ed25519、azure_speech_key
vault/                   0700：保密库，每项一个 0600 文件；index.json 只记说明
data/windler.db          SQLite：kv / timeline / messages / audit / usage
data/catalog.json        公共模型目录缓存（models.dev）
data/uploads/<日期>/      对话附件
data/media/              ta 拍的照片、录音（Termux 适配器）
soul/                    灵魂目录（git 仓库）
state/starts.json        启动记录（熔断用）
STOP                     急停标志：存在即冻结一切行动
```

> [!IMPORTANT]
> `secrets/`、`vault/`、`config/providers.json` 只属于这具身体，不进灵魂仓库、不同步。备份手机时请连同家目录一起备份。

## `config/windler.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `body` | `default` | 身体名称（日记目录名）；安装器写为机型名 |
| `adapter` | `""` | 适配器模块路径（Termux 部署用环境变量 `WINDLER_ADAPTER`） |
| `timezone` | 系统时区（拿不到时 `Asia/Shanghai`） | 生物钟与日记使用的时区 |
| `heart.activity` | `1` | 活跃度（0–4） |
| `heart.baseRatePerHour` | `4` | 饱和醒来率 $\lambda_0$ |
| `heart.paused` | `false` | 暂停自主 |
| `budget.dailyTokens` | `2000000` | 每日 token |
| `budget.dailyCostUsd` | `5` | 每日费用（美元） |
| `budget.minBattery` | `15` | 最低电量（%） |
| `budget.maxTempC` | `45` | 最高温度 |
| `permissions.*` | `camera` / `microphone` / `location` / `hands` 为 `ask`，其余 `allow` | 能力授权 |
| `brain.maxOutputTokens` | `4096` | 每次模型调用的输出上限（步数不设上限） |
| `feishu.*` | — | 飞书（Secret 在 `secrets/`） |
| `soul.remote` / `soul.branch` | `""` / `main` | 灵魂仓库 SSH 地址与分支 |
| `gateway.port` | `7788` | 网关端口 |
| `speech.region` / `endpoint` / `voice` / `style` / `rate` / `pitch` / `volume` / `format` | `""` / `""` / `zh-CN-XiaoxiaoNeural` / `""` / `0%` / `0%` / `100` / `audio-24khz-48kbitrate-mono-mp3` | Azure 语音（密钥在 `secrets/azure_speech_key`） |

所有这些都能在 App 里改，不需要手编文件。

## 环境变量

| 变量 | 说明 |
|---|---|
| `WINDLER_HOME` | 家目录 |
| `WINDLER_ADAPTER` | 身体适配器模块路径 |
| `WINDLER_CONSOLE_ACTIVITY` | （Termux 适配器）通知按钮打开的界面，默认 `xyz.windler.console/.MainActivity` |

## 安卓 / Termux 部署约定

Windler App 的安装器与点火器按此约定工作：

```
~/windler/releases/<版本>/        main.cjs、termux.mjs
~/windler/current → releases/…    运行中的版本
~/windler/previous → releases/…   上一版（回退用）
$PREFIX/var/service/windler/run   runit 服务：WINDLER_ADAPTER=$HOME/windler/current/termux.mjs
$PREFIX/var/log/sv/windler/       日志（svlogd 自动轮转）
~/.termux/boot/windler            开机脚本：termux-wake-lock + 启动 runit
~/.termux/termux.properties       allow-external-apps=true
```

软件包：`nodejs-lts termux-services termux-api git openssh`。只保留最近 3 个版本。健康检查 40 秒不通过自动切回 `previous`。

## Linux / npm 部署约定

npm 包 `windler`（`npx windler`）按此约定工作，与安卓同构：

```
~/windler/releases/<版本>/              main.cjs、linux.mjs
~/windler/current → releases/…          运行中的版本
~/windler/previous → releases/…         上一版（回退用）
~/.config/systemd/user/windler.service  systemd 用户服务：WINDLER_HOME、WINDLER_ADAPTER=~/windler/current/linux.mjs，Restart=always
journalctl --user -u windler            日志（npx windler logs）
```

要求 Node.js 22.13+。只保留最近 3 个版本。健康检查 40 秒不通过（或 `/health` 的版本不符）自动切回 `previous`。`--lan` 把 `config/windler.json` 的 `gateway.host` 写为 `0.0.0.0`。
