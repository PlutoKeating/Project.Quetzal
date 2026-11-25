# Quetzalcoatl Windows 原生桌面端（WinUI 3）

`C# / .NET 9 + WinUI 3 (Microsoft.WindowsAppSDK)` 纯原生桌面客户端：三档认知密度、
系统托盘、Fluent 主题、UI Automation 无障碍树，以及经 `quetzalcoatl-uniffi` 拉模式
`FfiViewStream` 的薄客户端。**没有任何 WebView 套壳**（无 Electron、无 Tauri、无 WebView2）。

## 1. 三档认知密度

| 密度 | 快捷键 | 披露层级 | 内容 |
| --- | --- | --- | --- |
| 陪伴（Companion） | `Ctrl+1` | `Summary` | 零术语、≥64px 触点、流式对话正文 |
| 工作台（Workbench） | `Ctrl+2` | `Summary + Detail` | 会话、工作流、审批、消息输入与同一份对话正文 |
| 检视（Inspector） | `Ctrl+3` | `Summary + Detail + Raw` | 良知锁定正文、工具、审计、运行技术细节 |

切换只替换可见标签页，不重建窗口、不重放流，因此会话与流状态天然保持；当前密度、
窗口尺寸与最大化写入 `%LOCALAPPDATA%\Quetzalcoatl\desktop.json`（同目录临时文件原子替换，
JSON 损坏整体回退默认值）。

## 2. 构建与测试（Windows 10 1809+ / Windows 11，x64）

依赖：

- **.NET SDK 9.0+**（`dotnet --version` 应 ≥ 9.0）；
- **Visual Studio 2022 Build Tools** 的「通用 Windows 平台生成工具」工作负载
  （`Microsoft.VisualStudio.Workload.UniversalBuildTools`）：WinUI 3 的 MRT/PRI 与
  payload 目标需要其中的 `AppxPackage` MSBuild 任务
  （`Microsoft.Build.AppxPackage.dll` / `Microsoft.Build.Packaging.Pri.Tasks.dll`）。
  `dotnet build` 的 `$(MSBuildExtensionsPath)` 指向 .NET SDK 目录，因此
  `Directory.Build.props` 已把 `AppxMSBuildToolsPath` 显式指向 VS 安装目录；
  安装示例：
  `vs_BuildTools.exe --add Microsoft.VisualStudio.Workload.UniversalBuildTools --includeRecommended --quiet --norestart`
- 首次还原需要访问 nuget.org（`Microsoft.WindowsAppSDK 1.7.260224002`、xunit、Windows SDK 投影包）；
- 目标机无需另装 Windows App SDK 运行时（`WindowsAppSDKSelfContained=true`）。

```powershell
cd surfaces\windows

# 还原 + 编译（Nullable=enable、TreatWarningsAsErrors=true，零警告门禁）
dotnet restore Quetzalcoatl.Windows.sln -p:Platform=x64
dotnet build   Quetzalcoatl.Windows.sln -c Debug -p:Platform=x64 --no-restore

# 单测（视图模型绑定、5,000 事件流 UI 线程看门狗、无障碍契约、降级模式、偏好持久化）
dotnet test Quetzalcoatl.Windows.sln -c Debug -p:Platform=x64 --no-build `
  --logger "console;verbosity=detailed"

# 一键脚本（编译 + 单测 + 自检 + UI Automation 冒烟）
powershell -ExecutionPolicy Bypass -File scripts\run-tests.ps1 -Dotnet C:\dotnet\dotnet.exe
```

产物：`src\Quetzalcoatl.App\bin\x64\Debug\net9.0-windows10.0.19041.0\win-x64\Quetzalcoatl.App.exe`
（自包含 Windows App SDK；首次干净构建会生成 `Quetzalcoatl.App.pri` 资源索引）。

### 无头自检

```powershell
Quetzalcoatl.App.exe --self-test --demo-rows --report C:\Temp\self-test.txt
# 报告：SELF_TEST_OK window=visible density=workbench connected=False degraded=True bindings=False tray=registered rows=6
```

`--self-test` 构建真实窗口后立即写报告并退出，不写任何后端数据，仅用于 CI 冒烟。
它需要**交互式桌面会话**：WinUI 3 的 `Application.Start` 在 Session 0 / 无输入桌面的会话里会以
`COMException (0x8000FFFF)` 结束（详见第 8 节），此时脚本会打印 SKIP 而不是伪造通过。

## 3. UI Automation 冒烟（需要交互式桌面）

`tests\Quetzalcoatl.UiSmoke` 是外部 UIA 客户端（WPF 自带的 `System.Windows.Automation`）：
启动真实窗口 → 逐档选中 `tab.companion` / `tab.workbench` / `tab.inspector` → 读取 UIA 树 →
对照 `Quetzalcoatl.Desktop.A11y.DesktopControlCatalog` 校验名称、控件类型、键盘可达、
Invoke/Value 模式、`LiveSetting` 与触点尺寸。

```powershell
# 交互式桌面（RDP / 控制台登录）中：
$app  = "src\Quetzalcoatl.App\bin\x64\Debug\net9.0-windows10.0.19041.0\win-x64\Quetzalcoatl.App.exe"
$smoke = "tests\Quetzalcoatl.UiSmoke\bin\Debug\net9.0-windows10.0.19041.0\Quetzalcoatl.UiSmoke.exe"
& $smoke --app $app --report ui-smoke.txt --observed-dump ui-observed.json --timeout 60
```

退出码：`0` 全部通过；`77` 没有交互式桌面/窗口未出现（SKIP，绝不当作通过）；`2` 契约不符。
SSH 会话（Session 0）没有交互式桌面，必须通过计划任务在已登录用户会话中运行，例如：

```powershell
schtasks /Create /TN QzUiSmoke /SC ONCE /ST 23:59 /IT /RL LIMITED /F `
  /TR "powershell -ExecutionPolicy Bypass -File C:\path\to\surfaces\windows\scripts\run-tests.ps1"
schtasks /Run /TN QzUiSmoke
```

