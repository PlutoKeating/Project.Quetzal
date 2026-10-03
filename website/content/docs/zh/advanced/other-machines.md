---
title: 部署到其他机器
description: 任何能跑 Node.js 22+ 与 git 的机器都能成为身体——构建、运行、交给进程守护者，再用 App 配对连接。
---

## 适用场景

手机是最合适的身体，但不是唯一的。一台树莓派、一台家里的小主机、一台云服务器，都能跑运行基座。本页面向**部署者**，会用到命令行。

## 1. 构建

```bash
git clone https://github.com/PlutoKeating/Project.Windler.git
cd Project.Windler/runtime
npm ci
npm test            # 单元测试
npm run build       # 生成 dist/main.cjs（单文件，已内置依赖）与 dist/termux.mjs
```

运行基座是**单文件** `main.cjs`，没有原生依赖（存储用 Node 内置的 `node:sqlite`）。

## 2. 运行

```bash
WINDLER_HOME=~/windler node --enable-source-maps dist/main.cjs
```

环境变量：

| 变量 | 说明 |
|---|---|
| `WINDLER_HOME` | 家目录（默认 `~/windler`），配置、密钥、数据、灵魂目录都在这里 |
| `WINDLER_ADAPTER` | 身体适配器模块路径；不设则用通用适配器（只有操作系统信息，没有传感器） |

## 3. 交给进程守护者

基座只负责自身逻辑，**进程守护交给外部**：退出即重启。systemd 用户服务示例：

```ini
[Unit]
Description=Windler runtime

[Service]
Environment=WINDLER_HOME=%h/windler
Environment=WINDLER_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/windler/main.cjs
Restart=always

[Install]
WantedBy=default.target
```

> [!NOTE]
> 10 分钟内被拉起超过 5 次，基座会进入安全模式（只开网关与飞书，不醒来），防止反复崩溃烧钱。

## 4. 用 App 连接

网关只监听 `127.0.0.1:7788`。要让手机上的 App 连上另一台机器的基座，先把端口转发到手机：

- 手机经 USB 连着那台机器时：`adb reverse tcp:7788 tcp:7788`；
- 或建立一条 ssh 隧道。

然后在 App 里 **连接新的 agent** → 填网关地址 → **申请配对码**。配对码通过适配器的系统通知下发；**没有 `notify` 的适配器**（比如通用适配器）收不到通知，这时部署者从 `WINDLER_HOME/secrets/gateway.token` 读出令牌填入即可。

## 5. 身体适配器

通用适配器没有传感器。给这台机器写一个适配器（几十行），她就能感知这具身体的电量、光线、运动，或者获得设备动作工具。见 [自定义身体适配器](/docs/advanced/custom-adapter)。

## 开发模式

```bash
cd runtime && npm run dev     # 以 ./.dev 为家目录直接运行 TypeScript 源码
```
