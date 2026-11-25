# Quetzalcoatl macOS 原生桌面端（SwiftUI）

`Swift 6（严格并发）+ SwiftUI`（macOS 14+）纯原生桌面客户端：三档认知密度、菜单栏常驻、
launchd 友好的生命周期，以及经 `quetzalcoatl-uniffi` 拉模式 `FfiViewStream` 的薄客户端。
**没有任何 WebView 套壳**（无 Electron、无 Tauri、无 WKWebView）。

## 1. 三档认知密度

| 密度 | 快捷键 | 披露层级 | 内容 |
| --- | --- | --- | --- |
| 陪伴（Companion） | `⌘1` | `Summary` | 零术语、≥64pt 触点、流式对话正文 |
| 工作台（Workbench） | `⌘2` | `Summary + Detail` | 会话、工作流、审批、消息输入与同一份对话正文 |
| 检视（Inspector） | `⌘3` | `Summary + Detail + Raw` | 良知锁定正文、工具、审计、运行技术细节 |

切换只替换可见视图，不重建窗口、不重放流；当前密度、窗口尺寸写入
`$QUETZALCOATL_HOME/desktop.json`（默认 `~/.quetzalcoatl/desktop.json`，`Data.write(.atomic)`，
JSON 损坏整体回退默认值）。

## 2. 构建与测试

依赖：

- macOS 14+（本任务实测 **macOS 26 / Swift 6.3.3**）；
- **Xcode Command Line Tools**（`swift build` / `swift test`）：`xcode-select --install`。
  完整 Xcode 不是必需；但 CLT-only 环境没有 XCTest，因此测试使用 **Swift Testing**
  （`import Testing`），并需要把 CLT 自带的 `Testing.framework` 路径显式传给 SwiftPM
  （见下方命令）。装有完整 Xcode 时直接 `swift test` 即可；
- 可选：Rust 工具链（`cargo` 1.99+）与 `uniffi-bindgen`，仅用于启用真实 UniFFI 原生库（见第 7 节）。

```bash
cd surfaces/macos

swift build            # 编译 QuetzalcoatlCore / QuetzalcoatlInterop / QuetzalcoatlMac

# CLT-only（无完整 Xcode）时 Testing.framework 不在默认搜索路径：
swift test \
  -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib
# 实测：37 tests in 7 suites passed；5,000 事件看门狗 max_gap_ms=2.82 / max_callback_ms=0.59
# 有完整 Xcode 时：swift test

swift run QuetzalcoatlMac --self-test --demo-rows --report /tmp/qz-self-test.txt
# 自检会断言真实不变量（不可在线、degraded、density=inspector、rows=6、announcements=1），
# 全部满足才输出 MAC_SELF_TEST_OK 并退出 0；否则 MAC_SELF_TEST_FAIL + 退出 1
#（不创建 NSApplication，可在无 WindowServer 的 SSH 会话运行）。

swift run QuetzalcoatlMac --demo-rows          # 图形界面（三档 + 菜单栏）
swift run QuetzalcoatlMac --demo-stream 200    # 演示拉模式流（无绑定时自动用合成源）
swift run QuetzalcoatlMac --home /path/to/qz   # 指定 Quetzalcoatl 家目录
```

> 说明：`--self-test` 不创建 `NSApplication`，可在无 WindowServer 的 SSH 会话中运行；
> 图形界面需要已登录的桌面会话。

## 3. 菜单栏与 launchd 生命周期

- `MenuBarExtra` 常驻菜单栏：「显示主窗口」（`⌘O`）/「退出 Quetzalcoatl」；
- 关闭主窗口不退出进程（`applicationShouldTerminateAfterLastWindowClosed = false`），
  从菜单栏可重新唤起；
- `--menu-bar-only` 以 `.accessory` 激活策略启动（不占 Dock），供 LaunchAgent 使用；
- 生成 LaunchAgent 模板：

```bash
swift run QuetzalcoatlMac --print-launch-agent > ~/Library/LaunchAgents/org.quetzalcoatl.macos.plist
plutil -lint ~/Library/LaunchAgents/org.quetzalcoatl.macos.plist   # 实测 OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.quetzalcoatl.macos.plist
launchctl kickstart -k gui/$(id -u)/org.quetzalcoatl.macos
```

plist 含 `RunAtLoad`、`KeepAlive{SuccessfulExit:false}`、`ThrottleInterval=10`、
`ProcessType=Interactive`、`StandardOutPath/StandardErrorPath` 与可选
`EnvironmentVariables.QUETZALCOATL_HOME`；单测用 `PropertyListSerialization` 真实解析校验。

## 4. 降级行为（绝不崩溃、绝不弹错误对话框）

| 场景 | 行为 |
| --- | --- |
| `quetzalcoatld` 未运行 | 类型化离线视图 + 一句话说明 + 「重新连接」 |
| 令牌权限过宽（非 0600 / 属主不符） | 主动拒绝连接并给出一句话修复提示 |
| 运行时文件存在但 pid 已退出 / 令牌错误 / 握手失败 | `DetectedUnverified`：「找到了本机助手，但还没通过验证」；输入禁用，绝不显示为已连接 |
| `daemon.json` 损坏 | 「本机助手暂时没有响应」+ 检视态技术原因 |
| 这个构建未链接原生绑定 | 「这个版本还连不上本机助手」 |
| VoiceOver / 无障碍通知不可用 | 播报静默失败，正文渲染不受影响 |

