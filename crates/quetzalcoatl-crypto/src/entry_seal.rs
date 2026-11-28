//! 条目级封存：每个条目一把钥匙。
//!
//! 签名事件链只能追加、不能改写，所以要让「抹除」是真删，正文就不能以明文进链。
//! 做法是：每个条目有一把随机钥匙，正文用它封成密文再进链；钥匙放在可以删除的地方。
//! 销毁钥匙之后密文还在，但再也读不出来——这就是抹除。

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::{hex_decode, hex_decode_fixed, hex_encode};

/// 封存时绑定的域：密文只能在「条目封存」这个用途下、配上同一个条目编号才能解开。
const ENTRY_SEAL_DOMAIN: &[u8] = b"quetzalcoatl/v2/sea-entry-seal\0";
const NONCE_LEN: usize = 24;

/// 一个条目的钥匙。离开作用域时清零。
pub struct EntryKey([u8; 32]);

impl EntryKey {
    /// 生成一把新的随机钥匙。
    #[must_use]
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    pub fn from_hex(hex_str: &str) -> Result<Self> {
        Ok(Self(hex_decode_fixed::<32>("entry_key", hex_str)?))
    }

    #[must_use]
    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

impl Drop for EntryKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// 封存后的条目正文。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedEntry {
    pub nonce_hex: String,
    pub ciphertext_hex: String,
}

fn seal_aad(entry_id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(ENTRY_SEAL_DOMAIN.len() + entry_id.len());
    aad.extend_from_slice(ENTRY_SEAL_DOMAIN);
    aad.extend_from_slice(entry_id.as_bytes());
    aad
}

/// 用条目的钥匙封存正文。密文与条目编号绑定：挪到别的条目上解不开。
pub fn seal_entry(key: &EntryKey, entry_id: &str, plaintext: &[u8]) -> Result<SealedEntry> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new((&key.0).into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &seal_aad(entry_id),
            },
        )
        .map_err(|_| QuetzalcoatlError::IntegrityViolation {
            detail: String::from("条目封存失败"),
        })?;
    Ok(SealedEntry {
        nonce_hex: hex_encode(&nonce),
        ciphertext_hex: hex_encode(&ciphertext),
    })
}

/// 用条目的钥匙解开正文。钥匙不对、密文被动过、或条目编号不符都会失败。
pub fn open_entry(key: &EntryKey, entry_id: &str, sealed: &SealedEntry) -> Result<Vec<u8>> {
    let nonce = hex_decode_fixed::<NONCE_LEN>("entry_seal_nonce", &sealed.nonce_hex)?;
    let ciphertext = hex_decode("entry_seal_ciphertext", &sealed.ciphertext_hex)?;
    let cipher = XChaCha20Poly1305::new((&key.0).into());
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &seal_aad(entry_id),
            },
        )
        .map_err(|_| QuetzalcoatlError::IntegrityViolation {
            detail: String::from("条目密文无法解开（钥匙不符或内容被改动）"),
        })
}

#[cfg(test)]
mod tests {
    use super::{EntryKey, open_entry, seal_entry};

    #[test]
    fn sealed_entry_opens_only_with_its_own_key_and_id() {
        let key = EntryKey::generate();
        let sealed = seal_entry(&key, "mem-1", "对青霉素过敏".as_bytes());
        let Ok(sealed) = sealed else {
            return;
        };
        assert!(
            !sealed
                .ciphertext_hex
                .contains(&super::hex_encode("青霉素".as_bytes())),
            "密文里不得出现明文"
        );
        assert_eq!(
            open_entry(&key, "mem-1", &sealed).ok(),
            Some("对青霉素过敏".as_bytes().to_vec())
        );
        assert!(
            open_entry(&key, "mem-2", &sealed).is_err(),
            "换一个条目编号解不开"
        );
        assert!(
            open_entry(&EntryKey::generate(), "mem-1", &sealed).is_err(),
            "换一把钥匙解不开：销毁钥匙即抹除"
        );
        let restored = EntryKey::from_hex(&key.to_hex());
        assert!(restored.is_ok_and(|k| open_entry(&k, "mem-1", &sealed).is_ok()));
    }
}
