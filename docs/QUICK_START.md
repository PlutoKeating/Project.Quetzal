# 快速开始

## 1. 在一台安卓手机上安装（使用者）

一台闲置的安卓手机（Android 7 以上，arm64）就够了。

只装一个 App：运行基座和它的运行环境（Node.js、git、ssh、proot）都在 Quetzal App 里，不需要 Termux。

1. **装 Quetzal App**：从本仓库的发布页下载 APK 安装（或按第 4 节自己构建）。
2. **打开 Quetzal**：这台手机上还没有运行基座时直接进入向导，一次一步：
   - 安装：打开即开始，App 解开内置的运行环境、启动运行基座并核对网关，半分钟左右；装完控制台自动连接，不需要配对码。
   - 允许身体权限：相机、麦克风、定位（Android 13 以上还有通知），装好后自动弹出。
   - 后台运行：把 Quetzal 加入电池优化的忽略名单，并在厂商的自启动管理里放行（不放行时开机、App 升级后要打开一次 App 她才醒）；有锁屏密码的手机，重启后要解锁一次。
   - 登录（可跳过）：用 GitHub 登录，网页上批准；私有灵魂仓库自动建好、部署密钥自动加上。
   - 模型（可跳过）：点一个供应商、粘贴 Key、「接上」。
