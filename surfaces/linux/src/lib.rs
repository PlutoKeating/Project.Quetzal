#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Quetzalcoatl V2 Linux 纯原生桌面端（GTK4 + 动态 `libadwaita`）：**治理面**。
//!
//! 四层契约：
//! 1. **只「看」和「签」**（000 号铁律：不做自己的 agent harness）：九页——总览、他、我、我们、
//!    往事、底线、宿主、设备、记录——没有任何给他发一句话的输入框；
//! 2. **单脊柱持有者**（防坑规范 #13）：只经 `quetzalcoatl_daemon::IpcClient` 调用本机
//!    `quetzalcoatld` 的 `sea_*` 方法，进程内绝不打开 `spine.sqlite`；
//! 3. **与 Web 版同构**：页、版面、动作与状态词同 `docs/GOVERNANCE_SURFACE.md`，视觉 token 取自
//!    `packages/design-system`，集中在 `style/` 一处；
//! 4. **纯原生**：GTK4 + 动态 `libadwaita-1`（LGPL-2.1 §6 可替换性），无 WebView、
//!    无 Electron/Tauri。

pub mod a11y;
pub mod api;
pub mod app;
pub mod aside;
pub mod cli;
pub mod config;
pub mod ctx;
pub mod degrade;
pub mod dialog;
pub mod pages;
pub mod routes;
pub mod shell;
pub mod style;
pub mod timefmt;
pub mod tray;
pub mod ui;
