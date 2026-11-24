#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-bridge` — Hermes / OpenClaw 兼容的受限 `Role::Bridge` 脊柱桥接器。

pub mod spine_bridge;

pub use spine_bridge::{BridgeAuditEntry, BridgeEvent, BridgeKey, BridgeRole, SpineBridge};
