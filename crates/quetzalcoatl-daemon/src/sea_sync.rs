//! 他的海跨设备：钥匙怎样到达另一台设备，抹除怎样到达每一台设备。
//!
//! 变更事件本身随脊柱的密文包同步；但条目正文是用各自的钥匙封存的，钥匙不进事件链
//! （否则抹除就不再是真删）。钥匙另走一条可以删除的路：用接收设备的 X-Wing 公钥封存后
//! 交给 Hub 转交，接收设备取走后存进自己的私有状态块。抹除一个条目时，本机销毁钥匙、
//! 在 Hub 上删掉寄给所有设备的那一份；别的设备重放到这次抹除时，也销毁自己那一把。
//! 一台一直离线的设备，要等它下次上线重放到这次抹除才会销毁它那一把。
//!
//! 纪元钥匙（解开密文包用）也走这条路：新设备配对后由已有的设备寄过去。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use quetzalcoatl_crypto::{EpochKey, open_for_device, seal_for_device};
use quetzalcoatl_ewave::journal::{self, entry_key_blob_name};
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{Epoch, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::daemon::{SharedDaemonCore, now_unix_ms};

/// 已经寄给哪台设备哪些钥匙（只在本机）。
const SENT_FILE: &str = "fabric/sealed_keys_sent.json";
/// 等联网后要在 Hub 上删掉的钥匙名（抹除时离线也不丢）。
const PENDING_DELETES_FILE: &str = "fabric/sealed_keys_pending_deletes.json";
/// 纪元钥匙在这条路上的名字前缀。
pub(crate) const EPOCH_KEY_PREFIX: &str = "epoch-key/";

#[derive(Default, Serialize, Deserialize)]
struct SentLedger {
    #[serde(default)]
    sent: BTreeMap<String, BTreeSet<String>>,
}

fn load<T: Default + for<'de> Deserialize<'de>>(qz_home: &Path, rel: &str) -> T {
    fs::read(qz_home.join(rel))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save<T: Serialize>(qz_home: &Path, rel: &str, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("无法写出 {rel}: {e}"),
    })?;
    crate::daemon::write_private_file(&qz_home.join(rel), &bytes)
}

/// 抹除时调用：记下要在 Hub 上删掉的钥匙名，下次联网时删。
pub(crate) fn queue_remote_key_delete(qz_home: &Path, name: &str) {
    let mut pending: BTreeSet<String> = load(qz_home, PENDING_DELETES_FILE);
    pending.insert(String::from(name));
    let _ = save(qz_home, PENDING_DELETES_FILE, &pending);
    // 也从「已寄出」里拿掉，免得以后误以为对方还有。
    let mut ledger: SentLedger = load(qz_home, SENT_FILE);
    for names in ledger.sent.values_mut() {
        names.remove(name);
    }
    let _ = save(qz_home, SENT_FILE, &ledger);
}

/// 一次交换的结果。
#[derive(Debug, Default)]
pub(crate) struct KeyExchange {
    pub received_entry_keys: usize,
    pub received_epoch_keys: usize,
}

/// 交换要用到的、从全局状态里取出的东西（取完就放锁）。
struct Snapshot {
    agent_id: quetzalcoatl_types::AgentId,
    device: quetzalcoatl_crypto::DeviceIdentity,
    peers: Vec<quetzalcoatl_crypto::DevicePublicRecord>,
    /// 名字与钥匙的十六进制。
    secrets: Vec<(String, String)>,
}

