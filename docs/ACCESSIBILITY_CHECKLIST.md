# 五端无障碍检查清单

本清单对应计划 Task 5.3 的"全受众无障碍走查"。每条检查都标注了**本轮实际执行**的证据类型：

- **静态契约**：源码/单测可验证，已在本机构建与测试中执行；
- **无头运行**：在 Linux 主机以 xvfb 或真实守护进程执行；
- **延后**：需要图形桌面或移动设备，且本轮 VM 暂停，统一标记
  `Deferred (VMs paused by owner)`，绝不伪造通过记录。

通用目标：陪伴态零技术黑话、触点 ≥64pt/px、200% 缩放与 320px 宽度不裁切、流式回复经两条互不
重叠的播报通道、技术细节只出现在检视态。

## 0. 总览

| 端 | 静态契约 | 无头运行 | 实机屏幕阅读器 | 结论 |
| --- | --- | --- | --- | --- |
| Web | 已执行（`surfaces/web/tests`） | 已执行（Playwright + 真实 `quetzalcoatld`） | 延后（NVDA/JAWS/VoiceOver 实机） | 部分完成 |
| Linux | 已执行（`surfaces/linux/tests`） | 已执行（`--self-test`） | 延后（Orca / AT-SPI 实机） | 部分完成 |
| macOS | 已执行（Swift Testing 源码扫描） | 延后 | 延后（VoiceOver 实机） | 部分完成 |
| Windows | 已执行（`dotnet test` 静态契约） | 延后 | 延后（Narrator + UIA 实机） | 部分完成 |
| iOS / Android | 由 Task 5.1 / 5.2 交付 | 延后 | 延后（VoiceOver / TalkBack） | 延后 |

## 1. Web（`surfaces/web`）

- [x] 双通道播报：`#qz-live-polite`（`role="status"`、`aria-live="polite"`）只接收流式正文；
      `#qz-live-assertive`（`role="alert"`、`aria-live="assertive"`）只接收工具、审批与错误事件，
      按事件 id 去重。
- [x] 正文区域不设 `aria-live`，避免与两个通道重复朗读。
- [x] 密度切换使用 `aria-pressed`，切换时在礼貌通道播报「已切换到…视图」。
- [x] 320px 视口 + 200% 字号无横向溢出、无文本裁切（`overflow-wrap: anywhere` 等不变量）。
- [x] 守护进程未运行时不闪错：先显示「正在连接…」，失败后移除 `aria-busy`，用
      `role="alert"` 播报并可重试。
- [x] 补丁序裂时显式 `PatchSequenceError` + assertive 播报 + 请求快照重发。
- [ ] **延后**：NVDA / JAWS / Safari VoiceOver 的实机朗读与焦点顺序走查 —
      `Deferred (VMs paused by owner)`。

证据：`surfaces/web/README.md`、`surfaces/web/tests`（vitest）与 `surfaces/web/e2e`（Playwright）。

## 2. Linux（`surfaces/linux`）

- [x] 交互控件设置 `GtkAccessible` 标签（`surfaces/linux/src/a11y.rs` 的 `set_label`）。
- [x] 状态颜色之外总有文字（冰蓝与琥珀从不单独承担含义）。
- [x] 抹除经确认对话框，写明不可恢复。
- [ ] **延后（未核实）**：键盘遍历顺序与对话框关闭后焦点的去向。
- [x] 守护进程联系不上时，顶部一行状态词与下一步，写动作全部停用（不是只置灰）。
- [x] 无头自检可运行：`xvfb-run -a quetzalcoatl-desktop --self-test --home <tmp>`。
- [ ] **延后（未实现）**：页内容变化（写动作完成、断线）的屏幕阅读器播报。
- [ ] **延后**：Orca + AT-SPI 实机朗读、200% 缩放的视觉效果与焦点环走查 —
      `Deferred (VMs paused by owner)`。

证据：`surfaces/linux/README.md`、`surfaces/linux/tests`。

## 3. macOS（`surfaces/macos`）

按 000 号铁律，macOS 端只剩一个最小治理外壳（一段说明文字与一个「打开本机治理面」按钮），
对话视图、输入框、流式播报与三档密度已删除，原有的无障碍契约与源码扫描单测随之移除。

- [x] 按钮使用原生 SwiftUI 控件，带 `.accessibilityIdentifier`，VoiceOver 朗读按钮文字。
- [ ] **延后**：VoiceOver 实机走查 — `Deferred (VMs paused by owner)`。

证据：`surfaces/macos/README.md`。

## 4. Windows（`surfaces/windows`）

按 000 号铁律，Windows 端只剩一个最小治理外壳（一段说明文字与一个「打开本机治理面」按钮），
对话视图、输入框、流式播报、托盘与 UIA 冒烟工程已删除。

- [x] 按钮设置 `AutomationProperties.Name`，使用原生 WinUI 3 控件，保留 Invoke 模式。
- [ ] **延后**：Narrator 实机朗读与高对比度主题走查 — `Deferred (VMs paused by owner)`。

证据：`surfaces/windows/README.md`。

## 5. iOS / Android

- [ ] 交付：iOS `SwiftAgent + FoundationModels` 与 Android `Jetpack Compose + Koog` 由计划
      Task 5.1 / 5.2 负责。
- [ ] **延后**：VoiceOver（iOS）/ TalkBack（Android）实机走查；
      Android `store` 包必须零 `AccessibilityService`、零 `dataSync` 前台服务。
      本轮统一 `Deferred (VMs paused by owner)`。

## 6. 通用回归清单（每次发版前）

1. 陪伴态文案不出现 API、token、JSON、错误码等技术词；技术细节只在检视态出现。
2. 主要按钮触点 ≥64pt/px；键盘可达；焦点顺序与视觉顺序一致。
3. 320px 宽度与 200% 字号下不裁切、不横向滚动。
4. 流式回复只经一条正文播报通道；连接状态与错误各走独立通道；无重复朗读。
5. 守护进程不可用、断网、补丁序裂、空列表、超长正文五种降级状态都有可朗读的说明。
6. 实机走查记录必须写明系统版本、屏幕阅读器版本与操作步骤；未执行的条目不勾选。
