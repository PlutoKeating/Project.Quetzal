# Quetzalcoatl Linux 原生桌面端（`quetzalcoatl-desktop`）

GTK4 + 动态链接 `libadwaita-1` 的纯原生桌面与托盘客户端，可与本机 `quetzalcoatld`
无缝配合，也支持在没有守护进程 / 没有 D-Bus 会话总线 / 没有托盘宿主的环境下优雅降级。
**没有任何 WebView 套壳**（无 Electron、无 Tauri、无 WebKitGTK）。

## 1. 三档认知密度

| 密度 | 快捷键 | 披露层级 | 内容 |
| --- | --- | --- | --- |
| 陪伴（Companion） | `Ctrl+1` | `Summary` | 零术语、≥64pt 触点、流式对话正文与实时播报 |
| 工作台（Workbench） | `Ctrl+2` | `Summary + Detail` | 会话、项目、审批、工作流、消息输入 |
| 检视（Inspector） | `Ctrl+3` | `Summary + Detail + Raw` | 良知树、工具调用、审计原始载荷、推理增量 |

切换只替换可见页，不重建窗口、不重放流，因此会话与流状态天然保持；当前密度写入
配置目录，重启后自动恢复。

## 2. 构建

```bash
# 依赖：GTK 4（>= 4.10，`announce()` 需要 >= 4.14）与 libadwaita 1（>= 1.9）开发包
sudo apt install libgtk-4-dev libadwaita-1-dev xvfb

cargo build -p quetzalcoatl-desktop
```

产物：`target/debug/quetzalcoatl-desktop`。

## 3. 安装（install）

```bash
# 可执行文件（按需加 sudo 前缀装到 /usr/local）
install -Dm755 target/release/quetzalcoatl-desktop ~/.local/bin/quetzalcoatl-desktop

# 桌面规范文件（.desktop）
install -Dm644 surfaces/linux/resources/org.quetzalcoatl.Desktop.desktop \
  ~/.local/share/applications/org.quetzalcoatl.Desktop.desktop

# 图标占位（hicolor 主题）
install -Dm644 surfaces/linux/resources/org.quetzalcoatl.Desktop.svg \
  ~/.local/share/icons/hicolor/scalable/apps/org.quetzalcoatl.Desktop.svg

# 刷新桌面数据库（可选）
update-desktop-database ~/.local/share/applications
gtk-update-icon-cache ~/.local/share/icons/hicolor 2>/dev/null || true
```

`.desktop` 中 `DBusActivatable=false`：本端不以 D-Bus 激活方式启动，避免与托盘总线竞争。

## 4. 运行与自检

```bash
quetzalcoatl-desktop                     # 正常启动（自动连接本机 quetzalcoatld）
quetzalcoatl-desktop --home /path/to/qz  # 指定 Quetzalcoatl 家目录
xvfb-run -a quetzalcoatl-desktop --self-test --home /path/to/qz
```

`--self-test` 是**已文档化**的无头自检入口：构建主窗口、尝试连接守护进程、打印一行

```
SELF_TEST_OK window=visible density=workbench connected=true degraded=0 tray=no-watcher
```

后立即退出（退出码 0）。它不写任何后端数据，只用于 CI 冒烟。

配置目录优先级：`QUETZALCOATL_DESKTOP_CONFIG_DIR` → `$XDG_CONFIG_HOME/quetzalcoatl-desktop`
→ `$HOME/.config/quetzalcoatl-desktop`（文件 `desktop.json`，原子写入，损坏即回退默认值）。

## 5. 降级行为（绝不崩溃、绝不弹错误对话框）

| 场景 | 行为 | 自检标记 |
| --- | --- | --- |
| `quetzalcoatld` 未运行 | 类型化离线视图 + 一句话说明 + 「重新连接」按钮 | `connected=false degraded=1` |
| 运行凭证权限过宽 | 主动拒绝连接并提示 `0600` 修复 | `connected=false degraded=1` |
| 无 `DBUS_SESSION_BUS_ADDRESS` | 托盘静默关闭，窗口正常 | `tray=no-session-bus` |
| 有总线但无 StatusNotifier 宿主 | 托盘对象仍导出，不报错 | `tray=no-watcher` |
| 总线不可连接 | 托盘静默关闭 | `tray=bus-unavailable` |

## 6. 无障碍（AT-SPI）

- 每个交互控件都设置 `GtkAccessible` 名称/描述（`aria-label`/`aria-description` 等价物）；
- 页栈由 `AdwViewSwitcher` 暴露 `tablist` 语义，`Ctrl+1/2/3` 与开关（Tab）顺序一致；
- 流式回复区标记为持续更新区域，并在批次收束时调用 GTK 4.14 `announce()`（`aria-live` 等价物）；
- 无 AT-SPI 总线时 `announce()` 为安全空操作。

## 7. 许可证与 LGPL-2.1 边界

本端源码为 `Apache-2.0`。`libadwaita-1` 是 LGPL-2.1-or-later：本项目**只**通过
`pkg-config` 探测并**动态链接**系统共享库（`DT_NEEDED=libadwaita-1.so.*`），
使用户可用修改过的库副本替换（LGPL-2.1 §6）。`tests/dynamic_link_and_ui.rs`
对真实构建产物断言：

- `readelf -d` 的 `NEEDED` 含 `libadwaita-1.so` 与 `libgtk-4.so`；
- `ldd` 全部可解析、且不含任何 WebView 运行时；
- `nm -D -u` 出现 `adw_*` 导入，而 `nm --defined-only` 中 `adw_*` 定义数为 **0**
  （证明没有被静态并入可执行文件）。

`cargo` 依赖图里不存在 Adwaita 的静态 crate，`deny.toml` 许可证白名单无需放行 LGPL。

## 8. 已知限制 / 后续接线

- **窗口位置**：GTK4 移除 `gtk_window_get_position()`/`gtk_window_move()`，Wayland 亦禁止
  客户端指定绝对坐标，故只持久化尺寸/最大化，位置由合成器管理。
- **审批动作**：`win.approve`/`win.deny` 目前只记录本地提示，守护进程尚未提供审批写回
  IPC（待后续任务接线，绝不伪造成功）。
- **流式对话**：模型已消费 `quetzalcoatl-client-core` 的拉模式 `ViewStream`；守护进程当前
  `Chat` 返回整段回复，因此 UI 以单个 `Delta + Done` 批次呈现，token 级 SSE 待守护进程侧
  暴露流式通道后接入。
- **托盘菜单**：仅导出 `StatusNotifierItem`，`Menu` 指向 `/NO_DBUS_MENU`（无 DBusMenu），
  左键激活语义由宿主决定。
