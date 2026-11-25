#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 每 Agent / 每设备独立的 `ChannelIngressKey`。
//!
//! - 初始种子由当前 `EpochKey` 经 HKDF-SHA256 域分离派生，绝不复用设备身份私钥；
//! - 种子以 `0600` 存入 `QUETZALCOATL_HOME/secrets/channel_ingress.json`，内存使用 `Zeroizing`；
//! - 仅向 Hub 登记 X-Wing 公钥与不可逆 key id，私钥永不出本机；
//! - `rotate()` 生成全新随机种子并覆盖本地文件，使旧公钥无法解密新入站行。

use std::path::{Path, PathBuf};

use hkdf::Hkdf;
use quetzalcoatl_crypto::{
    DeviceIdentity, EpochKey, HpkeSealedBox, WEBHOOK_INGRESS_INFO, XWING_PK_LEN, XWingKeyPair,
    hex_decode_fixed, hex_encode, hpke_xwing_open,
};
use quetzalcoatl_types::{DeviceId, QuetzalcoatlError, Result};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const INGRESS_SEED_LABEL: &[u8] = b"quetzalcoatl/v2/channel-ingress/";
const SEED_FILE: &str = "secrets/channel_ingress.json";

#[derive(Serialize, Deserialize)]
struct PersistedIngressSeed {
    device_id: String,
    seed_hex: String,
    key_id: String,
}

/// 独立通道入站密钥。
pub struct ChannelIngressKey {
    device_id: DeviceId,
    key_id: String,
    xwing: XWingKeyPair,
}

impl ChannelIngressKey {
    /// 从本地种子加载；不存在或设备不匹配时由当前 `EpochKey` 派生并落盘。
    pub fn load_or_derive(home: &Path, epoch_key: &EpochKey, device_id: DeviceId) -> Result<Self> {
        let path = home.join(SEED_FILE);
        if let Ok(raw) = std::fs::read(&path)
            && let Ok(persisted) = serde_json::from_slice::<PersistedIngressSeed>(&raw)
            && persisted.device_id == device_id.to_string()
            && let Ok(seed) = hex_decode_fixed::<32>("ingress_seed", &persisted.seed_hex)
        {
            return Self::from_seed(device_id, &seed, Some(&persisted.key_id));
        }
        let seed = derive_seed(epoch_key, device_id)?;
        let key = Self::from_seed(device_id, &seed, None)?;
        key.persist(home)?;
        Ok(key)
    }

    /// 主动轮换：生成全新随机种子并覆盖本地文件。
    pub fn rotate(home: &Path, device_id: DeviceId) -> Result<Self> {
        let mut seed = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(seed.as_mut());
        let key = Self::from_seed(device_id, &seed, None)?;
        key.persist(home)?;
        Ok(key)
    }

    fn from_seed(
        device_id: DeviceId,
        seed: &[u8; 32],
        expected_key_id: Option<&str>,
    ) -> Result<Self> {
        let xwing = XWingKeyPair::from_seed(*seed)?;
        let digest = Sha256::digest(xwing.public_key_bytes());
        let key_id = hex_encode(&digest[..16]);
        if let Some(expected) = expected_key_id
            && !expected.is_empty()
            && expected != key_id
        {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("本地 channel ingress 种子与 key_id 不一致"),
            });
        }
        Ok(Self {
            device_id,
            key_id,
            xwing,
        })
    }

    fn persist(&self, home: &Path) -> Result<()> {
        let seed = Zeroizing::new(*self.xwing.seed());
        let path = home.join(SEED_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("创建 channel ingress secrets 目录失败: {e}"),
            })?;
        }
        let payload = serde_json::to_vec_pretty(&PersistedIngressSeed {
            device_id: self.device_id.to_string(),
            seed_hex: hex_encode(seed.as_ref()),
            key_id: self.key_id.clone(),
        })
        .map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("序列化 channel ingress 种子失败: {e}"),
        })?;
        let tmp: PathBuf = path.with_extension("json.tmp");
        std::fs::write(&tmp, payload).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("写入 channel ingress 种子失败: {e}"),
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(
                |e| QuetzalcoatlError::StorageError {
                    detail: format!("设置 channel ingress 种子 0600 失败: {e}"),
                },
            )?;
        }
        std::fs::rename(&tmp, &path).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("提交 channel ingress 种子失败: {e}"),
        })
    }

    #[must_use]
    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    #[must_use]
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    #[must_use]
    pub fn public_key(&self) -> &[u8; XWING_PK_LEN] {
        self.xwing.public_key_bytes()
    }

    pub fn open(&self, aad: &[u8], enc: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        let sealed = HpkeSealedBox {
            enc: enc.to_vec(),
            ciphertext: ciphertext.to_vec(),
        };
        hpke_xwing_open(self.xwing_keypair(), WEBHOOK_INGRESS_INFO, aad, &sealed)
    }

    fn xwing_keypair(&self) -> &XWingKeyPair {
        &self.xwing
    }
}

/// 供测试证明"设备身份私钥 ≠ 通道入站私钥"。
#[must_use]
pub fn ingress_and_device_keys_differ(
    device: &DeviceIdentity,
    ingress: &ChannelIngressKey,
) -> bool {
    device.xwing_public_key() != ingress.public_key()
}

fn derive_seed(epoch_key: &EpochKey, device_id: DeviceId) -> Result<Zeroizing<[u8; 32]>> {
    let mut info = Vec::with_capacity(INGRESS_SEED_LABEL.len() + 36);
    info.extend_from_slice(INGRESS_SEED_LABEL);
    info.extend_from_slice(device_id.to_string().as_bytes());
    let hk = Hkdf::<Sha256>::new(None, epoch_key.as_bytes());
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(&info, out.as_mut())
        .map_err(|_| QuetzalcoatlError::StorageError {
            detail: String::from("HKDF 派生 channel ingress 种子失败"),
        })?;
    Ok(out)
}
