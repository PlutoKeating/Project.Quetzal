#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-crypto` — Quetzalcoatl V2 密码学核心。
//!
//! 提供：
//! 1. `AccountRootKey`（Ed25519 主权根密钥、成员设备增删签名授权，以及 5 槽位根密钥封装原语，含 RFC 9807 `OPAQUE-Ristretto255-SHA512` + Argon2id Slot 4）；
//! 2. `DeviceIdentity`（Ed25519 单写者签名对 + `MLKEM768X25519` X-Wing `0x647a` RFC 9180 HPKE 密钥对）；
//! 3. `EpochKeyRing`（基于 X-Wing HPKE 的激活设备纪元密钥包裹与踢人前向轮换 `EpochKey[e+1]`）；
//! 4. `seal_packfile` / `open_packfile`（`zstd windowLog<=20` 1MiB 解压上限护栏 + 2 的幂次分桶填充防 CRIME + 随机 `PerPackDEK` `XChaCha20-Poly1305` + 规范化结构 `AAD`）。

pub mod keys;
pub mod pack;

pub use keys::{
    AccountRootKey, DeviceIdentity, DevicePublicRecord, EPOCH_KEY_WRAP_INFO, EpochKey,
    EpochKeyRing, HpkeBaseSchedule, HpkeSealedBox, MemberOperation, OpaqueAkeTranscript,
    OpaqueEnvelopeBundle, OpaqueMhfParams, PAIRING_WRAP_INFO, RootWrapSlot, ShamirShare,
    SignedMembershipChange, Slot4WrappedRootKey, WEBHOOK_INGRESS_INFO, WrappedEpochKeyEntry,
    WrappedRootKeySlot, XWING_COMBINER_LABEL, XWING_ENC_LEN, XWING_PK_LEN, XWingEncapDebug,
    XWingKeyPair, hpke_key_schedule_base, hpke_xwing_open, hpke_xwing_seal,
    hpke_xwing_seal_deterministic, hpke_xwing_seal_with_context, opaque_3dh_derive,
    opaque_build_envelope_deterministic, opaque_client_build_registration,
    opaque_client_finish_3dh, opaque_evaluate_oprf, opaque_finalize_oprf,
    opaque_harden_randomized_pwd, opaque_open_envelope, opaque_oprf_blind_deterministic,
    opaque_random_scalar_and_point, verify_ed25519_signature,
};
pub use pack::{
    MIN_BUCKET_BYTES, PackAad, PackCompartment, SPINE_EVENT_HASH_CONTEXT, SealedManifestEnvelope,
    SealedPackfile, ZSTD_MAX_WINDOW_BYTES, ZSTD_MAX_WINDOW_LOG, build_padded_frame,
    compute_bucket_len, open_manifest_envelope, open_packfile, parse_padded_frame,
    seal_manifest_envelope, seal_packfile, seal_packfile_with_materials, zstd_compress_1mib,
    zstd_decompress_1mib_guarded,
};

use quetzalcoatl_types::{QuetzalcoatlError, Result};

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

/// 将任意字节切片编码为小写十六进制字符串。
#[must_use]
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(char::from(HEX_LOWER[usize::from(b >> 4)]));
        out.push(char::from(HEX_LOWER[usize::from(b & 0x0f)]));
    }
    out
}

const fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 将偶数长度十六进制字符串解码为字节向量。
pub fn hex_decode(kind: &'static str, hex_str: &str) -> Result<Vec<u8>> {
    let raw = hex_str.as_bytes();
    if !raw.len().is_multiple_of(2) {
        return Err(QuetzalcoatlError::invalid_id(
            kind,
            format!("十六进制长度必须为偶数，实际为 {}", raw.len()),
        ));
    }
    let mut out = Vec::with_capacity(raw.len() / 2);
    for idx in 0..(raw.len() / 2) {
        let hi = decode_nibble(raw[idx * 2]).ok_or_else(|| {
            QuetzalcoatlError::invalid_id(kind, format!("非法十六进制字符位于 {}", idx * 2))
        })?;
        let lo = decode_nibble(raw[idx * 2 + 1]).ok_or_else(|| {
            QuetzalcoatlError::invalid_id(kind, format!("非法十六进制字符位于 {}", idx * 2 + 1))
        })?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

/// 将定长十六进制字符串解码为固定长度字节数组。
pub fn hex_decode_fixed<const N: usize>(kind: &'static str, hex_str: &str) -> Result<[u8; N]> {
    let vec = hex_decode(kind, hex_str)?;
    if vec.len() != N {
        return Err(QuetzalcoatlError::invalid_id(
            kind,
            format!("期望 {N} 字节，实际解码得 {} 字节", vec.len()),
        ));
    }
    let mut arr = [0u8; N];
    arr.copy_from_slice(&vec);
    Ok(arr)
}
