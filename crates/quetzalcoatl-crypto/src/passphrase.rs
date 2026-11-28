//! 本人口令：签署底线、吊销设备这类郑重的动作要本人再输一次口令。
//!
//! 只存口令的 Argon2id 派生值与盐，不存口令本身；核对用常数时间比较。

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::{hex_decode, hex_encode};
use quetzalcoatl_types::{QuetzalcoatlError, Result};

/// 口令至少这么多个字符。
pub const MIN_PASSPHRASE_CHARS: usize = 8;

const MEMORY_KIB: u32 = 64 * 1024;
const ITERATIONS: u32 = 3;
const PARALLELISM: u32 = 1;
const OUTPUT_LEN: usize = 32;

/// 口令的核对记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassphraseVerifier {
    pub salt_hex: String,
    pub hash_hex: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

fn derive(
    passphrase: &str,
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<[u8; OUTPUT_LEN]> {
    let params =
        Params::new(memory_kib, iterations, parallelism, Some(OUTPUT_LEN)).map_err(|e| {
            QuetzalcoatlError::IntegrityViolation {
                detail: format!("口令派生参数无效: {e}"),
            }
        })?;
    let mut out = [0u8; OUTPUT_LEN];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| QuetzalcoatlError::IntegrityViolation {
            detail: format!("口令派生失败: {e}"),
        })?;
    Ok(out)
}

impl PassphraseVerifier {
    /// 为一个新口令生成核对记录。口令太短时拒绝。
    pub fn create(passphrase: &str) -> Result<Self> {
        if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("口令至少要 {MIN_PASSPHRASE_CHARS} 个字符。"),
            });
        }
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let mut hash = derive(passphrase, &salt, MEMORY_KIB, ITERATIONS, PARALLELISM)?;
        let verifier = Self {
            salt_hex: hex_encode(&salt),
            hash_hex: hex_encode(&hash),
            memory_kib: MEMORY_KIB,
            iterations: ITERATIONS,
            parallelism: PARALLELISM,
        };
        hash.zeroize();
        Ok(verifier)
    }

    /// 核对口令。记录损坏时返回错误，口令不对时返回 `Ok(false)`。
    pub fn verify(&self, passphrase: &str) -> Result<bool> {
        let salt = hex_decode("passphrase_salt", &self.salt_hex)?;
        let expected = hex_decode("passphrase_hash", &self.hash_hex)?;
        let mut actual = derive(
            passphrase,
            &salt,
            self.memory_kib,
            self.iterations,
            self.parallelism,
        )?;
        let same = expected.len() == actual.len()
            && expected
                .iter()
                .zip(actual.iter())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0;
        actual.zeroize();
        Ok(same)
    }
}

/// 用口令封存的一段数据（例如导出包里的恢复包）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassphraseSealed {
    pub salt_hex: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub nonce_hex: String,
    pub ciphertext_hex: String,
}

const SEAL_DOMAIN: &[u8] = b"quetzalcoatl/v2/passphrase-seal\0";

/// 用口令封存一段数据。口令太短时拒绝。`purpose` 绑定进密文：挪作别的用途解不开。
pub fn seal_with_passphrase(
    passphrase: &str,
    purpose: &str,
    plaintext: &[u8],
) -> Result<PassphraseSealed> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(QuetzalcoatlError::PermissionDenied {
            detail: format!("口令至少要 {MIN_PASSPHRASE_CHARS} 个字符。"),
        });
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let mut key = derive(passphrase, &salt, MEMORY_KIB, ITERATIONS, PARALLELISM)?;
    let aad = [SEAL_DOMAIN, purpose.as_bytes()].concat();
    let sealed = XChaCha20Poly1305::new((&key).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| QuetzalcoatlError::IntegrityViolation {
            detail: String::from("口令封存失败"),
        });
    key.zeroize();
    Ok(PassphraseSealed {
        salt_hex: hex_encode(&salt),
        memory_kib: MEMORY_KIB,
        iterations: ITERATIONS,
        parallelism: PARALLELISM,
        nonce_hex: hex_encode(&nonce),
        ciphertext_hex: hex_encode(&sealed?),
    })
}

/// 用口令打开封存的数据。口令不对、用途不符或内容被改过都会失败。
pub fn open_with_passphrase(
    passphrase: &str,
    purpose: &str,
    sealed: &PassphraseSealed,
) -> Result<Vec<u8>> {
    let salt = hex_decode("passphrase_seal_salt", &sealed.salt_hex)?;
    let nonce = hex_decode("passphrase_seal_nonce", &sealed.nonce_hex)?;
    if nonce.len() != 24 {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: String::from("封存数据的随机数长度不对"),
        });
    }
    let ciphertext = hex_decode("passphrase_seal_ciphertext", &sealed.ciphertext_hex)?;
    let mut key = derive(
        passphrase,
        &salt,
        sealed.memory_kib,
        sealed.iterations,
        sealed.parallelism,
    )?;
    let aad = [SEAL_DOMAIN, purpose.as_bytes()].concat();
    let opened = XChaCha20Poly1305::new((&key).into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| QuetzalcoatlError::PermissionDenied {
            detail: String::from("口令不对，或者这份数据被改动过。"),
        });
    key.zeroize();
    opened
}

#[cfg(test)]
mod tests {
    use super::{PassphraseVerifier, open_with_passphrase, seal_with_passphrase};

    #[test]
    fn sealed_data_opens_only_with_the_same_passphrase_and_purpose() {
        let Ok(sealed) = seal_with_passphrase("湖边第三棵柳树下面", "recovery", b"root-key")
        else {
            return;
        };
        assert_eq!(
            open_with_passphrase("湖边第三棵柳树下面", "recovery", &sealed).ok(),
            Some(b"root-key".to_vec())
        );
        assert!(open_with_passphrase("湖边第四棵柳树下面", "recovery", &sealed).is_err());
        assert!(open_with_passphrase("湖边第三棵柳树下面", "other", &sealed).is_err());
        assert!(seal_with_passphrase("short", "recovery", b"x").is_err());
    }

    #[test]
    fn the_right_passphrase_verifies_and_others_do_not() {
        assert!(
            PassphraseVerifier::create("short").is_err(),
            "太短的口令被拒绝"
        );
        let verifier = PassphraseVerifier::create("湖边第三棵柳树下面");
        assert!(verifier.is_ok(), "够长的口令可以设定");
        let Ok(verifier) = verifier else {
            return;
        };
        assert!(!verifier.hash_hex.contains("湖边"));
        assert_eq!(verifier.verify("湖边第三棵柳树下面").ok(), Some(true));
        assert_eq!(verifier.verify("湖边第四棵柳树下面").ok(), Some(false));
    }
}
