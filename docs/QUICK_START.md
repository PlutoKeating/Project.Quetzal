# 快速开始

## 1. 在一台安卓手机上安装（使用者）

一台闲置的安卓手机（Android 7 以上，arm64）就够了。

1. **装 Termux 三件套**：从 [F-Droid](https://f-droid.org/packages/com.termux/)（或 Termux 的 GitHub 发布页）安装 **Termux**、**Termux:API**、**Termux:Boot**，三个必须来自同一来源；Google Play 上的版本已废弃。打开 Termux 一次，等它初始化完成。
2. **装 Quetzal App**：从本仓库的发布页下载 APK 安装（或按第 3 节自己构建）。
3. **打开 Quetzal**：首页选「在这台手机上安装 Quetzal」，按向导走：
   - 授权「在 Termux 中运行命令」（系统弹窗）；
   - **唯一需要你动手的一步**：点「复制并打开 Termux」，在 Termux 里长按 → 粘贴 → 回车，执行那一行（开启 `allow-external-apps`，Termux 的安全设计不允许别的应用代劳）；
   - 点「安装」：向导自动安装 Node.js、runit、Termux:API 命令与 git，放入运行基座，注册服务与开机自启，启动并自检（几分钟、几十 MB 下载）。装完控制台自动连接，不需要配对码。
   - 最后按提示把 Termux 系列与 Quetzal 加入电池优化的忽略名单，并在厂商的自启动管理里放行；有锁屏密码的手机，重启后要解锁一次她才会醒来。
4. 之后的一切都在 App 里完成，见第 2 节。**升级**：App 自己会发现 GitHub 上的新正式版并在顶部提示，**控制 → 服务 → Quetzal App →「下载并安装」**一键完成（首次要在系统设置里允许 Quetzal 安装应用）；装好的新 App 打开后自动进向导把运行基座也升到新版（控制 → 服务 →「升级 / 重装」也可以），失败自动回退。

## 2. 之后的一切都在控制台里完成（手机上是 Quetzal App，Linux 机器上是网页控制台，同一份界面）

1. **配置模型**：控制 → 模型 → 添加供应商（从目录选择或自定义）→ 添加 Key → 勾选模型 → 保存 → 测试连通 → 在「全局模型顺序」里拖动排序，可把一个便宜的模型设为「内省」模型。配置好之后，她就会按自己的节律开始醒来。
2. **身份**：控制 → 身份，给 agent 起名字、选主题色（写入它的灵魂仓库，所有身体同步）。没有灵魂仓库时，身份与人格先存在本机的灵魂目录里。
3. **能力授权**：控制 → 能力授权。相机、麦克风、定位、操作屏幕默认「每次询问」，她想用时会发审批给你；放心了就改成「允许」。
4. **接入飞书（可选）**：控制 → 飞书 →「开始」→ 在飞书中打开并确认。机器人自动创建并绑定你本人；在飞书里打开与机器人（以 agent 的显示名命名）的单聊，会收到「此刻」卡片，之后所有操作都通过卡片按钮完成。
5. **共享灵魂（可选）**：在 GitHub 网页创建一个**私有**仓库 → 控制 → 灵魂同步 →「显示公钥」并把它添加到仓库的 Deploy keys（允许写入）→ 填入仓库地址并「接入」。之后同步全自动。
6. **让 Hermes / OpenClaw 也住进来（可选）**：灵魂同步页第 3 步有一句现成的话，复制发给那台机器上的 Hermes 或 OpenClaw，它会自己安装 soul-bridge；需要你做的只有在 GitHub 网页添加一次它给出的部署公钥。
7. **听觉（可选）**：控制 → 语音 填好 Azure 语音的密钥与区域后，控制 → 听觉 → 授予麦克风权限 → 开启。之后这台手机常驻用麦克风听（通知栏有「Quetzal 在听」），听到的话以「环境声音」进入会话，她自己判断是不是对她说的、要不要回应；她也可能用声音回答你。
8. **多个 agent**：点顶栏的名字 →「连接新的 agent」，填入另一个运行基座的网关地址，申请配对码（通过那台设备的系统通知下发）并配对，之后一键切换。

## 3. 在一台 Linux 电脑或服务器上安装（使用者）

笔记本、小主机、树莓派、云主机都行。一行命令，缺什么补什么：

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash                   # 依赖（git、经 nvm 的 Node.js 22）→ npm 包 → 守护（systemd 用户服务，没有 systemd 用自带守护循环 + crontab @reboot）→ 应用列表里的「Quetzal」→ 打开控制台
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --lan       # 选项：--lan --no-open --no-desktop --home DIR --version X --cn|--no-cn --lang zh|en
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall # 卸载（--purge 连家目录）
```

装完终端里有 `quetzal` 命令（`status` / `logs -f` / `open` / `rollback`）。脚本是 `cli/install.sh`，官网构建时复制为 `/install`。已经有 Node.js 22.13+（内置 `node:sqlite`）与 git、只想要 npm 包本身时：

```bash
npx @plutokeating/quetzal            # 安装：内置的运行基座、Linux 身体适配器与网页控制台放进 ~/quetzal，注册 systemd 用户服务并启动，健康检查失败自动切回上一版；有桌面时顺手打开浏览器
npx @plutokeating/quetzal open       # 再次打开网页控制台 http://127.0.0.1:7788/
npx @plutokeating/quetzal --lan      # 让网关对局域网开放：手机上的 Quetzal App 也能直接填这台机器的地址连接（只在可信的局域网里）
npx @plutokeating/quetzal status     # 版本、服务、健康、网页控制台地址；logs -f 看日志；rollback 回滚；uninstall [--purge] 卸载
```

装好之后的一切（第 2 节的全部配置，以及对话）都在**网页控制台**里完成：这台机器上的浏览器打开 `http://127.0.0.1:7788/` 即登录，不需要配对码也不需要手机。它就是 Quetzal App 的网页版，为电脑横屏重新排布（导航栏 · 列表栏 · 主区 · 她此刻），功能与 App 一致；地址栏的 `#/…` 记录位置，可收藏。再运行一次 `npx @plutokeating/quetzal` 就是升级。没有桌面的服务器：`ssh -L 7788:127.0.0.1:7788 <服务器>` 转发端口后在本机浏览器打开同样的地址（同一台机器的判定看连接来源，隧道算本机）。手机上的 App 也可以连这台机器：**连接新的 agent** → 填 `http://<这台机器的地址>:7788` → **申请配对码**（配对码弹桌面通知，没有桌面的从 `npx @plutokeating/quetzal logs` 里看）。没有 systemd 用户实例的环境（容器、未开 systemd 的 WSL）用 `npx @plutokeating/quetzal run` 前台运行，交给自己的守护者。npm 包的实现在 [`cli/`](../cli/docs/README.md)。

## 4. 部署到其他机器（部署者）

任何能跑 Node.js 22.13+ 与 git 的机器都能成为身体。

```bash
cd runtime
npm ci
npm test          # 单元测试
npm run build     # 生成 dist/main.cjs（单文件，已内置依赖）、dist/termux.mjs（安卓 / Termux 身体适配器）与 dist/linux.mjs（Linux 身体适配器）
QUETZAL_HOME=~/quetzal node --enable-source-maps dist/main.cjs
```

生产环境请交给进程守护者（runit、systemd……），退出即重启。示例（systemd 用户服务）：

```ini
[Service]
Environment=QUETZAL_HOME=%h/quetzal
Environment=QUETZAL_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/quetzal/main.cjs
Restart=always
```

控制台连接这样的机器：把控制台的 Web 构建（`console/tool/build-web.sh` → `build/web`）放到 `main.cjs` 旁边的 `web/` 或用 `QUETZAL_WEB_DIR` 指定，网关就托管网页控制台，这台机器的浏览器打开即登录；或者把网关端口转发到控制台所在设备（例如 `adb reverse` 或 ssh 隧道），或在 `config/quetzal.json` 里把 `gateway.host` 设为 `0.0.0.0`，在 App 里填网关地址并用配对码配对。配对码通过适配器的系统通知下发，没有 `notify` 的适配器需要部署者从 `QUETZAL_HOME/secrets/gateway.token` 读出令牌填入。

构建 Quetzal App：

```bash
cd console
tool/bundle-runtime.sh                     # 构建 runtime 并把 main.cjs、termux.mjs 内置进 App
flutter build apk --release --target-platform android-arm64
```

正式签名把密钥信息放在 `console/android/key.properties`（不入库，见 `build.gradle.kts`），没有时用 debug 签名。

## 5. 开发

```bash
cd runtime && npm run dev      # 以 ./.dev 为家目录直接运行 TypeScript
cd console && flutter run      # 连接设备调试控制台
cd cli && npm run build && node dist/quetzal.mjs status --home /tmp/w   # 构建 npm 包并用独立家目录试装
```
