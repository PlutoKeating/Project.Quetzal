#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `deliverables` 基础能力包：仅在受限工作区生成交付物并登记 `ArtifactRef`。

/// 本能力包的稳定 ID。
pub const CAPABILITY_ID: &str = "deliverables";
