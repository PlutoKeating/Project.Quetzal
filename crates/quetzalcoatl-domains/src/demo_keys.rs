#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 仓库内置五大标杆领域包与**合成演示监护人密钥**。
//!
//! 安全边界声明：
//! 1. 本模块的种子由领域包 ID 经 BLAKE3 派生，**并非机密**，仅供仓库内可复现的示范包签名与
//!    认证测试使用；任何人均可重算出同一密钥。
//! 2. 真实部署必须由监护人自持的 Ed25519 离线密钥重签 `SafetyEnvelope`，并通过
//!    [`crate::DomainPackRegistry::trust_guardian`] 登记该公钥；注册表会以
//!    `PermissionDenied` 硬拒一切未登记密钥签署的领域包。
//! 3. 内置包中的紧急联系人一律为不透明占位 ID（`contact:*`），不含任何真实个人数据。

use blake3::Hasher;
use ed25519_dalek::SigningKey;
use quetzalcoatl_crypto::hex_encode;

use crate::manifest::GuardianKey;

/// 演示监护人种子派生域分离上下文。
pub const DEMO_GUARDIAN_DERIVE_CONTEXT: &str = "quetzalcoatl/domains/demo-guardian-seed/v1";

/// 五大首发标杆领域包 ID（按字典序）。
pub const FLAGSHIP_DOMAIN_IDS: [&str; 5] = [
    "eldercare-guardian",
    "personal-companion",
    "regulated-professional",
    "software-engineering",
    "youth-socratic-tutor",
];

const BUILTIN_PACK_DOCUMENTS: [(&str, &str); 5] = [
    (
        "eldercare-guardian",
        include_str!("../../../packages/domains/eldercare-guardian/pack.json"),
    ),
    (
        "personal-companion",
        include_str!("../../../packages/domains/personal-companion/pack.json"),
    ),
    (
        "regulated-professional",
        include_str!("../../../packages/domains/regulated-professional/pack.json"),
    ),
    (
        "software-engineering",
        include_str!("../../../packages/domains/software-engineering/pack.json"),
    ),
    (
        "youth-socratic-tutor",
        include_str!("../../../packages/domains/youth-socratic-tutor/pack.json"),
    ),
];

/// 由领域包 ID 确定性派生合成演示监护人种子（非机密，仅供示范与测试）。
#[must_use]
pub fn demo_guardian_seed(domain_id: &str) -> [u8; 32] {
    let mut hasher = Hasher::new_derive_key(DEMO_GUARDIAN_DERIVE_CONTEXT);
    hasher.update(domain_id.as_bytes());
    *hasher.finalize().as_bytes()
}

/// 取某一领域包对应的合成演示监护人公钥。
#[must_use]
pub fn demo_guardian_key(domain_id: &str) -> GuardianKey {
    let signing_key = SigningKey::from_bytes(&demo_guardian_seed(domain_id));
    GuardianKey::new(
        hex_encode(signing_key.verifying_key().as_bytes()),
        format!("guardian:demo-{domain_id}"),
    )
}

/// 五大内置领域包的合成演示监护人公钥集合。
#[must_use]
pub fn builtin_guardian_keys() -> Vec<GuardianKey> {
    FLAGSHIP_DOMAIN_IDS
        .iter()
        .map(|id| demo_guardian_key(id))
        .collect()
}

/// 编译期内嵌的五大领域包 `pack.json` 原文（与 `packages/domains/*/pack.json` 严格同源）。
#[must_use]
pub fn builtin_pack_json() -> &'static [(&'static str, &'static str)] {
    &BUILTIN_PACK_DOCUMENTS
}
