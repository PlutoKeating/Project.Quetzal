# 快速开始

## 1. 在一台安卓手机上安装（使用者）

一台闲置的安卓手机（Android 7 以上，arm64）就够了。

1. **装 Termux 三件套**：从 [F-Droid](https://f-droid.org/packages/com.termux/)（或 Termux 的 GitHub 发布页）安装 **Termux**、**Termux:API**、**Termux:Boot**，三个必须来自同一来源；Google Play 上的版本已废弃。打开 Termux 一次，等它初始化完成。
2. **装 Windler App**：从本仓库的发布页下载 APK 安装（或按第 3 节自己构建）。
3. **打开 Windler**：首页选「在这台手机上安装 Windler」，按向导走：
   - 授权「在 Termux 中运行命令」（系统弹窗）；
   - **唯一需要你动手的一步**：点「复制并打开 Termux」，在 Termux 里长按 → 粘贴 → 回车，执行那一行（开启 `allow-external-apps`，Termux 的安全设计不允许别的应用代劳）；
   - 点「安装」：向导自动安装 Node.js、runit、Termux:API 命令与 git，放入运行基座，注册服务与开机自启，启动并自检（几分钟、几十 MB 下载）。装完控制台自动连接，不需要配对码。
   - 最后按提示把 Termux 系列与 Windler 加入电池优化的忽略名单，并在厂商的自启动管理里放行；有锁屏密码的手机，重启后要解锁一次她才会醒来。
4. 之后的一切都在 App 里完成，见第 2 节。**升级**：装新版 APK 后，App 发现内置的运行基座比运行中的新，会提示一键升级（控制 → 服务 →「升级 / 重装」也可以），失败自动回退。

## 2. 之后的一切都在控制台里完成

1. **配置模型**：控制 → 模型 → 添加供应商（从目录选择或自定义）→ 添加 Key → 勾选模型 → 保存 → 测试连通 → 在「全局模型顺序」里拖动排序，可把一个便宜的模型设为「内省」模型。配置好之后，她就会按自己的节律开始醒来。
2. **身份**：控制 → 身份，给 agent 起名字、选主题色（写入它的灵魂仓库，所有身体同步）。没有灵魂仓库时，身份与人格先存在本机的灵魂目录里。
3. **能力授权**：控制 → 能力授权。相机、麦克风、定位、操作屏幕默认「每次询问」，她想用时会发审批给你；放心了就改成「允许」。
4. **接入飞书（可选）**：控制 → 飞书 →「开始」→ 在飞书中打开并确认。机器人自动创建并绑定你本人；在飞书里打开与机器人（以 agent 的显示名命名）的单聊，会收到「此刻」卡片，之后所有操作都通过卡片按钮完成。
5. **共享灵魂（可选）**：在 GitHub 网页创建一个**私有**仓库 → 控制 → 灵魂同步 →「显示公钥」并把它添加到仓库的 Deploy keys（允许写入）→ 填入仓库地址并「接入」。之后同步全自动。
6. **让 Hermes / OpenClaw 也住进来（可选）**：灵魂同步页第 3 步有一句现成的话，复制发给那台机器上的 Hermes 或 OpenClaw，它会自己安装 soul-bridge；需要你做的只有在 GitHub 网页添加一次它给出的部署公钥。
7. **听觉（可选）**：控制 → 语音 填好 Azure 语音的密钥与区域后，控制 → 听觉 → 授予麦克风权限 → 开启。之后这台手机常驻用麦克风听（通知栏有「Windler 在听」），听到的话以「环境声音」进入会话，她自己判断是不是对她说的、要不要回应；她也可能用声音回答你。
8. **多个 agent**：点顶栏的名字 →「连接新的 agent」，填入另一个运行基座的网关地址，申请配对码（通过那台设备的系统通知下发）并配对，之后一键切换。

## 3. 部署到其他机器（部署者）

任何能跑 Node.js 22+ 与 git 的机器都能成为身体。

```bash
cd runtime
npm ci
npm test          # 单元测试
npm run build     # 生成 dist/main.cjs（单文件，已内置依赖）与 dist/termux.mjs（安卓 / Termux 身体适配器）
WINDLER_HOME=~/windler node --enable-source-maps dist/main.cjs
```

生产环境请交给进程守护者（runit、systemd……），退出即重启。示例（systemd 用户服务）：

```ini
[Service]
Environment=WINDLER_HOME=%h/windler
Environment=WINDLER_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/windler/main.cjs
Restart=always
```

控制台连接这样的机器：把网关端口转发到控制台所在设备（例如 `adb reverse` 或 ssh 隧道），在 App 里填网关地址并用配对码配对。配对码通过适配器的系统通知下发，没有 `notify` 的适配器需要部署者从 `WINDLER_HOME/secrets/gateway.token` 读出令牌填入。

构建 Windler App：

```bash
cd console
tool/bundle-runtime.sh                     # 构建 runtime 并把 main.cjs、termux.mjs 内置进 App
flutter build apk --release --target-platform android-arm64
```

正式签名把密钥信息放在 `console/android/key.properties`（不入库，见 `build.gradle.kts`），没有时用 debug 签名。

## 4. 开发

```bash
cd runtime && npm run dev      # 以 ./.dev 为家目录直接运行 TypeScript
cd console && flutter run      # 连接设备调试控制台
```