impl SharedDaemonCore {
    fn key_exchange_snapshot(&self) -> Result<Snapshot> {
        let guard = self
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("守护进程状态锁中毒"),
            })?;
        let spine = guard.kernel.spine();
        let device = spine.local_device().clone();
        let ring = spine.epoch_ring();
        let peers = ring
            .active_devices()
            .values()
            .filter(|record| record.device_id != device.device_id())
            .cloned()
            .collect();
        let mut secrets = crate::sea_archive::collect_entry_keys(spine.store(), &guard.conscience)?;
        let mut epoch = 1u64;
        while epoch <= ring.current_epoch().get() {
            if let Some(key) = ring.epoch_key(Epoch::new(epoch)) {
                secrets.push((
                    format!("{EPOCH_KEY_PREFIX}{epoch}"),
                    quetzalcoatl_crypto::hex_encode(key.as_bytes()),
                ));
            }
            epoch += 1;
        }
        Ok(Snapshot {
            agent_id: spine.agent_id(),
            device,
            peers,
            secrets,
        })
    }

    /// 寄出、取回、删除。网络调用都不持有全局状态锁。
    pub(crate) fn exchange_sealed_keys(
        &self,
        client: &quetzalcoatl_fabric::HubClient,
        rt: &tokio::runtime::Runtime,
    ) -> Result<KeyExchange> {
        let home = self.config.quetzalcoatl_home.clone();
        let snapshot = self.key_exchange_snapshot()?;

        // 1. 先删：抹除过的钥匙不再寄出，并从 Hub 上删掉所有设备的那一份。
        let mut pending: BTreeSet<String> = load(&home, PENDING_DELETES_FILE);
        let mut still_pending = BTreeSet::new();
        for name in &pending {
            if rt
                .block_on(client.delete_sealed_key(snapshot.agent_id, name))
                .is_err()
            {
                still_pending.insert(name.clone());
            }
        }
        if still_pending != pending {
            pending = still_pending;
            save(&home, PENDING_DELETES_FILE, &pending)?;
        }

        // 2. 寄出：每台别的设备还没有的那些钥匙。
        let mut ledger: SentLedger = load(&home, SENT_FILE);
        let mut ledger_changed = false;
        for peer in &snapshot.peers {
            let sent = ledger.sent.entry(peer.device_id.to_string()).or_default();
            for (name, secret_hex) in &snapshot.secrets {
                if sent.contains(name) || pending.contains(name) {
                    continue;
                }
                // 寄出的是本机存放时的原样（十六进制文本），对方原样存放。
                let sealed = seal_for_device(snapshot.agent_id, peer, name, secret_hex.as_bytes())?;
                if rt
                    .block_on(client.put_sealed_key(
                        snapshot.agent_id,
                        peer.device_id,
                        name,
                        &sealed,
                    ))
                    .is_ok()
                {
                    sent.insert(name.clone());
                    ledger_changed = true;
                }
            }
        }
        if ledger_changed {
            save(&home, SENT_FILE, &ledger)?;
        }

        // 3. 取回：寄给本机、本机还没有的钥匙。
        let incoming =
            rt.block_on(client.list_sealed_keys(snapshot.agent_id, snapshot.device.device_id()))?;
        let mut outcome = KeyExchange::default();
        if incoming.is_empty() {
            return Ok(outcome);
        }
        let mut guard = self
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("守护进程状态锁中毒"),
            })?;
        let erased: BTreeSet<String> = journal::erased_entries(guard.kernel.spine())?
            .into_iter()
            .map(|(layer, id)| entry_key_blob_name(layer, &id))
            .collect();
        for (name, sealed) in incoming {
            if let Some(epoch) = name.strip_prefix(EPOCH_KEY_PREFIX) {
                let Ok(epoch) = epoch.parse::<u64>() else {
                    continue;
                };
                if guard
                    .kernel
                    .spine()
                    .epoch_ring()
                    .epoch_key(Epoch::new(epoch))
                    .is_some()
                {
                    continue;
                }
                let Ok(raw) = open_for_device(snapshot.agent_id, &snapshot.device, &name, &sealed)
                else {
                    continue;
                };
                let Ok(bytes) = quetzalcoatl_crypto::hex_decode_fixed::<32>(
                    "epoch_key",
                    &String::from_utf8_lossy(&raw),
                ) else {
                    continue;
                };
                guard
                    .kernel
                    .spine_mut()
                    .epoch_ring_mut()
                    .insert_epoch_key(Epoch::new(epoch), EpochKey::from_bytes(bytes));
                outcome.received_epoch_keys += 1;
                continue;
            }
            // 已经抹除的条目：钥匙不收。
            if erased.contains(&name) {
                continue;
            }
            if guard
                .kernel
                .spine()
                .store()
                .get_private_blob(&name)?
                .is_some()
            {
                continue;
            }
            let Ok(raw) = open_for_device(snapshot.agent_id, &snapshot.device, &name, &sealed)
            else {
                continue;
            };
            let hex = String::from_utf8(raw).unwrap_or_default();
            if hex.is_empty() {
                continue;
            }
            guard
                .kernel
                .spine_mut()
                .store_mut()
                .put_private_blob(&name, &hex)?;
            outcome.received_entry_keys += 1;
        }
        if outcome.received_epoch_keys > 0 {
            let ring = guard.kernel.spine().epoch_ring().clone();
            let local = guard.kernel.spine().local_device().device_id();
            crate::fabric::persist_membership(&home, &ring, local)?;
        }
        Ok(outcome)
    }

    /// 别的设备的变更合进来之后：由事件重放出良知；对方抹除过的，本机也销毁钥匙与正文。
    pub(crate) fn resync_sea_from_spine(&self) -> Result<bool> {
        let home = self.config.quetzalcoatl_home.clone();
        let mut guard = self
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("守护进程状态锁中毒"),
            })?;
        // 先销毁被抹除条目的钥匙，重放时它们就读不出来。
        for (layer, id) in journal::erased_entries(guard.kernel.spine())? {
            let name = entry_key_blob_name(layer, &id);
            let store = guard.kernel.spine_mut().store_mut();
            if store.get_private_blob(&name)?.is_some() {
                store.delete_private_blob(&name)?;
                store.delete_memory(&id)?;
            }
        }
        let Some(replayed) = journal::replay(guard.kernel.spine_mut())? else {
            return Ok(false);
        };
        if replayed == guard.conscience {
            return Ok(false);
        }
        replayed.verify_signature_and_hashes()?;
        let now_ms = now_unix_ms();
        // 检索索引补上新来的往事，抹掉已经不在的。
        let present: BTreeSet<String> = replayed.memories.iter().map(|m| m.id.clone()).collect();
        let gone: Vec<String> = guard
            .conscience
            .memories
            .iter()
            .filter(|m| !present.contains(&m.id))
            .map(|m| m.id.clone())
            .collect();
        for id in gone {
            let _ = guard.graph.redact_entry(&id, now_ms);
        }
        for memory in replayed
            .memories
            .iter()
            .filter(|m| m.invalid_at_ms.is_none())
        {
            if !guard.graph.has(&memory.id) {
                let _ = guard.graph.observe(
                    serde_json::json!({"memory_id": memory.id}),
                    quetzalcoatl_ewave::ObserveOptions {
                        id: Some(memory.id.clone()),
                        text: Some(memory.content.clone()),
                        at: Some(memory.valid_from_ms),
                        ..Default::default()
                    },
                );
            }
        }
        guard.conscience = replayed;
        let _ = fs::remove_file(home.join(crate::pair_adopt::ADOPTING_MARKER));
        let crate::daemon::DaemonMutableState {
            ref mut persisted,
            ref graph,
            ..
        } = *guard;
        let _ = crate::daemon::save_graph_snapshot(&home, persisted, graph);
        Ok(true)
    }
}
