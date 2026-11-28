//! 配对在新设备一侧的闭环：等旧设备确认，取回根密钥与纪元钥匙，然后让这台设备成为同一个他。
//!
//! 流程：新设备 `qz pair join` 之后，旧设备 `qz pair approve`；新设备用配对短码向 Hub 换回
//! 会话与（用新设备公钥封存的）根密钥，再等旧设备经封存钥匙通道寄来纪元钥匙。都齐了以后，
//! 新设备停掉守护进程，把原来那片（空的）海挪到一边，按同一个身份写好身份与密钥文件，
//! 再启动：同步拉下旧设备的密文包，条目钥匙随后经同一通道到达，重放出同一片海。

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

use quetzalcoatl_crypto::{DevicePublicRecord, hex_encode, open_for_device};
use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::daemon::{now_unix_ms, write_private_file};
use crate::sea_sync::EPOCH_KEY_PREFIX;

/// 配对完成后、尚未接管时的全部材料。只在本机，0600。
const PENDING_ADOPTION: &str = "fabric/pending_adoption.json";
/// 接管后、第一次重放出旧设备的海之前存在：这期间不收编任何出厂基线。
pub(crate) const ADOPTING_MARKER: &str = "identity/adopting_from_pairing";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PairAdoption {
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub root_key_hex: String,
    pub ed25519_seed_hex: String,
    pub xwing_seed_hex: String,
    /// 纪元 → 纪元钥匙（十六进制）。
    pub epoch_keys: BTreeMap<u64, String>,
    pub peers: Vec<DevicePublicRecord>,
    pub hub_url: String,
    pub hub_ca_file: Option<std::path::PathBuf>,
    pub relay_url: String,
    pub qad_port: u16,
    pub session_token: String,
    pub account_id: String,
}

impl PairAdoption {
    /// 齐了：至少有第一个纪元的钥匙。
    #[must_use]
    pub fn ready(&self) -> bool {
        self.epoch_keys.contains_key(&1)
    }
}

pub(crate) fn load_pending(qz_home: &Path) -> Option<PairAdoption> {
    fs::read(qz_home.join(PENDING_ADOPTION))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
}

pub(crate) fn save_pending(qz_home: &Path, adoption: &PairAdoption) -> Result<()> {
    let bytes =
        serde_json::to_vec_pretty(adoption).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("无法写出配对材料: {e}"),
        })?;
    write_private_file(&qz_home.join(PENDING_ADOPTION), &bytes)
}

impl crate::fabric::DaemonFabricRuntime {
    /// 新设备一侧：换回会话与根密钥（只能换一次，所以换到就先落盘），再取纪元钥匙。
    /// 旧设备还没确认时返回「还没确认」的错误，调用方隔一会儿再试。
    pub(crate) fn pair_complete(
        &self,
        qz_home: &Path,
        pairing_id: &str,
        short_code: &str,
    ) -> Result<PairAdoption> {
        let joiner = self.joiner_identity(qz_home)?;
        let mut adoption = match load_pending(qz_home) {
            Some(existing) if existing.device_id == joiner.device_id() => existing,
            _ => {
                let anon = self.hub_client(None)?;
                let (session, root) = self
                    .runtime()
                    .block_on(anon.pair_complete_and_unwrap(pairing_id, short_code, &joiner))?;
                let config = self.config_snapshot();
                let created = PairAdoption {
                    agent_id: session.agent_id,
                    device_id: joiner.device_id(),
                    root_key_hex: hex_encode(root.as_bytes()),
                    ed25519_seed_hex: hex_encode(joiner.ed25519_seed()),
                    xwing_seed_hex: hex_encode(joiner.xwing_seed()),
                    epoch_keys: BTreeMap::new(),
                    peers: Vec::new(),
                    hub_url: config.hub_url.clone(),
                    hub_ca_file: config.hub_ca_file.clone(),
                    relay_url: config.relay_url.clone(),
                    qad_port: config.qad_port,
                    session_token: session.session_token,
                    account_id: session.account_id,
                };
                save_pending(qz_home, &created)?;
                created
            }
        };
        let client = self.hub_client(Some(&adoption.session_token))?;
        // 旧设备在它下一次心跳时寄出纪元钥匙：等一小会儿。
        for _ in 0..15 {
            let incoming = self
                .runtime()
                .block_on(client.list_sealed_keys(adoption.agent_id, adoption.device_id))
                .unwrap_or_default();
            for (name, sealed) in incoming {
                let Some(epoch) = name
                    .strip_prefix(EPOCH_KEY_PREFIX)
                    .and_then(|e| e.parse::<u64>().ok())
                else {
                    continue;
                };
                if let Ok(raw) = open_for_device(adoption.agent_id, &joiner, &name, &sealed) {
                    adoption
                        .epoch_keys
                        .insert(epoch, String::from_utf8_lossy(&raw).into_owned());
                }
            }
            if adoption.ready() {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        adoption.peers = self
            .runtime()
            .block_on(client.list_active_devices(adoption.agent_id))
            .unwrap_or_default()
            .into_iter()
            .filter(|record| record.device_id != adoption.device_id)
            .collect();
        save_pending(qz_home, &adoption)?;
        Ok(adoption)
    }
}

/// 守护进程停着的时候调用：把这台设备变成配对来的那个他。原来的身份与脊柱挪到一边，不删。
pub fn adopt_paired_identity(qz_home: &Path) -> Result<AgentId> {
    let adoption = load_pending(qz_home).ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from("没有待接管的配对：先 qz pair join。"),
    })?;
    if !adoption.ready() {
        return Err(QuetzalcoatlError::StorageError {
            detail: String::from("还没收到旧设备寄来的钥匙：让旧设备保持联网，稍后再试。"),
        });
    }
    let aside = qz_home.join(format!("before-pairing-{}", now_unix_ms()));
    fs::create_dir_all(&aside).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("无法创建备份目录: {e}"),
    })?;
    for rel in ["identity", "spine"] {
        let from = qz_home.join(rel);
        if from.exists() {
            fs::rename(&from, aside.join(rel)).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("无法把原来的 {rel} 挪到一边: {e}"),
            })?;
        }
    }
    crate::daemon::write_adopted_identity(qz_home, &adoption)?;
    let extra: Vec<(u64, String)> = adoption
        .epoch_keys
        .iter()
        .filter(|(epoch, _)| **epoch > 1)
        .map(|(epoch, key)| (*epoch, key.clone()))
        .collect();
    let membership = serde_json::json!({
        "extra_epoch_keys": extra,
        "peer_devices": adoption.peers,
    });
    write_private_file(
        &qz_home.join("fabric/membership_state.json"),
        membership.to_string().as_bytes(),
    )?;
    let session = serde_json::json!({
        "hub_url": adoption.hub_url,
        "hub_ca_file": adoption.hub_ca_file,
        "relay_url": adoption.relay_url,
        "qad_port": adoption.qad_port,
        "session_token": adoption.session_token,
        "account_id": adoption.account_id,
        "agent_id": adoption.agent_id,
        "device_id": adoption.device_id,
    });
    write_private_file(
        &qz_home.join("fabric/hub_session.json"),
        session.to_string().as_bytes(),
    )?;
    write_private_file(&qz_home.join(ADOPTING_MARKER), b"1")?;
    let _ = fs::remove_file(qz_home.join(PENDING_ADOPTION));
    Ok(adoption.agent_id)
}
