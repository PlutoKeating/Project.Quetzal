---
title: Linux 与其他机器
description: 一台 Linux 电脑或服务器一行命令 npx @plutokeating/quetzal 就能成为身体，装完在浏览器里打开网页控制台；其他能跑 Node.js 22.13+ 与 git 的机器也可以手动部署。
---

## 适用场景

手机是最合适的身体，但不是唯一的。一台笔记本、家里的小主机、树莓派、云服务器，都能跑运行基座。Linux 机器有现成的安装器；别的系统按第 3 节手动部署。

## 1. Linux：`npx @plutokeating/quetzal`

要求：Linux，Node.js 22.13+（内置 `node:sqlite` 从这个版本起不需要标志），git。

```bash
npx @plutokeating/quetzal            # 安装：运行基座、Linux 身体适配器与网页控制台放进 ~/quetzal，注册 systemd 用户服务并启动，然后在浏览器里打开控制台
npx @plutokeating/quetzal open       # 再次打开网页控制台 http://127.0.0.1:7788/
npx @plutokeating/quetzal --lan      # 让网关对局域网开放，手机上的 App 也能直接填这台机器的地址连接（只在可信的局域网里）
```

它做了什么：把包里内置的 `main.cjs`、`linux.mjs` 与网页控制台 `web/` 放进 `~/quetzal/releases/<版本>/`，`current` 指向它（与手机上的目录约定相同）；写 `~/.config/systemd/user/quetzal.service`（退出即重启），启动并等 `/health`；40 秒内没有响应就切回上一版。第一次装好、有桌面时自动打开浏览器（`--no-open` 不打开）。再运行一次 `npx @plutokeating/quetzal` 就是升级。

常用命令：

| 命令 | 作用 |
|---|---|
| `npx @plutokeating/quetzal status` | 版本、服务、健康、网关与网页控制台地址 |
| `npx @plutokeating/quetzal open` | 在浏览器里打开网页控制台 |
| `npx @plutokeating/quetzal logs -f` | 服务日志（journald） |
| `npx @plutokeating/quetzal rollback` | 切回上一版并重启 |
| `npx @plutokeating/quetzal stop` / `start` / `restart` | 服务控制 |
| `npx @plutokeating/quetzal uninstall [--purge]` | 移除服务；`--purge` 连 `~/quetzal`（配置、记忆、对话）一起删 |
| `npx @plutokeating/quetzal run` | 没有 systemd 用户实例的环境（容器、未开 systemd 的 WSL）：前台运行，交给你自己的守护者 |

> [!NOTE]
> 服务用安装时运行 npx 的那个 Node，所以 nvm 之类装的 Node 也行；服务不依赖 npx 缓存。没有登录会话时也要运行（服务器）需要 `loginctl enable-linger`，安装器会尝试，失败会提示你用 sudo 执行一次。

### 这具身体能感知什么

Linux 适配器一切靠探测：笔记本有电量与充电状态，CPU 温度进 extra；有桌面时能弹通知、放声音、截图、看剪贴板、打开网址；有摄像头与麦克风就能拍照、录音。没有图形界面的服务器上这些工具会直接说明，不报错。细节见 [适配器接口](/docs/reference/adapter-interface)。

## 2. 网页控制台：装好就能用，不需要手机

打开 `http://127.0.0.1:7788/`——这就是 Quetzal App 的网页版，同一份界面为电脑横屏重新排布：左边导航（对话 / 心流 / 记忆 / 控制）与这一区的列表，中间是正在看的内容，右边永远是 ta 此刻的样子（光团、ta 想分享的一句话、正在进行的醒来、待你批准的请求、内在与身体）。模型、身份、授权、飞书、灵魂仓库与对话都在这里完成，和 App 完全一致。

- **免配对码**：同一台机器上的浏览器打开即登录（网关只对回环地址、Host 为本机名的请求放行，见 [网关 API](/docs/reference/gateway-api)）。
- **没有桌面的服务器**：`ssh -L 7788:127.0.0.1:7788 <服务器>` 转发端口后，在本机浏览器打开同样的地址——隧道过来的连接对网关来说也是本机。
- **地址栏记录位置**（`#/chat/<会话>`、`#/control/providers`……），可收藏、可前进后退。
- 网页版没有麦克风与安装器：听觉在手机 App 上；升级在这台机器上再运行一次 `npx @plutokeating/quetzal`。

## 3. 用手机上的 App 连接 Linux 机器（可选）

- 装的时候加了 `--lan`：在 App 里 **连接新的 agent** → 填 `http://<这台机器的地址>:7788` → **申请配对码**。
- 没有加：网关只监听 `127.0.0.1`，先转发端口（手机经 USB 连着这台机器时 `adb reverse tcp:7788 tcp:7788`，或一条 ssh 隧道），再在 App 里填 `http://127.0.0.1:7788`。随时可以 `npx @plutokeating/quetzal --lan` 改成开放。

配对码在这台机器上弹桌面通知，同时写进服务日志；没有桌面的服务器从 `npx @plutokeating/quetzal logs` 里看。

## 4. 其他机器：手动部署

任何能跑 Node.js 22.13+ 与 git 的机器都能成为身体。

```bash
git clone https://github.com/PlutoKeating/Project.Quetzal.git
cd Project.Quetzal/runtime
npm ci
npm test            # 单元测试
npm run build       # 生成 dist/main.cjs（单文件，已内置依赖）、dist/termux.mjs 与 dist/linux.mjs
QUETZAL_HOME=~/quetzal node --enable-source-maps dist/main.cjs
```

环境变量：

| 变量 | 说明 |
|---|---|
| `QUETZAL_HOME` | 家目录（默认 `~/quetzal`），配置、密钥、数据、灵魂目录都在这里 |
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
