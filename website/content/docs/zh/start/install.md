---
title: 安装
description: 在一台闲置的安卓手机上装好 Termux 三件套与 Quetzal App，跟着向导把运行基座装进 Termux。
---

## 总览

安装分四步：装 Termux 三件套 → 装 Quetzal App → 在 App 的向导里安装运行基座 → 让系统不要杀掉它。整个过程几分钟，下载几十 MB。（装到 Linux 电脑或服务器上是另一条路：一行 `curl -fsSL https://quetzal.plutokeating.beer/install | bash`，见 [Linux 与其他机器](/docs/advanced/other-machines)。）

```mermaid
flowchart TB
  A["1. 装 Termux 三件套<br/>同一来源"] --> B["2. 装 Quetzal App<br/>下载页 / Releases"] --> C
  subgraph C["3. 跟着 App 向导走"]
    direction LR
    C1["授权向 Termux 发指令"] --> C2["在 Termux 粘贴一行<br/>开启外部调用"] --> C3["点「安装」<br/>其余自动完成"]
  end
  C --> D["4. 保活<br/>电池优化名单 + 自启动放行"] --> E(("ta 醒来了"))
```

## 1. 安装 Termux 三件套

三个应用都来自 F-Droid。下面是固定版本的直链，没有 F-Droid 客户端也能一次下完：

- **Termux** · 0.119.0-beta.3 · 110 MB

  运行基座所在的 Linux 环境。

  [下载 APK](https://f-droid.org/repo/com.termux_1022.apk) [F-Droid 页面](https://f-droid.org/packages/com.termux/)

- **Termux:API** · 0.53.0 · 3.9 MB

  电量、传感器、通知、相机、麦克风、定位、剪贴板；没有它 ta 感知不到身体。

  [下载 APK](https://f-droid.org/repo/com.termux.api_1002.apk) [F-Droid 页面](https://f-droid.org/packages/com.termux.api/)

- **Termux:Boot** · 0.8.1 · 26 KB

  开机自动启动；没有它重启后要手动点火。

  [下载 APK](https://f-droid.org/repo/com.termux.boot_1000.apk) [F-Droid 页面](https://f-droid.org/packages/com.termux.boot/)

> [!IMPORTANT]
> 三个必须来自**同一来源**（签名一致），否则它们之间无法通信。上面的直链与 F-Droid 页面是同一来源。Google Play 上的 Termux 已废弃，不要用。

装好后**打开 Termux 一次**，等它初始化完成（第一次打开会解压环境，需要几十秒）。

## 2. 安装 Quetzal App

从 [下载页](/download) 或 GitHub Releases 下载最新的 APK 并安装。首次安装可能需要允许「安装未知来源应用」。

## 3. 跟着向导安装运行基座

打开 Quetzal，首页选 **「在这台手机上安装 Quetzal」**，向导会依次带你完成：

1. **安装 Termux 三件套**：向导会检测三者是否已安装、版本是否匹配；没装的会给出链接。
2. **允许 Quetzal 向 Termux 发指令**：系统弹出「在 Termux 中运行命令」的权限请求，请允许。
3. **在 Termux 里开启外部调用（唯一需要你动手的一步）**：点「复制并打开 Termux」，在 Termux 里**长按 → 粘贴 → 回车**，执行那一行，然后回到 Quetzal 点「我已执行，检测」。这一行只做一件事：往 Termux 的配置里写入 `allow-external-apps=true`，让 Quetzal 之后能请 Termux 执行安装脚本。
4. **安装运行基座**：点「安装」。向导在 Termux 里自动完成：安装 Node.js、runit、Termux:API 命令行与 git；放入 App 内置的运行基座；注册 runit 服务、日志与开机脚本；写入身体名字与时区；启动并做健康检查。你会看到分步进度。装完后控制台**自动连接**，不需要配对码。

> [!NOTE]
> 中国大陆网络下载软件包慢时，向导会按系统语言自动选用大陆镜像源。安装过程中请让 Quetzal 保持在前台，因为运行基座的文件是从 App 里取的。

## 4. 让 ta 不被系统杀掉

安卓会清理后台应用。向导最后一步会引导你：

- 把 **Termux、Termux:Boot、Termux:API 和 Quetzal** 加入**电池优化的忽略名单**；
- 在厂商的「自启动 / 后台运行」管理里**放行**它们；
- **打开一次 Termux:Boot**，让系统登记它。

> [!WARNING]
> 有锁屏密码的手机：Android 的文件级加密要求**重启后解锁一次**，Termux 的数据才可用，ta 才会醒来。任何装在 Termux 里的程序都一样。

## 装好之后

打开 Quetzal 的「此刻」页，你会看到 ta 的状态与驱动力。在给 ta 配置模型之前 ta 不会醒来。接着看 [第一步](/docs/start/first-steps)。

**升级**：以后有新版时 App 会在顶部提示，**控制 → 服务 → Quetzal App →「下载并安装」**一键装好新 App，新 App 再把内置的运行基座升上去；详见 [升级与回退](/docs/guide/upgrade)。