3. 之后的一切都在 App 里完成，见第 2 节。托付之前请读 [信任与边界](https://quetzal.plutokeating.beer/zh/docs/guide/trust)：数据经过谁、她能碰到什么、更新有多快。**升级**：App 自己会发现 GitHub 上的新正式版并在顶部提示，点横幅或**控制 → 关于 →「更新到 x」**一键完成（首次要在系统设置里允许 Quetzal 安装应用）；新 App 带着新版运行基座，打开后在后台自动换上，不用再点。
4. **从 Termux 版换过来**：先确认灵魂已推送到灵魂仓库，卸载旧的 Quetzal 与 Termux 三件套，装新 App；装好后先不要改身份，在「控制 → 设备」里用 GitHub 登录，选中原来的 agent，同一个灵魂仓库会自动接上。

## 2. 之后的一切都在控制台里完成（手机上是 Quetzal App，Linux 机器上是网页控制台，同一份界面）

第一次打开 App 会自动进入安装向导：安装 → 权限 → 后台运行 → 登录 → 模型，一次只做一步，登录可以跳过。完整的用户旅程见 [console/docs/USER_JOURNEY.md](../console/docs/USER_JOURNEY.md)。

1. **配置模型**：控制 → 模型（或首页的「选择模型」）→ 点一个供应商 → 粘贴 API Key →「接上」。运行基座自动挑最新的能调工具的模型、逐个试通、留两个排好；要手动加 Key、挑模型、排序、接自定义地址，点右上角「编辑」。配置好之后，她就会按自己的节律开始醒来。
2. **身份**：控制 → 顶部的名字，给 agent 起名字、选主题色（写入它的灵魂仓库，所有身体同步）。没有灵魂仓库时，身份与人格先存在本机的灵魂目录里。
3. **权限**：控制 → 权限。相机、麦克风、定位、操作屏幕默认「询问」，她想用时会出现在这一页顶部等你批准；放心了就改成「允许」。
4. **接入飞书（可选）**：控制 → 飞书 →「连接飞书」→ 在飞书中打开并确认。机器人自动创建并绑定你本人；在飞书里打开与机器人（以 agent 的显示名命名）的单聊，会收到「此刻」卡片，之后所有操作都通过卡片按钮完成。
5. **共享灵魂与多台设备（可选）**：控制 → 设备 →「用 GitHub 登录」，浏览器里批准即可：私有灵魂仓库自动建好、部署密钥自动加上，之后同步全自动。自己准备仓库的话在「控制 → 高级 → 同步」手动填写。
6. **让 Hermes / OpenClaw 也住进来（可选）**：「控制 → 高级 → 同步」最下面有一句现成的话，复制发给那台机器上的 Hermes 或 OpenClaw，它会自己安装 soul-bridge；需要你做的只有在 GitHub 网页添加一次它给出的部署公钥。
7. **声音（可选）**：控制 → 声音，填好 Azure 语音的密钥（区域自动找出），再打开「听你说话」并允许麦克风。之后这台手机常驻用麦克风听（通知栏有「Quetzal 在听」），听到的话以「环境声音」进入会话，她自己判断是不是对她说的、要不要回应；她也可能用声音回答你。
8. **多个 agent**：点顶栏的名字 →「连接另一个」，填入另一个运行基座的网关地址，申请配对码（通过那台设备的系统通知下发）并配对，之后一键切换。

## 3. 在一台 Linux 电脑或服务器上安装（使用者）

笔记本、小主机、树莓派、云主机都行。一行命令，缺什么补什么：

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash                   # 依赖（git、经 nvm 的 Node.js 22）→ npm 包 → 守护（systemd 用户服务，没有 systemd 用自带守护循环 + crontab @reboot）→ 应用列表里的「Quetzal」→ 打开控制台
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --lan       # 选项：--lan --no-open --no-desktop --home DIR --version X --cn|--no-cn --lang zh|en
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall # 卸载（--purge 连家目录）
```

装完终端里有 `quetzal` 命令（`status` / `logs -f` / `open` / `rollback`）。脚本是 `cli/install.sh`，官网构建时复制为 `/install`。已经有 Node.js 22.13+（内置 `node:sqlite`）与 git、只想要 npm 包本身时：

```bash
npx @plutokeating/quetzal            # 安装：内置的运行基座、Linux 身体适配器与网页控制台放进 ~/.quetzal（家目录，QUETZAL_HOME 可改），注册 systemd 用户服务并启动，健康检查失败自动切回上一版；有桌面时顺手打开浏览器
npx @plutokeating/quetzal open       # 再次打开网页控制台 http://127.0.0.1:7788/
npx @plutokeating/quetzal --lan      # 让网关对局域网开放（加密的 HTTPS / WSS，端口 7789，明文仍只在本机）：手机上的 Quetzal App 也能直接填这台机器的地址连接
npx @plutokeating/quetzal status     # 版本、服务、健康、网页控制台地址、局域网地址与证书指纹；logs -f 看日志；rollback 回滚；uninstall [--purge] 卸载
```

装好之后的一切（第 2 节的全部配置，以及对话）都在**网页控制台**里完成：这台机器上的浏览器打开 `http://127.0.0.1:7788/` 即登录，不需要配对码也不需要手机。它就是 Quetzal App 的网页版，为电脑横屏重新排布（导航栏 · 列表栏 · 主区 · 她此刻），功能与 App 一致；地址栏的 `#/…` 记录位置，可收藏。再运行一次 `npx @plutokeating/quetzal` 就是升级。没有桌面的服务器：`ssh -L 7788:127.0.0.1:7788 <服务器>` 转发端口后在本机浏览器打开同样的地址（同一台机器的判定看连接来源，隧道算本机）。手机上的 App 也可以连这台机器（先 `--lan` 开放）：**连接新的 agent** → 只填这台机器的地址（如 `192.168.1.8`，App 自动用加密连接 `https://…:7789`）→ 核对 App 显示的证书指纹与 `npx @plutokeating/quetzal status` 里的一致 → **申请配对码**（配对码连同证书指纹弹桌面通知，没有桌面的从 `npx @plutokeating/quetzal logs` 里看）。没有 systemd 用户实例的环境（容器、未开 systemd 的 WSL）用 `npx @plutokeating/quetzal run` 前台运行，交给自己的守护者。npm 包的实现在 [`cli/`](../cli/docs/README.md)。

## 4. 部署到其他机器（部署者）

任何能跑 Node.js 22.13+ 与 git 的机器都能成为身体。

```bash
cd runtime
npm ci
npm test          # 单元测试
npm run build     # 生成 dist/main.cjs（单文件，已内置依赖）与身体适配器 dist/android.mjs（Quetzal App 内置）、dist/linux.mjs（Linux）、dist/termux.mjs（旧的 Termux 安装）
QUETZAL_HOME=~/.quetzal node --enable-source-maps dist/main.cjs
```

生产环境请交给进程守护者（runit、systemd……），退出即重启。示例（systemd 用户服务）：

```ini
[Service]
Environment=QUETZAL_HOME=%h/quetzal
Environment=QUETZAL_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/quetzal/main.cjs
Restart=always
```

控制台连接这样的机器：把控制台的 Web 构建（`console/tool/build-web.sh` → `build/web`）放到 `main.cjs` 旁边的 `web/` 或用 `QUETZAL_WEB_DIR` 指定，网关就托管网页控制台，这台机器的浏览器打开即登录；或者把网关端口转发到控制台所在设备（例如 `adb reverse` 或 ssh 隧道），或在 `config/quetzal.json` 里把 `gateway.lan` 设为 `true`（局域网上开 HTTPS / WSS，端口 `gateway.lanPort`，默认 7789；明文只在本机回环），在 App 里填这台机器的地址、核对证书指纹，用配对码配对。配对码通过适配器的系统通知下发，没有 `notify` 的适配器需要部署者从 `QUETZAL_HOME/secrets/gateway.token` 读出令牌填入。

构建 Quetzal App：

```bash
cd console
tool/android-runtime/build-packages.sh     # Docker 里以 App 的前缀从源码编 Node.js、git、openssh、proot（第一次较久）
tool/android-runtime/pack.sh               # 拆成 jniLibs 与 rootfs（需要 dpkg-deb 与 Android NDK）
tool/bundle-runtime.sh                     # 构建 runtime 并把 main.cjs、android.mjs 内置进 App
flutter build apk --release --target-platform android-arm64
```

正式签名把密钥信息放在 `console/android/key.properties`（不入库，见 `build.gradle.kts`），没有时用 debug 签名。

## 5. 开发

```bash
cd runtime && npm run dev      # 以 ./.dev 为家目录直接运行 TypeScript
cd console && flutter run      # 连接设备调试控制台
cd cli && npm run build && node dist/quetzal.mjs status --home /tmp/w   # 构建 npm 包并用独立家目录试装
```
