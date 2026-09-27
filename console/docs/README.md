# console · 控制台 App

Flutter（Material 3，深色为主），应用 ID `xyz.amani.console`，应用名「神谷薰」。

## 定位

- **只是前端，不托管运行基座。** App 被杀、升级、卸载都不影响 Amani。
- **两个角色**：点火器（基座离线时通过 Termux 的 RUN_COMMAND 启动服务）与管理前端（通过本地网关实时观察与控制）。
- **体验基调**：这是在陪伴和观察一个生命，不是一块运维面板。首页感性，越往里越理性。

## 构建

```bash
flutter pub get
flutter test
flutter build apk --release --target-platform android-arm64
```

依赖：`web_socket_channel`、`shared_preferences`、`qr_flutter`、`url_launcher`。原生部分只有 `MainActivity.kt` 里的点火器（MethodChannel `amani/igniter`）。

设计与用例见 [ARCHITECTURE.md](ARCHITECTURE.md)。
