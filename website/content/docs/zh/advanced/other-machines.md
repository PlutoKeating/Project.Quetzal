---
title: Linux 与其他机器
description: 一台 Linux 电脑或服务器一行 curl 命令就能成为身体：自动补齐依赖、注册开机自启与崩溃重启的服务、应用列表里多一个 Quetzal，装完在浏览器里打开网页控制台；其他能跑 Node.js 22.13+ 与 git 的机器也可以手动部署。
---

## 适用场景

手机是最合适的身体；一台笔记本、家里的小主机、树莓派、云服务器也都能跑运行基座。Linux 机器有现成的一键安装；别的系统按第 4 节手动部署。

## 1. Linux：一行命令

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

前提只有两个：Linux，以及 `curl`（或 `wget`）与 bash 4+。其余缺什么它补什么。架构：x86_64 与 arm64 全功能（含原生控制台）；龙芯（loongarch64）、RISC-V、armv6l 这些官方 Node 不出二进制的架构，脚本从 Node.js 项目的 [unofficial-builds](https://unofficial-builds.nodejs.org) 直接下载对应的 Node 22 到 `~/.quetzal/node/`（先与同一发布目录里的 `SHASUMS256.txt` 核对 SHA-256，那里没有 GPG 签名），运行基座与网页控制台照常可用，只是没有原生控制台（Flutter 上游尚不支持 LoongArch），桌面项用浏览器打开。装完之后：

- 浏览器里打开了**网页控制台** `http://127.0.0.1:7788/`，同一台机器免配对码，模型、身份、授权、飞书、灵魂仓库、对话都在里面（第 2 节）。
- 应用列表里多了一个 **Quetzal**（光团图标），点开是**原生控制台**（Flutter Linux 桌面版，从 GitHub Release 下载同版本的包放在 `~/.quetzal/console/`），任务栏、Alt-Tab、活动概览都是 Quetzal 自己的图标，与浏览器无关。这个版本没有原生包（arm64、旧版本）或下载失败时退回浏览器打开：Chromium 系以独立窗口打开，只有 Firefox 时用默认浏览器，此时任务栏显示的是浏览器的图标。
- 终端里多了 `quetzal` 命令（`~/.local/bin/quetzal`，新开的终端生效）：`quetzal status` / `logs -f` / `open` / `rollback` / `uninstall`。
- 它在开机时自己起来，崩溃或被杀后 3 秒内自己回来；再跑一次同一条命令就是升级。

安装器一步一步做了什么（幂等）：

| 步骤 | 做什么 |
|---|---|
| 这台机器 | 认出发行版、架构、包管理器（apt / dnf / yum / pacman / zypper / apk / xbps）、有没有 systemd 用户实例、有没有桌面、是不是 WSL / 容器 |
| 依赖 | 缺 `git`、`curl`、`tar`、CA 证书就用这台机器自己的包管理器装（需要时 `sudo` / `doas` 会问一次密码，root 直接装）。**Node.js 22.13+**：PATH 上已有够新的（且带 npm）就用；否则装 [nvm](https://github.com/nvm-sh/nvm) 到 `~/.nvm` 并装 Node.js 22（不碰系统的 Node；nvm 的安装脚本先下载成文件，与脚本里固定的 SHA-256 核对一致才执行，两个下载地址内容相同）；Alpine 这类 musl 系统与 NixOS 跑不了 nvm 的官方二进制，Alpine 用 `apk add nodejs npm`，NixOS 请先自备 Node。直连 nodejs.org 不通时自动改用国内镜像（npmmirror） |
| 运行基座 | 把 npm 包 `@plutokeating/quetzal` 装进 `~/.quetzal/npm`（独立前缀，不污染全局 npm），由它完成版本目录、缺省配置、systemd 服务、健康检查与失败回滚（见 1.1） |
| 守护 | 有 systemd 用户实例：`systemd --user` 服务 `quetzal`，`Restart=always`，并 `loginctl enable-linger`（没登录也运行；需要管理员权限时会问一次密码）。没有（Alpine / Void / Devuan、容器、未开 systemd 的 WSL）：写一个几十行的守护循环 `~/.quetzal/bin/quetzal-supervise`（退出 3 秒后重启，flock 保证只有一个），开机靠 `crontab @reboot` 与桌面自启动项，不安装任何额外的服务框架 |
| 桌面 | 有桌面环境才做：下载同版本的原生控制台到 `~/.quetzal/console/<版本>/`（先核对发布签名：`SHA256SUMS.sig` 是内置公钥的 Ed25519 签名、`commit <提交> v<版本>` 一行与要装的版本一致、包的 SHA-256 与清单相符，任何一项不通过就不装，退回浏览器；没有签名清单的旧版本同样退回浏览器，见 [发布签名与校验](/docs/start/install#发布签名与校验)。`console/current` 指向它；依赖检查只用只读的 `readelf -d/-V` 或 `objdump -p` 看所需的库与 glibc 版本，不执行下载的程序，两者都没有就跳过检查；旧发行版缺库就放弃，退回浏览器；musl 系统不装原生控制台），图标放进 `~/.local/share/icons/hicolor/`（`xyz.quetzal.console.png`），启动器 `~/.local/bin/quetzal-console`（优先原生，否则浏览器），桌面项 `~/.local/share/applications/xyz.quetzal.console.desktop` |
| 收尾 | 有图形会话就打开控制台；打印地址、守护方式与常用命令。服务器上会给出 `ssh -L 7788:127.0.0.1:7788 <这台机器>` |

选项跟在 `bash -s --` 后面，也都有对应的环境变量：

| 选项 | 环境变量 | 作用 |
|---|---|---|
| `--lan` | `QUETZAL_LAN=1` | 网关对局域网开放，手机上的 App 直接填这台机器的地址连接（只在可信的局域网里） |
| `--no-open` | `QUETZAL_NO_OPEN=1` | 装完不打开浏览器 |
| `--no-desktop` | `QUETZAL_NO_DESKTOP=1` | 不写应用列表的快捷方式 |
| `--home DIR` | `QUETZAL_HOME=DIR` | 家目录（默认 `~/.quetzal`；0.6.7 之前装在 `~/quetzal` 的，再跑一次安装会自动整目录搬到 `~/.quetzal`，配置、记忆、对话原样保留） |
| `--version X.Y.Z` | `QUETZAL_VERSION=X.Y.Z` | 装指定版本（默认 latest） |
| `--cn` / `--no-cn` | `QUETZAL_MIRROR=cn` / `off` | 强制用 / 不用中国大陆镜像（默认自动探测） |
| `--lang zh` / `en` | `QUETZAL_LANG=zh` / `en` | 界面语言（默认看系统语言：简体 / 繁体中文显示中文，其余英文） |
| `--uninstall [--purge]` | — | 卸载服务、守护循环、快捷方式与 npm 包；`--purge` 连 `~/.quetzal`（配置、记忆、对话）一起删。nvm、Node.js、git 不动 |

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --lan        # 带选项
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall  # 卸载
```

脚本的源码在仓库的 [`cli/install.sh`](https://github.com/PlutoKeating/Project.Quetzal/blob/main/cli/install.sh)，官网构建时原样复制到 `/install`；也可以从 `https://raw.githubusercontent.com/PlutoKeating/Project.Quetzal/main/cli/install.sh` 取。安装日志在 `~/.quetzal/install.log`。

> [!NOTE]
> 服务用安装时选定的那个 Node 的绝对路径（nvm 装的在 `~/.nvm/versions/node/v22.x/bin/node`），所以之后 `nvm uninstall 22` 会让服务起不来，再跑一次安装命令即可修复。没有 systemd 的机器上 `quetzal stop` / `logs` 这两个子命令不可用：停止用 `kill $(cat ~/.quetzal/state/supervise.pid)`，日志在 `~/.quetzal/logs/runtime.log`。

### 1.1 只要 npm 包：`npx @plutokeating/quetzal`

已经有 Node.js 22.13+（内置 `node:sqlite` 从这个版本起不需要标志）与 git、也不需要桌面快捷方式时，可以只用 npm 包；一键安装脚本内部调用的也是它。

```bash
npx @plutokeating/quetzal            # 安装：运行基座、Linux 身体适配器与网页控制台放进 ~/.quetzal，注册 systemd 用户服务并启动，然后在浏览器里打开控制台
npx @plutokeating/quetzal open       # 再次打开网页控制台 http://127.0.0.1:7788/
npx @plutokeating/quetzal --lan      # 让网关对局域网开放，手机上的 App 也能直接填这台机器的地址连接（只在可信的局域网里）
```

它做了什么：把包里内置的 `main.cjs`、`linux.mjs` 与网页控制台 `web/` 放进 `~/.quetzal/releases/<版本>/`，`current` 指向它（与手机上的目录约定相同）；写 `~/.config/systemd/user/quetzal.service`（退出即重启），启动并等 `/health`；40 秒内没有响应就切回上一版。第一次装好、有桌面时自动打开浏览器（`--no-open` 不打开）。再运行一次 `npx @plutokeating/quetzal` 就是升级。

常用命令（一键安装之后，`npx @plutokeating/quetzal` 可以换成 `quetzal`）：

| 命令 | 作用 |
|---|---|
| `npx @plutokeating/quetzal status` | 版本、服务、健康、网关与网页控制台地址 |
| `npx @plutokeating/quetzal open` | 在浏览器里打开网页控制台 |
| `npx @plutokeating/quetzal logs -f` | 服务日志（journald） |
| `npx @plutokeating/quetzal rollback` | 切回上一版并重启 |
| `npx @plutokeating/quetzal stop` / `start` / `restart` | 服务控制 |
| `npx @plutokeating/quetzal uninstall [--purge]` | 移除服务；`--purge` 连 `~/.quetzal`（配置、记忆、对话）一起删 |
| `npx @plutokeating/quetzal run` | 没有 systemd 用户实例的环境（容器、未开 systemd 的 WSL）：前台运行，交给你自己的守护者 |

> [!NOTE]
> 服务用安装时运行 npx 的那个 Node，所以 nvm 之类装的 Node 也行；服务不依赖 npx 缓存。没有登录会话时也要运行（服务器）需要 `loginctl enable-linger`，安装器会尝试，失败会提示你用 sudo 执行一次。

### 这具身体能感知什么

Linux 适配器一切靠探测：笔记本有电量与充电状态，CPU 温度进 extra；有桌面时能弹通知、放声音、截图、看剪贴板、打开网址；有摄像头与麦克风就能拍照、录音。没有图形界面的服务器上这些工具会直接说明，不报错。细节见 [适配器接口](/docs/reference/adapter-interface)。

## 2. 网页控制台：装好就能用，不需要手机

打开 `http://127.0.0.1:7788/`。这就是 Quetzal App 的网页版，同一份界面为电脑横屏重新排布：左边导航（对话 / 心流 / 记忆 / 控制）与这一区的列表，中间是正在看的内容，右边永远是 ta 此刻的样子（光团、ta 想分享的一句话、正在进行的醒来、待你批准的请求、内在与身体）。模型、身份、授权、飞书、灵魂仓库与对话都在这里完成，和 App 完全一致。

- **免配对码**：同一台机器上的浏览器打开即登录（网关只对回环地址、Host 为本机名的请求放行，见 [网关 API](/docs/reference/gateway-api)）。
- **没有桌面的服务器**：`ssh -L 7788:127.0.0.1:7788 <服务器>` 转发端口后，在本机浏览器打开同样的地址；隧道过来的连接对网关来说也是本机。
- **地址栏记录位置**（`#/chat/<会话>`、`#/control/providers`……），可收藏、可前进后退。
- 网页版没有麦克风与安装器：听觉在手机 App 上；升级在这台机器上再跑一次安装命令（或 `npx @plutokeating/quetzal`）。

## 3. 用手机上的 App 连接 Linux 机器（可选）

- 装的时候加了 `--lan`：在 App 里 **连接新的 agent** → 填 `http://<这台机器的地址>:7788` → **申请配对码**。
- 没有加：网关只监听 `127.0.0.1`，先转发端口（手机经 USB 连着这台机器时 `adb reverse tcp:7788 tcp:7788`，或一条 ssh 隧道），再在 App 里填 `http://127.0.0.1:7788`。随时可以 `npx @plutokeating/quetzal --lan` 改成开放。

配对码在这台机器上弹桌面通知，同时写进服务日志；没有桌面的服务器从 `quetzal logs` 里看。

## 4. 其他机器：手动部署

任何能跑 Node.js 22.13+ 与 git 的机器都能成为身体。

```bash
git clone https://github.com/PlutoKeating/Project.Quetzal.git
cd Project.Quetzal/runtime
npm ci
npm test            # 单元测试
npm run build       # 生成 dist/main.cjs（单文件，已内置依赖）、dist/termux.mjs 与 dist/linux.mjs
QUETZAL_HOME=~/.quetzal node --enable-source-maps dist/main.cjs
```

环境变量：

| 变量 | 说明 |
|---|---|
| `QUETZAL_HOME` | 家目录（默认 `~/.quetzal`），配置、密钥、数据、灵魂目录都在这里 |
| `QUETZAL_ADAPTER` | 身体适配器模块路径；不设则用通用适配器（只有操作系统信息，没有传感器） |

基座只负责自身逻辑，**进程守护交给外部**：退出即重启。systemd 用户服务示例：

```ini
[Unit]
Description=Quetzal runtime

[Service]
Environment=QUETZAL_HOME=%h/quetzal
Environment=QUETZAL_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/quetzal/main.cjs
Restart=always

[Install]
WantedBy=default.target
```

> [!NOTE]
> 10 分钟内被拉起超过 5 次，基座会进入安全模式（只开网关与飞书，不醒来），防止反复崩溃烧钱。

连接方式与第 3 节相同（手动部署没有网页控制台，除非把控制台的 Web 构建放到 `main.cjs` 旁边的 `web/` 或用 `QUETZAL_WEB_DIR` 指定）；要对局域网开放，在 `config/quetzal.json` 里把 `gateway.host` 设为 `0.0.0.0`。**没有 `notify` 的适配器**（比如通用适配器）收不到配对码通知，这时部署者从 `QUETZAL_HOME/secrets/gateway.token` 读出令牌填入即可。

通用适配器没有传感器。给这台机器写一个适配器（几十行），ta 就能感知这具身体，或者获得设备动作工具。见 [自定义身体适配器](/docs/advanced/custom-adapter)。

## 开发模式

```bash
cd runtime && npm run dev     # 以 ./.dev 为家目录直接运行 TypeScript 源码
cd cli && npm run build && node dist/quetzal.mjs status --home /tmp/w   # 构建 npm 包并用独立家目录试装
```
