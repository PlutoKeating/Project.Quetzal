# Quetzalcoatl macOS 端（SwiftUI，最小治理外壳）

按 000 号铁律（不做自己的 agent harness），macOS 端不再有对话、输入框、三档窗口或流式泵。
它只是一个说明窗口：「治理面在 Web 与 Linux 上；在终端运行 `qz open`」，外加一个
「打开本机治理面」按钮（经 `PATH` 调用 `qz open`，失败时提示在终端运行）。

- `Swift 6`（严格并发）+ `SwiftUI`，macOS 14+，无 WebView 套壳；
- 不链接 `quetzalcoatl-uniffi`，不持有任何数据库或 IPC 句柄。

```bash
cd surfaces/macos
swift build
swift run QuetzalcoatlMac
```

本端只在 CI 的 macOS 任务里编译验证。
