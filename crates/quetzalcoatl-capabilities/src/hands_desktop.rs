#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `hands-desktop` 基础能力包：经 OS 沙箱的桌面自动化，高危动作强制二次确认。

/// 本能力包的稳定 ID。
pub const CAPABILITY_ID: &str = "hands-desktop";
