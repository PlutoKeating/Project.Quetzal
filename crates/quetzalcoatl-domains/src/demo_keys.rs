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

/// 演示信任锚的钉扎摘要表：每个合成演示监护人公钥**只**被授权为这里列出的
/// 正式规范化正文背书。修改任何内置 `pack.json` 后必须重新运行
/// `cargo run -p quetzalcoatl-domains --example sign_domain_packs` 并同步本表，
/// 否则 `embedded_pack_documents_and_demo_trust_table_are_in_sync` 契约测试会失败。
pub const BUILTIN_TRUSTED_BODY_DIGESTS: [(&str, &str); 5] = [
    (
        "eldercare-guardian",
        "67810ab7368aba0b786917dedc53b86f5e5dc7677487c2144ce3a217a44a0d73",
    ),
    (
        "personal-companion",
        "a681b5e2f41a924e7f56e244f33aade915b173f68796c0e3ad5746f30b35a758",
    ),
    (
        "regulated-professional",
        "32a61cec93278fc1e2e2da12a8a191530732974a9b537bcdae3de28c45a6097e",
    ),
    (
        "software-engineering",
        "311202d6a32d904e74e2f4b65d5ba3a4316cf593425bab149aa8b16fa81b2599",
    ),
    (
        "youth-socratic-tutor",
        "1bd564886d58d632c29a9ca1fcb3acc95d6086507947552ed9614a21304e0c29",
    ),
];

/// 取某一内置领域包被演示锚钉扎的正文规范化摘要。
#[must_use]
pub fn builtin_trusted_body_digest(domain_id: &str) -> Option<&'static str> {
    BUILTIN_TRUSTED_BODY_DIGESTS
        .iter()
        .find(|(id, _)| *id == domain_id)
        .map(|(_, digest)| *digest)
}

/// 由领域包 ID 确定性派生合成演示监护人种子（非机密，仅供示范与测试）。
#[must_use]
pub fn demo_guardian_seed(domain_id: &str) -> [u8; 32] {
    let mut hasher = Hasher::new_derive_key(DEMO_GUARDIAN_DERIVE_CONTEXT);
    hasher.update(domain_id.as_bytes());
    *hasher.finalize().as_bytes()
}

/// 取某一领域包对应的合成演示监护人公钥（仅钉扎在该包内置正文上）。
#[must_use]
pub fn demo_guardian_key(domain_id: &str) -> GuardianKey {
    let signing_key = SigningKey::from_bytes(&demo_guardian_seed(domain_id));
    let pinned = builtin_trusted_body_digest(domain_id)
        .map(|digest| vec![String::from(digest)])
        .unwrap_or_default();
    GuardianKey::demo(
        hex_encode(signing_key.verifying_key().as_bytes()),
        format!("guardian:demo-{domain_id}"),
        pinned,
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