## 4. 系统托盘与生命周期

- 托盘图标由原生 `Shell_NotifyIconW` 创建（消息专用隐藏窗口 + 原生右键菜单「显示主窗口 / 退出」）；
  注册失败时静默退化为「关闭即退出」，绝不留下无法唤回的幽灵进程。
- 关闭主窗口默认隐藏到托盘（`desktop.json` 的 `closeToTray`）；托盘不可用时关闭即退出。
- `--minimized` 启动后直接驻留托盘；`--install-startup` / `--remove-startup` 写/删
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（等价 Linux 用户 unit / macOS LaunchAgent）。
- Fluent 主题随系统浅色/深色；Windows 11 使用 Mica 材质，Windows 10 自动退化为纯色。

## 5. 降级行为（绝不崩溃、绝不弹错误对话框）

| 场景 | 行为 |
| --- | --- |
| `quetzalcoatld` 未运行（`run/daemon.json` 缺失） | 类型化离线视图 + 一句话说明 + 「重新连接」 |
| 运行时令牌缺失 | 同上（不读任何内容） |
| `daemon.json` 损坏 | 「本机助手暂时没有响应」+ 检视态技术原因 |
| 这个构建未链接原生绑定 | 「这个版本还连不上本机助手」 |
| 托盘注册失败 | 关闭即退出，窗口功能不受影响 |

零术语守卫（`A11y.ZeroJargon`）静态审计陪伴态全部文案；技术细节（错误码、端点、事件号）
只出现在检视态。

## 6. 无障碍（UI Automation）

- 每个交互控件都有 `AutomationProperties.AutomationId` / `Name`（原生 WinUI 自动提供
  Invoke / Value / SelectionItem 模式与键盘可达）；
- 密度切换是原生 `TabView`（`TabItem` + `SelectionItem`），`Ctrl+1/2/3` 键盘加速器；
- 对话区与连接状态是 `LiveSetting=Polite` 的实时区域，流式批次**每批只播报一次**
  （`StreamingAnnouncer` + `AutomationPeer.RaiseNotificationEvent`）；
- `DesktopControlCatalog` 是唯一事实来源：单测静态比对真实 XAML 的 AutomationId/Name，
  UIA 冒烟再用真实自动化树比对一次，任何 XAML 漂移都会让 `dotnet test` 失败。

## 7. 与本机守护进程接线（UniFFI）

默认构建不链接原生库（界面完整、降级视图类型化）。要启用真实拉模式流：

```powershell
# 1) 在 Windows 上用 MSVC 工具链构建 cdylib
cargo build -p quetzalcoatl-uniffi --release
# 2) 生成 C# 绑定（uniffi-bindgen-cs，见 crates/bindings/quetzalcoatl-uniffi/bindgen-cs-pin.json）
uniffi-bindgen-cs --library target\release\quetzalcoatl_uniffi.dll `
  --config crates\bindings\quetzalcoatl-uniffi\uniffi.toml --out-dir C:\Temp\qz-cs --no-format
# 3) 带绑定编译，并把 DLL 放到输出目录
dotnet build Quetzalcoatl.Windows.sln -c Debug -p:Platform=x64 `
  -p:QzBindingsDir=C:\Temp\qz-cs
copy target\release\quetzalcoatl_uniffi.dll `
  src\Quetzalcoatl.App\bin\x64\Debug\net9.0-windows10.0.19041.0\win-x64\
```

此时 `StreamSourceFactory.BindingsAvailable == true`，`--demo-stream N` 会以真实
`FfiViewStream` 驱动流式对话区。

## 8. 已知限制

- **快照 IPC**：现有 UniFFI 面只导出 `FfiViewSession` / `FfiViewStream`，尚未导出
  `desktop_snapshot` 的 IPC 读接口；因此在线时列表区为空，本地发送只回显并提示
  「对话通道还没有接入这个界面」。新增导出后再接线，绝不伪造数据。
- **审批写回**：守护进程尚无审批写回 IPC，批准/拒绝只记录本地提示。
- **托盘菜单无障碍**：原生 Win32 菜单项不在 WinUI 的 UIA 树内（由系统 Shell 提供），
  契约里标记为 `ControlSurface.Tray`，主窗口冒烟不检查它们。
- **计划任务**：`--install-startup` 使用 HKCU Run 键而不是计划任务；企业环境如禁用 Run 键需改用
  组策略分发的计划任务。
- **窗口运行期冒烟的环境边界（本任务实测）**：本次验证机没有已登录的交互式用户会话
  （`qwinsta`：console 会话停在登录界面，Session 0 为 SSH）。在此环境下：
  - `dotnet build` 全解决方案 **0 warning / 0 error**，并真实生成 `Quetzalcoatl.App.pri`；
  - `dotnet test` 的 32 个测试全部通过（27 个桌面视图模型/流泵/无障碍 + 5 个守护进程探测）；
  - 启动应用会在 `Microsoft.UI.Xaml.Application.Start` 抛
    `COMException (0x8000FFFF)`（stowed exception `0xC000027B`），
    UI Automation 冒烟据此返回 `77`（SKIP）并记录应用退出码，绝不冒充通过。
  在真实登录桌面上运行 `scripts\run-tests.ps1` 即可得到真实窗口与 UIA 树证据。
- **崩溃取证**：`StartupDiagnostics` 模块初始化器把启动期未处理异常写入
  `%TEMP%\quetzalcoatl-win-startup-error.txt`，WinExe 无控制台时也可定位。
