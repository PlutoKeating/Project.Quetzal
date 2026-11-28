# Quetzalcoatl Windows 端（WinUI 3，最小治理外壳）

按 000 号铁律（不做自己的 agent harness），Windows 端不再有对话、输入框或流式视图。
它只是一个说明窗口：「治理面在 Web 与 Linux 上；在终端运行 `qz open`」，外加一个
「打开本机治理面」按钮（调用 `qz open`，找不到 `qz` 时提示在终端运行）。

- `C# / .NET 9 + WinUI 3`，`Nullable=enable`，`TreatWarningsAsErrors=true`（见 `Directory.Build.props`）；
- 没有 WebView 套壳，不持有任何数据库或 IPC 句柄；
- 构建需要 Windows 与 VS 2022 Build Tools 的「通用 Windows 平台生成工具」（Appx/PRI 任务）：

```powershell
cd surfaces\windows
dotnet restore Quetzalcoatl.Windows.sln -p:Platform=x64
dotnet build   Quetzalcoatl.Windows.sln -c Debug -p:Platform=x64 --no-restore
```

Linux/macOS 上无法构建 WinUI 3；本端只在 Windows 的 CI 任务里编译验证。