零术语守卫（`ZeroJargon`）静态审计陪伴态全部文案；技术细节只出现在检视态。

## 5. 无障碍

- 每个交互控件都有 `.accessibilityIdentifier` / `.accessibilityLabel`（按钮、文本框由
  SwiftUI 自动提供 `.isButton` / `.isTextField` 等原生 traits）；
- 密度切换按钮带 `.isSelected` trait 与 `⌘1/2/3` 快捷键；
- 对话正文/标题/连接状态/未连接说明是**内容承载控件**：不设置 `.accessibilityLabel`，
  VoiceOver 朗读真实内容；播报分两条互不重叠的通道：①连接状态只在连接变化时更新；
  ②每批流事件**恰好一次** `NSAccessibility.post(.announcementRequested)`（`medium` 优先级）。
  流式提示拆到非实时 `companion.streaming`（ProgressView + 文本），避免二次播报；
- `AccessibilityCatalog` 是唯一事实来源：单测扫描真实 SwiftUI 源码，断言每个 id/名称都出现、
  且源码里没有未登记的 id。

## 6. 架构边界

- `QuetzalcoatlCore`：平台中立的值类型模型（`ViewState`/`ViewPatch`/`UiModel`）、
  `StreamPump`（专用线程阻塞拉取 + 单一 MainActor 消费者，批次有界）与视图模型；
- `QuetzalcoatlInterop`：`LocalDaemonProbe`（只读 `run/daemon.json` + 权限校验后的
  `run/daemon.token`，**绝不打开脊柱**）与 UniFFI 适配器；
- `QuetzalcoatlMac`：SwiftUI 视图与生命周期，不直接持有任何数据库/IPC 句柄。

## 7. 启用真实 UniFFI 原生库（可选）

默认构建不含 `QuetzalcoatlBindings` 模块：`StreamSourceFactory` 返回 `nil`，界面进入类型化
降级视图。启用步骤（需要在 macOS 上构建 Rust）：

```bash
# 1) 构建 cdylib（macOS 目标）
cargo build -p quetzalcoatl-uniffi --release

# 2) 生成 Swift 绑定
cargo build -p quetzalcoatl-uniffi --features cli --bins
./target/release/uniffi-bindgen generate target/release/libquetzalcoatl_uniffi.dylib \
  -l swift -n -o surfaces/macos/Generated

# 3) 在 Package.swift 增加绑定 target（生成物含 QuetzalcoatlBindings.swift、
#    quetzalcoatl_uniffiFFI.h 与 module.modulemap）：
#    .systemLibrary(name: "quetzalcoatl_uniffiFFI", path: "Generated/CFFI")
#    .target(name: "QuetzalcoatlBindings", dependencies: ["quetzalcoatl_uniffiFFI"], path: "Generated")
#    并让 QuetzalcoatlInterop 依赖 "QuetzalcoatlBindings"。
#    运行期把 libquetzalcoatl_uniffi.dylib 放到可执行文件同目录（或设置 DYLD_LIBRARY_PATH）。
```

`UniffiBridge.swift` 已按 `#if canImport(QuetzalcoatlBindings)` 写好真实适配器
（`FfiViewStream.nextEvents(maxEvents:)` / `FfiViewSession.applyPatch(...)`），
启用后 `StreamSourceFactory.BindingsAvailable == true`，`--demo-stream N` 即由真实原生流驱动。

## 8. 已知限制

- **跨平台运行期验证 `Deferred (VMs paused by owner)`**：本轮修复只做静态审查（宿主无 Swift 工具链），
  `swift build` / `swift test` 需在恢复后的 macos-tahoe-lab 上复跑；探测握手新增可注入
  `StatusTransport`，成功/失败路径均有测试但尚未执行。
- **原生库运行期链接（`Deferred (VM paused by owner)`）**：验证机确有 Rust 1.99.1，并已成功
  构建 `uniffi-bindgen`；但 macOS 版 `libquetzalcoatl_uniffi.dylib` 与真实拉流/取消/视图投影
  冒烟在收尾前因 VM 被所有者暂停而中止，**未完成、未通过**。默认构建的降级路径、契约、流泵与
  `--self-test` 均已真实验证（`bindings=False`）。
- **快照 IPC**：现有 UniFFI 面只导出 `FfiViewSession` / `FfiViewStream`，尚未导出
  `desktop_snapshot` IPC 读接口；在线时列表区为空，本地发送只回显并提示。
- **审批写回**：守护进程尚无审批写回 IPC，批准/拒绝只记录本地提示。
- **VoiceOver 实机走查**：静态契约 + 源码扫描已通过，交互式 VoiceOver 走查需要图形桌面会话，
  留待全受众无障碍走查（Task 5.3）。
