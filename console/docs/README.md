# console · 控制台 App

Flutter（Material 3，深色为主），应用 ID `xyz.windler.console`，应用名「Windler」。不绑定任何具体 agent：名字与主题色来自当前连接的 agent 的身份数据；可保存多个 agent 连接并一键切换。

## 定位

- **不托管运行基座，但负责把它装好。** 运行基座跑在同一台手机的 Termux 里；App 被杀、升级、卸载都不影响它。
- **三个角色**：安装器（把 App 内置的运行基座与 Termux 适配器装进 Termux、注册服务与开机自启、升级与修复）、点火器（基座离线时通过 Termux 的 RUN_COMMAND 启动服务）与管理前端（通过本地网关实时观察与控制）。
- **体验基调**：这是在陪伴和观察一个生命，不是一块运维面板。首页感性，越往里越理性。

## 构建

```bash
tool/bundle-runtime.sh        # 构建 ../runtime，把 main.cjs、termux.mjs 与版本号放进 assets/runtime/（不入库）
flutter pub get
flutter test
flutter build apk --release --target-platform android-arm64
```

签名：`android/key.properties`（不入库）里给出 `storeFile`、`storePassword`、`keyAlias`、`keyPassword` 即用正式签名，没有时退回 debug 签名。版本号在 `pubspec.yaml`，与 runtime 的版本一致。

依赖：`web_socket_channel`、`shared_preferences`、`qr_flutter`、`url_launcher`、`file_picker`（附件，一次最多 20 个）；Markdown 渲染用 `flutter_markdown_plus` + `markdown`（GFM），`flutter_math_fork`（LaTeX），`webview_flutter`（Mermaid 图）。

构建注意：Flutter 的 Gradle 工具（`packages/flutter_tools/gradle/settings.gradle.kts`）要求仓库只在 settings 里声明（`FAIL_ON_PROJECT_REPOS`）。如果本机 `~/.gradle/init.gradle` 之类的用户级初始化脚本给每个项目注入了镜像仓库，`assembleRelease` 会以"repository 'maven' was added by settings file"失败；构建时把该脚本临时移开即可，完成后放回。

资源：`assets/install/install.sh` 是 Termux 侧的安装脚本（装软件包、放运行基座、注册 runit 服务与开机脚本、写设备配置、启动并健康检查，失败切回上一版；进度回报给 App 的本机 HTTP 服务）；`assets/runtime/` 是内置的运行基座。`assets/mermaid/` 内置 mermaid.js v11.17.2（MIT，见同目录 LICENSE），离线可用。为兼容旧版 WebView（如 Chromium 88），已用 esbuild 把语法降到 `chrome88`，并在 `view.html` 中补上缺少的 API。升级 mermaid 的做法：先 `npm pack mermaid@<版本>`，再对 `dist/mermaid.min.js` 执行 `esbuild --target=chrome88 --minify`，替换同名文件。原生部分只有 `MainActivity.kt` 里的 Termux 桥（MethodChannel `windler/igniter`）：RUN_COMMAND、三件套版本、打开应用、电池优化与各厂商自启动管理页。

设计与用例见 [ARCHITECTURE.md](ARCHITECTURE.md)。
