---
title: macOS
description: 一台 Mac（macOS 12 起，Intel 或 Apple 芯片）也能成为身体：终端里一行命令，登录后由 launchd 一直守着。ta 的命令在系统自带的沙箱里运行，看不到密钥；给了辅助功能与屏幕录制权限后，ta 还能看屏幕、点击和输入。
---

## 1. 装上

要求：macOS 12 以上，Intel 或 Apple 芯片。在「终端」里运行（和 Linux 是同一条命令）：

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

它会：

- **补上 git**：git 在苹果的「Xcode 命令行工具」里。没装的话，系统会弹出安装对话框，点「安装」，装好后再运行一次同一条命令（不需要装 Xcode 本身）。
- **补上 Node.js**：没有 22.13 以上的 Node.js，就经 nvm 装进 `~/.nvm`，不碰系统里别的 Node。
- **装运行基座**：npm 包装进 `~/.quetzal/npm`，运行基座放进 `~/.quetzal/releases/<版本>/`，终端里多一个 `quetzal` 命令。
- **注册守护**：launchd 用户代理 `~/Library/LaunchAgents/xyz.quetzal.runtime.plist`。
- **打开控制台**：在浏览器里打开 `http://127.0.0.1:7788/`，这台 Mac 上的浏览器打开即登录。向导带你登录、配模型，步骤和手机上一样。

家目录和 Linux 一样是 `~/.quetzal`（配置、密钥、数据、灵魂目录），`--home DIR` 或环境变量 `QUETZAL_HOME` 可以改。选项与 Linux 相同：`--lan`、`--no-open`、`--version X`、`--lang zh|en` 等，写在 `bash -s --` 后面。

## 2. 它怎么一直在

- **登录后运行**：launchd 在你登录这台 Mac 后拉起运行基座；运行基座退出 3 秒后自动重启，10 分钟里反复退出就进安全模式。launchd 的用户代理跟着登录会话走：没有人登录图形界面时它不运行。想让 ta 开机就醒，在「系统设置 › 用户与群组」里打开自动登录。
- **控制台**：网关托管的网页版，功能与 App 相同。`quetzal open` 再次打开。Mac 上还没有原生的桌面控制台。
- **守护开关**：控制台「高级 · 运行」里的「守护」开关关掉后，运行基座退出就不再拉起，下次登录也不自启。
- **升级**：在控制台的「关于」里点一下，或再运行一次安装命令。新版本 40 秒内不健康就自动退回上一版。
- **命令**：`quetzal status`、`quetzal logs -f`（日志在 `~/.quetzal/logs/runtime.log`）、`quetzal start` / `stop` / `restart`、`quetzal rollback`。
- **卸载**：`curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall`。家目录默认保留，加 `--purge` 一起删除。nvm、Node.js、git 不动。

## 3. 让 ta 看屏幕、点击和输入

ta 操作屏幕用的是系统自带的能力：截图用 `screencapture`，读窗口里的按钮、文字和输入框用「System Events」的辅助功能接口，点击、拖拽、滚动和按键用系统的输入事件。装了开源的 `cliclick`（`brew install cliclick`）时，普通的点击交给它。

macOS 要求你在系统设置里亲手授权：

1. 打开「系统设置 › 隐私与安全性 › **辅助功能**」，点「+」，加入运行基座用的 node。安装器结束时会打印它的路径（例如 `~/.nvm/versions/node/v22.x/bin/node`）；在选择窗口里按 ⌘⇧G 粘贴这个路径。
2. 同一页的「**屏幕与系统录音**」（较早的系统叫「屏幕录制」）里也加入它。没有这项权限时，截图只拍得到桌面与菜单栏。
3. 运行 `quetzal restart`。
4. ta 第一次读窗口时，系统会问是否允许 node 控制「System Events」，点「允许」（之后可在「隐私与安全性 › 自动化」里改）。

没授权时，ta 会说明缺哪一项、去哪里开，并在这台 Mac 上替你打开那一页。操作屏幕默认交给审核模型：每次动作先由独立的审核模型判断，不打扰你；想亲自批准就把它改成「询问」，见 [操作屏幕](/docs/guide/screen) 与 [权限](/docs/guide/permissions)。

ta 只看得到主显示器。截图里的坐标就是 ta 点击用的坐标，Retina 屏的换算由 Quetzal 处理。

## 4. ta 能碰到什么

ta 的命令在 macOS 自带的沙箱（`sandbox-exec`）里运行，沙箱的规则由 [sandbox-runtime](https://github.com/anthropics/sandbox-runtime)（Anthropic 开源，Apache-2.0）为每条命令生成，不用另外安装：

| | 能做 | 不能做 |
|---|---|---|
| 文件 | 读写你的主目录（`~/.quetzal` 除外）与临时目录；读 `~/.quetzal` 里的配置、数据与灵魂目录，读保密库 | 看到密钥目录 `~/.quetzal/secrets`、浏览器的配置（各网站的登录状态）与钥匙串文件；改 `~/.quetzal`；改 shell 启动文件、`~/.ssh`、git 配置与 `~/Library/LaunchAgents`（在沙箱外运行的东西） |
| 网络 | 经运行基座里的代理访问公网与局域网 | 连这台 Mac 自己的端口（本机网关就在这里）；不认代理设置的程序（比如 `ssh`）连不出去 |
| 其他应用 | 无 | 用 AppleScript 控制别的应用（沙箱里发不出 Apple 事件） |

想让 ta 写别的文件夹（例如外接硬盘），在 `~/.quetzal/config/quetzal.json` 的 `sandbox.share` 里写上它的绝对路径，重启运行基座后生效。

每次启动后第一次用沙箱前，运行基座都实际验证一次：沙箱里读得到密钥目录、或写得进 `~/.quetzal`，就不用它。沙箱用不了时，ta 的命令一律不执行，控制台会提示原因。

> [!NOTE]
> 沙箱放行了系统的安全服务，钥匙串里设成「允许所有应用访问」的条目，ta 的命令读得到。`sandbox-exec` 被苹果标为弃用，但至今仍可用；哪天系统去掉了它，ta 的命令会停下并说明原因，而不是在沙箱外运行。

## 5. 多具身体

Mac 与其他身体之间的直连用和 Linux 一样的原生组件（Intel 与 Apple 芯片都有），安装时按锁定的校验值下载核对；装不上不影响使用，身体之间先只用 git 同步。见 [多具身体](/docs/guide/multi-body)。
