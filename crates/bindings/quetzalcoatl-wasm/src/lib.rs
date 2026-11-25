#![deny(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-wasm` — 浏览器端平台特化层（防坑规范 #17）。
//!
//! 三项平台特化在本 crate 收敛：
//!
//! 1. **OPFS 单写者存储**：`storage` 模块定义可注入的 [`storage::SingleWriterStorage`] 租约
//!    契约（原生用临时目录 mock 全量测试），`opfs` 模块在 `wasm32-unknown-unknown` 下以
//!    `navigator.locks` 的 **独占 Web Lock** + `ifAvailable: true` 在**任何写入之前**取锁，
//!    取不到即立刻失败（fail fast），绝不做无锁写入。
//! 2. **纯 Rust `ruzstd` 解压**：浏览器端不捆绑 C `zstd`，仅用 `ruzstd` 解压，且有解压体积上界
//!    （防解压炸弹）。
//! 3. **纯 WSS 传输**：`transport` 模块只接受 `wss://` 端点，禁止 `ws://`/`http://`
//!    明文回退；真正的 WSS 会话循环由 Web 端（Task 4.2）驱动。
//!
//! 浏览器 E2E（真机 OPFS/Web Lock 行为）在 Task 4.2 的 Web 端执行；本 crate 的
//! `cargo check -p quetzalcoatl-wasm --target wasm32-unknown-unknown` 负责类型级门禁，
//! 原生单测负责租约语义与解压正确性。

pub mod compress;
pub mod storage;
pub mod transport;

#[cfg(target_arch = "wasm32")]
pub mod opfs;

pub use compress::{
    CompressError, MAX_DECOMPRESSED_BYTES, decompress_pack, decompress_pack_bounded,
};
pub use storage::{SingleWriterStorage, StorageError, TempDirStorage, WriterLease};
pub use transport::{TransportError, WssEndpoint};

use quetzalcoatl_client_core::view_models::CognitionDensity;

/// 浏览器端默认认知密度：Web 端以 Workbench 起步，可随时切到 Companion/Inspector。
#[must_use]
pub fn default_density() -> CognitionDensity {
    CognitionDensity::Workbench
}
