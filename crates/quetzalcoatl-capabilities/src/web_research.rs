#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `web-research` 基础能力包：只读联网检索，外发写操作必须经 `Router` 授权。

/// 本能力包的稳定 ID。
pub const CAPABILITY_ID: &str = "web-research";
