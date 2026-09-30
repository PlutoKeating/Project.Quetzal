# console · 控制台 App

Flutter（Material 3，深色为主），应用 ID `xyz.windler.console`，应用名「Windler」。不绑定任何具体 agent：名字与主题色来自当前连接的 agent 的身份数据；可保存多个 agent 连接并一键切换。

## 定位

- **只是前端，不托管运行基座。** App 被杀、升级、卸载都不影响 Windler。
- **两个角色**：点火器（基座离线时通过 Termux 的 RUN_COMMAND 启动服务）与管理前端（通过本地网关实时观察与控制）。
- **体验基调**：这是在陪伴和观察一个生命，不是一块运维面板。首页感性，越往里越理性。

## 构建

```bash
flutter pub get
flutter test
flutter build apk --release --target-platform android-arm64
```

依赖：`web_socket_channel`、`shared_preferences`、`qr_flutter`、`url_launcher`、`file_picker`（附件，一次最多 20 个）；Markdown 渲染用 `flutter_markdown_plus` + `markdown`（GFM），`flutter_math_fork`（LaTeX），`webview_flutter`（Mermaid 图）。

构建注意：Flutter 的 Gradle 工具（`packages/flutter_tools/gradle/settings.gradle.kts`）要求仓库只在 settings 里声明（`FAIL_ON_PROJECT_REPOS`）。如果本机 `~/.gradle/init.gradle` 之类的用户级初始化脚本给每个项目注入了镜像仓库，`assembleRelease` 会以"repository 'maven' was added by settings file"失败；构建时把该脚本临时移开即可，完成后放回。

资源：`assets/mermaid/` 内置 mermaid.js v11.17.2（MIT，见同目录 LICENSE），离线可用。为兼容旧版 WebView（如 Chromium 88），已用 esbuild 把语法降到 `chrome88`，并在 `view.html` 中补上缺少的 API。升级 mermaid 的做法：先 `npm pack mermaid@<版本>`，再对 `dist/mermaid.min.js` 执行 `esbuild --target=chrome88 --minify`，替换同名文件。原生部分只有 `MainActivity.kt` 里的点火器（MethodChannel `windler/igniter`）。

设计与用例见 [ARCHITECTURE.md](ARCHITECTURE.md)。
