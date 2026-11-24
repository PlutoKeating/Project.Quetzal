#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `doc-reader` 基础能力包：只读解析授权目录内文档，绝不修改原文件。

/// 本能力包的稳定 ID。
pub const CAPABILITY_ID: &str = "doc-reader";
