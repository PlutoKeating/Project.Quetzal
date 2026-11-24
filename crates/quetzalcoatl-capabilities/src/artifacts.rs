#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `artifacts` 基础能力包：不可变 `ArtifactRef` 与 Git Tree 产物的登记/读取。

/// 本能力包的稳定 ID。
pub const CAPABILITY_ID: &str = "artifacts";
