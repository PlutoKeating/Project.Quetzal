---
title: 家目录与配置
description: QUETZAL_HOME 的目录结构、config/quetzal.json 的全部配置项，以及安卓（App 内置）、Termux（旧安装）、Linux 与 Windows 部署的文件约定。
---

## `QUETZAL_HOME`（默认：安卓 App 数据目录下的 `files/home/quetzal`，旧的 Termux 安装 `~/quetzal`，Windows `%LOCALAPPDATA%\Quetzal\home`，Linux 等其他机器 `~/.quetzal`；都可用环境变量改）

```
config/quetzal.json      运行配置（App 可改）
config/providers.json    模型供应商（Key 为密文）
secrets/                 0700：master.key（Key 加密主密钥）、gateway.token、gateway-tls.key / gateway-tls.crt（局域网 HTTPS 的自签名证书）、feishu_secret、soul_ed25519、azure_speech_key；安卓 App 内置时还有 body.json（身体接口的端口与令牌，App 每次启动重写）
vault/                   0700：保密库，每项一个 0600 文件；index.json 只记说明
data/quetzal.db          SQLite：kv / timeline / messages / audit / usage
data/catalog.json        公共模型目录缓存（models.dev）
data/uploads/<日期>/      对话附件
data/media/              ta 拍的照片、录音（安卓适配器）
data/mesh-pins.json      多具身体时：第一次见到每具身体时记下的公钥与类型（不是秘密）
data/mesh-lan.json       多具身体时：记得的其他身体的局域网地址，同步服务连不上时经局域网互连用（只在这台设备上）
data/from-bodies/<身体>/  多具身体时从别的身体取来的文件（工具带 body 时，见多具身体）
data/runtime.log         安卓 App 内置时：运行基座与 App 服务的日志（超过 4 MB 轮转一次）
soul/                    灵魂目录（git 仓库）
state/starts.json        启动记录（熔断用）
state/body-uuid          这具身体的 uuid（JSON：uuid 与来源 device / random / manual；只存哈希派生的值，不存原始标识；见多具身体）
STOP                     急停标志：存在即冻结一切行动
```

> [!IMPORTANT]
> `secrets/`、`vault/`、`config/providers.json` 只属于这具身体，不进灵魂仓库，也不同步。备份手机时请连同家目录一起备份。

## `config/quetzal.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `body` | `default` | 身体名称（日记目录名）；安装器写为机型名 |
| `adapter` | `""` | 适配器模块路径（安卓 App 与 Termux 部署用环境变量 `QUETZAL_ADAPTER`） |
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
| `gateway.port` | `7788` | 网关的明文端口（只监听本机回环） |
| `gateway.lan` / `gateway.lanPort` / `gateway.host` | `false` / `7789` / `127.0.0.1` | 对局域网开放（`lan` 为真或 `host` 不是回环地址）：在 `host`（回环时为 `0.0.0.0`）:`lanPort` 上开 HTTPS / WSS |
| `speech.region` / `endpoint` / `voice` / `style` / `rate` / `pitch` / `volume` / `format` | `""` / `""` / `zh-CN-XiaoxiaoNeural` / `""` / `0%` / `0%` / `100` / `audio-24khz-48kbitrate-mono-mp3` | Azure 语音（密钥在 `secrets/azure_speech_key`） |

这些配置项都能在控制台（手机 App 或网页版）里修改，不需要手动编辑文件。

## 环境变量

| 变量 | 说明 |
|---|---|
| `QUETZAL_HOME` | 家目录 |
| `QUETZAL_ADAPTER` | 身体适配器模块路径 |
| `QUETZAL_CONSOLE_ACTIVITY` | （Termux 适配器）通知按钮打开的界面，默认 `xyz.quetzal.console/.MainActivity` |
| `QUETZAL_HIDE_PATHS` | proot 沙箱额外遮住的目录（冒号分隔）；App 内置时由 App 设为它自己的私有数据目录 |

## 安卓部署约定（Quetzal App 内置）

App 的前台服务（`RuntimeService`）按下面的约定工作，`<数据>` 指 `/data/data/xyz.quetzal.console`：

```
<数据>/files/usr/                 运行环境前缀：共享库、证书、git 模板、网状层原生组件（lib/quetzal/node_modules）；
                                  bin/node、bin/git、bin/ssh、bin/ssh-keygen、bin/proot 等是指向 APK 原生库目录里 lib*.so 的链接
<数据>/files/runtime/<版本>/      main.cjs、android.mjs（来自 App 内置资源，只留当前版本）
<数据>/files/home/                HOME（agent 的命令默认在这里运行）
<数据>/files/home/quetzal/        QUETZAL_HOME
```

- App 版本或原生库目录变了（升级）时，重新解开运行环境，家目录保持原样。
- 环境变量：`PREFIX`、`QUETZAL_HOME`、`QUETZAL_ADAPTER`（`android.mjs`）、`SSL_CERT_FILE`、`GIT_EXEC_PATH`、`PROOT_LOADER`、`QUETZAL_HIDE_PATHS`（`shared_prefs`、`app_flutter`、`databases`、`cache`、`code_cache`）。
- 第一次启动时写入身体名字（机型，小写）与时区，之后由控制台管理。
- 守护：进程退出后按退避间隔（2 秒起，最长 1 分钟）重新拉起；开机（`BOOT_COMPLETED`）与 App 升级后（`MY_PACKAGE_REPLACED`）自动启动，厂商系统要放行「自启动」才收得到这两个广播。

