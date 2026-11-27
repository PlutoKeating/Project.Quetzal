#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Quetzalcoatl V2 Linux 纯原生桌面端（GTK4 + 动态 `libadwaita`）。
//!
//! 四层契约：
//! 1. **单脊柱持有者**（防坑规范 #13）：只经 `quetzalcoatl-client-core::ThinClient`
//!    访问本机 `quetzalcoatld`，进程内绝不打开 `spine.sqlite`；
//! 2. **三档认知密度**：`Companion / Workbench / Inspector` 共享同一份
//!    `quetzalcoatl-client-core` 差分视图，切换只替换可见页；
//! 3. **只读**：只展示守护进程快照，没有输入框，也不发起任何对话请求；
//! 4. **纯原生**：GTK4 + 动态 `libadwaita-1`（LGPL-2.1 §6 可替换性），无 WebView、
//!    无 Electron/Tauri。

pub mod a11y;
pub mod app;
pub mod cli;
pub mod config;
pub mod degrade;
pub mod model;
pub mod tray;
pub mod views;
