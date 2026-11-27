# Quetzalcoatl Linux 原生桌面端（`quetzalcoatl-desktop`）

GTK4 + 动态链接 `libadwaita-1` 的纯原生桌面与托盘客户端，可与本机 `quetzalcoatld`
无缝配合，也支持在没有守护进程 / 没有 D-Bus 会话总线 / 没有托盘宿主的环境下优雅降级。
**没有任何 WebView 套壳**（无 Electron、无 Tauri、无 WebKitGTK）。

这是一个**只读窗口**：只展示守护进程快照（连接状态、会话、良知、审计），没有输入框，
也不向守护进程发起任何对话请求。对话永远发生在用户自己的宿主里。

## 1. 三档认知密度

| 密度 | 快捷键 | 披露层级 | 内容 |
| --- | --- | --- | --- |
| 陪伴（Companion） | `Ctrl+1` / `Ctrl+Shift+1` | `Summary` | 连接状态，以及会话、良知、审计的一句话摘要 |
| 工作台（Workbench） | `Ctrl+2` / `Ctrl+Shift+2` | `Summary + Detail` | 会话、项目、审批、工作流 |
| 检视（Inspector） | `Ctrl+3` / `Ctrl+Shift+3` | `Summary + Detail + Raw` | 良知树/锁定正文、工具、审计、运行技术细节 |

快捷键注册为 `GAction` + accelerator（布局无关，AZERTY 等布局同样可用）；运行技术细节
（pid、IPC 端点、错误码）只出现在检视态。在线启动时经本地认证 IPC 拉取
`desktop_snapshot`（会话/运行进展/良知/审计),并以差分 `ViewPatch` 幂等落入 UI。

切换只替换可见页，不重建窗口，也不会重建或丢弃任何快照行；当前密度写入配置目录，
重启后自动恢复。

## 2. 构建

```bash
# 依赖：GTK 4 >= 4.14（编译开启 gtk4 crate 的 v4_10/v4_14 特性）
#      与 libadwaita >= 1.9（编译开启 libadwaita crate 的 v1_9 + gtk_v4_10 特性）
# 注意：加入本 crate 后，`cargo clippy/test --workspace` 也需要这两个开发包与 xvfb。
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
→ `$HOME/.config/quetzalcoatl-desktop`（文件 `desktop.json`，同目录 `<pid>.tmp` 原子替换；
应用声明 `NON_UNIQUE`，临时名含 pid 以免多实例互相覆盖；JSON 损坏或必填字段缺失时整体
回退默认配置，只有 `maximized` 带 `#[serde(default)]`）。

## 5. 降级行为（绝不崩溃、绝不弹错误对话框）

| 场景 | 行为 | 自检标记 |
| --- | --- | --- |
| `quetzalcoatld` 未运行 | 类型化离线视图 + 一句话说明 + 「重新连接」按钮 | `connected=false degraded=1` |
| 运行凭证权限过宽 | 主动拒绝连接并提示 `0600` 修复 | `connected=false degraded=1` |
| 无 `DBUS_SESSION_BUS_ADDRESS` | 托盘静默关闭，窗口正常 | `tray=no-session-bus` |
| 有总线但无 StatusNotifier 宿主 | 托盘对象仍导出，不报错；关闭窗口即退出 | `tray=no-watcher` |
| 总线不可连接 | 托盘静默关闭；关闭窗口即退出 | `tray=bus-unavailable` |

托盘驻留成功时（`tray=registered`）关闭窗口只隐藏（`app.hold()` 保活），左键 `Activate`
重新呈现主窗口；右键 `ContextMenu` 弹出原生托盘菜单（显示主窗口 / 退出），只有菜单里的
「退出」会真正结束进程。Rust API 类型的宿主使用同样的「关窗隐藏」语义。

## 6. 无障碍（AT-SPI）

- 每个交互控件与每个分组都设置 `GtkAccessible` 名称（`aria-label` 等价物）；
- 页栈由 `AdwViewSwitcher` 暴露 `tablist` 语义，`Ctrl+1/2/3` 与开关（Tab）顺序一致。

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
- **快照刷新**：只在启动与点「重新连接」时拉取 `desktop_snapshot`，没有定时刷新。
- **托盘菜单**：导出 `StatusNotifierItem` 且 `Menu=/NO_DBUS_MENU`（无 DBusMenu）；宿主调用
  `ContextMenu` 时由本端弹出原生 Gtk 菜单窗口，菜单项是 `app.show-window` / `app.quit`
  两个 GAction。