### 旧的 Termux 安装

1.0.x 时按 Termux 方式装的身体仍能运行（`runtime/adapters/termux/` 保留），新安装不再使用这种方式：

```
~/quetzal/releases/<版本>/        main.cjs、termux.mjs
~/quetzal/current → releases/…    运行中的版本
$PREFIX/var/service/quetzal/run   runit 服务：QUETZAL_ADAPTER=$HOME/quetzal/current/termux.mjs
$PREFIX/var/log/sv/quetzal/       日志
~/.termux/boot/quetzal            开机脚本：termux-wake-lock + 启动 runit
```

## Linux / npm 部署约定

npm 包 `@plutokeating/quetzal`（`npx @plutokeating/quetzal`）按下面的约定工作，目录结构与旧的 Termux 安装相同。Linux 的家目录缺省为 `~/.quetzal`，可用 `QUETZAL_HOME` 或 `--home` 修改；0.6.7 之前装在 `~/quetzal` 的，再跑一次安装会自动把整个目录搬过来。一键安装脚本（`curl -fsSL https://quetzal.plutokeating.beer/install | bash`）在此之上再加几样：

```
~/.quetzal/releases/<版本>/              main.cjs、linux.mjs、web/（网页控制台，网关托管 current/web/）
~/.quetzal/current → releases/…          运行中的版本
~/.quetzal/previous → releases/…         上一版（回退用）
~/.config/systemd/user/quetzal.service  systemd 用户服务：QUETZAL_HOME、QUETZAL_ADAPTER=~/.quetzal/current/linux.mjs，Restart=always
journalctl --user -u quetzal            日志（quetzal logs）

一键安装脚本另有：
~/.quetzal/npm/                          npm 包 @plutokeating/quetzal 的独立前缀（lib/node_modules/…/dist/quetzal.mjs）
~/.quetzal/install.log                   安装日志
~/.local/bin/quetzal                    命令：固定用安装时的 node 跑上面的 quetzal.mjs
~/.quetzal/console/<版本>/、console/current → …   原生控制台（Flutter Linux 桌面版，可执行文件 quetzal-console；从 GitHub Release 下载）
~/.local/bin/quetzal-console            启动器：有原生控制台就启动它，否则 Chromium 系浏览器以独立窗口（--app，资料目录 ~/.quetzal/state/console-browser）打开
~/.local/share/applications/xyz.quetzal.console.desktop、~/.local/share/icons/hicolor/{512x512,192x192}/apps/xyz.quetzal.console.png   应用列表项与图标
~/.config/systemd/user/quetzal.service.d/quetzal-off.conf   守护开关关闭时写入（Restart=no）
没有 systemd 时：~/.quetzal/bin/quetzal-supervise（守护循环）、~/.quetzal/state/supervise.{pid,lock}、~/.quetzal/logs/runtime.log、crontab @reboot、~/.config/autostart/quetzal-runtime.desktop
```

要求 Node.js 22.13+。只保留最近 3 个版本。健康检查 40 秒不通过（或 `/health` 的版本不符）时自动切回 `previous`。`--lan` 把 `config/quetzal.json` 的 `gateway.host` 写为 `0.0.0.0`、`gateway.lan` 写为 `true`（局域网上走 HTTPS，端口 7789；`quetzal status` 打印地址与证书指纹）。装完在浏览器里打开 `http://127.0.0.1:7788/`（`npx @plutokeating/quetzal open`），同一台机器免配对码。

## Windows 部署约定

Windows 上，一行 `install.ps1` 与安装包 `quetzal-<版本>-windows-<x64|arm64>-setup.exe` 都把文件装进 `%LOCALAPPDATA%\Quetzal`，用指针文件代替符号链接：

```
%LOCALAPPDATA%\Quetzal\
├── home\                 QUETZAL_HOME
├── runtime\<版本>\        main.cjs、windows.mjs、windows-body.mjs、windows-supervise.mjs、web\ 等
├── runtime\current.txt    正在用的版本；previous.txt 指向上一版
├── console\<版本>\        控制台 quetzal-console.exe；console\current.txt 同上
├── bin\                  命令行 quetzal.cmd 与计划任务的启动器
└── node.txt              运行基座用的 node.exe 的位置
```

- 守护：计划任务 `\Quetzal\Runtime-Boot`（开机，不用登录）与 `\Quetzal\Runtime-Logon`（登录时）经 `bin\quetzal-supervise.ps1` 运行守护进程 `windows-supervise.mjs`，退出后退避重启；`home\state\supervise.off` 暂停拉起。
- 日志：`home\logs\runtime.log`（`quetzal logs`），升级日志 `home\logs\upgrade.log`。
- `home\secrets\desktop-body.json`：身体助手的端口与令牌。
- 升级 40 秒健康检查不通过时，把指针退回上一版。

安装、沙箱与命令行见 [Windows](/docs/advanced/windows)。
