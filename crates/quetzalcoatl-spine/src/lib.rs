#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-spine` — Quetzalcoatl V2 单主权签名 HLC 事件脊柱、SQLite WAL 物化视图、
//! 可读 Markdown + `.quetzalcoatl-spine/` 双模 ZIP 归档包与 `import-v1` 单向幂等迁移引擎。

pub mod archive;
pub mod import_v1;
pub mod ledger;
pub mod store;

pub use archive::{ZipExportOptions, export_zip_archive, import_zip_archive};
pub use import_v1::{V1ImportReport, run_import_v1};
pub use ledger::{
    AUTO_PACK_EVENT_THRESHOLD, SpineCheckpoint, SpineEvent, SpineEventHeader, compute_event_blake3,
    encode_events_jsonl, parse_events_jsonl,
};
pub use store::{
    MaterializedMemory, MaterializedMessage, MaterializedRun, MaterializedStore,
    MaterializedThread, RusqliteWalStore, SpineEventHead,
};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::{
    DeviceIdentity, EpochKey, EpochKeyRing, PackCompartment, SealedPackfile, open_packfile,
    seal_packfile,
};
use quetzalcoatl_types::{
    AgentId, ArtifactId, DeviceId, HlcTimestamp, QuetzalcoatlError, Result, RunId,
};

const CHECKPOINT_DOMAIN_CONTEXT: &str = "quetzalcoatl/v2/spine-checkpoint-v1";

/// 单主权签名 HLC 状态脊柱核心引擎。
pub struct SpineEngine<S: MaterializedStore> {
    agent_id: AgentId,
    local_device: DeviceIdentity,
    epoch_ring: EpochKeyRing,
    hlc: HlcTimestamp,
    store: S,
    auto_pack_threshold: usize,
}

impl<S: MaterializedStore> SpineEngine<S> {
    pub fn new(
        agent_id: AgentId,
        local_device: DeviceIdentity,
        epoch_ring: EpochKeyRing,
        initial_hlc: HlcTimestamp,
        mut store: S,
    ) -> Result<Self> {
        if epoch_ring.agent_id() != agent_id {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("EpochKeyRing agent_id 与 SpineEngine agent_id 不匹配"),
            });
        }
        store
            .register_device_pubkey(local_device.device_id(), local_device.ed25519_public_key())?;
        Ok(Self {
            agent_id,
            local_device,
            epoch_ring,
            hlc: initial_hlc,
            store,
            auto_pack_threshold: AUTO_PACK_EVENT_THRESHOLD,
        })
    }

    #[must_use]
    pub const fn agent_id(&self) -> AgentId {
        self.agent_id
    }

    #[must_use]
    pub const fn local_hlc(&self) -> HlcTimestamp {
        self.hlc
    }

    #[must_use]
    pub const fn local_device(&self) -> &DeviceIdentity {
        &self.local_device
    }

    #[must_use]
    pub const fn epoch_ring(&self) -> &EpochKeyRing {
        &self.epoch_ring
    }

    pub fn epoch_ring_mut(&mut self) -> &mut EpochKeyRing {
        &mut self.epoch_ring
    }

    #[must_use]
    pub const fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    pub fn set_auto_pack_threshold(&mut self, threshold: usize) {
        self.auto_pack_threshold = threshold.max(1);
    }

    fn seal_compartment_if_nonempty(
        &mut self,
        compartment: PackCompartment,
    ) -> Result<Option<SealedPackfile>> {
        let dev_id = self.local_device.device_id();
        let unpacked = self.store.list_unpacked_events(dev_id, compartment)?;
        let Some(first) = unpacked.first() else {
            return Ok(None);
        };
        let Some(last) = unpacked.last() else {
            return Ok(None);
        };

        let first_seq = first.header.seq;
        let last_seq = last.header.seq;
        let mut min_hlc = first.header.hlc;
        let mut max_hlc = first.header.hlc;
        for ev in &unpacked {
            if ev.header.hlc < min_hlc {
                min_hlc = ev.header.hlc;
            }
            if ev.header.hlc > max_hlc {
                max_hlc = ev.header.hlc;
            }
        }

        let epoch = self.epoch_ring.current_epoch();
        let epoch_key = self
            .epoch_ring
            .current_epoch_key()
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: String::from("当前 EpochKeyRing 未加载活跃纪元对称密钥"),
            })?
            .clone();

        let jsonl = encode_events_jsonl(&unpacked)?;
        let pack = seal_packfile(
            self.agent_id,
            dev_id,
            compartment,
            epoch,
            &epoch_key,
            first_seq,
            last_seq,
            min_hlc,
            max_hlc,
            jsonl.as_bytes(),
        )?;

        self.store.put_packfile(&pack)?;
        self.store
            .mark_events_packed(dev_id, compartment, first_seq, last_seq, pack.pack_id)?;
        Ok(Some(pack))
    }

    /// 本机单写者追加签名事件；当同一隔离域未封包事件数达到 `auto_pack_threshold`（默认 500）时自动封包。
    pub fn append_event(
        &mut self,
        compartment: PackCompartment,
        payload_utf8: &str,
        local_wall_ms: u64,
    ) -> Result<SpineEvent> {
        let dev_id = self.local_device.device_id();
        if !self.epoch_ring.is_device_active(dev_id) {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("本机设备 {dev_id} 未处于激活授权状态"),
            });
        }

        let next_hlc = self.hlc.tick(local_wall_ms, dev_id.hlc_node_tag())?;
        let (next_seq, prev_blake3) = match self.store.device_chain_head(dev_id)? {
            Some((last_seq, last_b3)) => {
                let s = last_seq.checked_add(1).ok_or_else(|| {
                    QuetzalcoatlError::IntegrityViolation {
                        detail: String::from("单设备事件序号 u64 递增溢出"),
                    }
                })?;
                (s, last_b3)
            }
            None => (1, ArtifactId::ZERO),
        };

        let epoch = self.epoch_ring.current_epoch();
        let event = SpineEvent::sign_new(
            self.agent_id,
            &self.local_device,
            epoch,
            next_seq,
            prev_blake3,
            next_hlc,
            payload_utf8,
        )?;

        self.store.append_spine_event(&event, compartment)?;
        self.hlc = next_hlc;

        let unpacked_len = self.store.list_unpacked_events(dev_id, compartment)?.len();
        if unpacked_len >= self.auto_pack_threshold {
            let _ = self.seal_compartment_if_nonempty(compartment)?;
        }

        Ok(event)
    }

    /// 校验并合入远端单写者签名事件：
    /// 1. 优先执行 `+5m` 未来时钟投毒拦截（超限立即返回 `ClockDriftExceeded` 且绝不推高本机 HLC）；
    /// 2. 校验 Ed25519 签名、`AgentId` 与单设备连续哈希链 `(seq, prev_blake3)`。
    pub fn ingest_remote_event(
        &mut self,
        event: SpineEvent,
        compartment: PackCompartment,
        sender_ed25519_pubkey: &[u8; 32],
        local_trusted_wall_ms: u64,
    ) -> Result<()> {
        // 防坑规范 #10：先校验远端物理时钟漂移，超 +5m 直接隔离拒收，绝不污染本机 HLC！
        event.header.hlc.validate_drift(local_trusted_wall_ms)?;

        if event.header.agent_id != self.agent_id {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "远端事件 AgentId ({}) 与本脊柱 ({}) 不一致",
                    event.header.agent_id, self.agent_id
                ),
            });
        }

        event.verify(sender_ed25519_pubkey)?;

        let sender_dev = event.header.device_id;
        match self.store.device_chain_head(sender_dev)? {
            None => {
                if event.header.seq != 1 || event.header.prev_blake3 != ArtifactId::ZERO {
                    return Err(QuetzalcoatlError::IntegrityViolation {
                        detail: format!(
                            "远端设备 {} 缺失前序事件：期望 seq=1，实际 seq={}",
                            sender_dev, event.header.seq
                        ),
                    });
                }
            }
            Some((last_seq, last_b3)) => {
                if event.header.seq <= last_seq {
                    let existing = self.store.list_device_events(sender_dev)?;
                    if let Some(found) = existing.iter().find(|e| e.header.seq == event.header.seq)
                    {
                        if found.event_blake3 == event.event_blake3 {
                            return Ok(());
                        }
                        return Err(QuetzalcoatlError::IntegrityViolation {
                            detail: format!(
                                "检测到远端设备 {} 在 seq={} 处发生双签分叉",
                                sender_dev, event.header.seq
                            ),
                        });
                    }
                }
                let expected_seq = last_seq.saturating_add(1);
                if event.header.seq != expected_seq || event.header.prev_blake3 != last_b3 {
                    return Err(QuetzalcoatlError::IntegrityViolation {
                        detail: format!(
                            "远端设备 {} 哈希链断裂：期望 seq={expected_seq}/prev={last_b3}，实际 seq={}/prev={}",
                            sender_dev, event.header.seq, event.header.prev_blake3
                        ),
                    });
                }
            }
        }

        let next_local_hlc = self.hlc.observe_remote(
            event.header.hlc,
            local_trusted_wall_ms,
            self.local_device.device_id().hlc_node_tag(),
        )?;

        self.store
            .register_device_pubkey(sender_dev, sender_ed25519_pubkey)?;
        self.store.append_spine_event(&event, compartment)?;
        self.hlc = next_local_hlc;
        Ok(())
    }

    /// 内部共享原子批次合入管线：
    /// 1. 每个 `SealedPackfile` 仅解密解压一次；
    /// 2. 跨分舱（`Core` / `ExternalChannel`）按 `(device_id, seq)` 全局排序并完整预检哈希链连续性、签名与 `+5m` HLC 漂移；
    /// 3. 先在内存模拟推进 `next_hlc`，确保任何错误均不污染本机 `self.hlc` 或 SQLite；
    /// 4. 通过单事务 `commit_verified_event_batch` 原子落库并精确记录每条已封包事件的 `pack_id`。
    pub(crate) fn ingest_verified_batch(
        &mut self,
        pack_inputs: &[(&SealedPackfile, &EpochKey, &[u8; 32])],
        tail_events: &[(SpineEvent, PackCompartment, [u8; 32])],
        local_trusted_wall_ms: u64,
    ) -> Result<Vec<SpineEvent>> {
        type StagedEntry = (SpineEvent, PackCompartment, Option<ArtifactId>, [u8; 32]);
        let mut by_device = BTreeMap::<DeviceId, BTreeMap<u64, StagedEntry>>::new();
        let mut device_pubkeys_map = BTreeMap::<DeviceId, [u8; 32]>::new();
        let mut packs_to_store = Vec::<SealedPackfile>::with_capacity(pack_inputs.len());

        for &(pack, epoch_key, sender_pk) in pack_inputs {
            if pack.aad.agent_id != self.agent_id {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("远端 Packfile AAD agent_id 不匹配"),
                });
            }
            let plain = open_packfile(pack, epoch_key)?;
            let jsonl =
                std::str::from_utf8(&plain).map_err(|e| QuetzalcoatlError::SerializationError {
                    detail: format!("远端 Packfile 解压内容不是合法 UTF-8: {e}"),
                })?;
            let events = parse_events_jsonl(jsonl)?;
            let first_ev = events
                .first()
                .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("拒绝空事件列表的 Packfile"),
                })?;
            let last_ev = events
                .last()
                .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("拒绝空事件列表的 Packfile"),
                })?;
            if first_ev.header.seq != pack.aad.first_seq || last_ev.header.seq != pack.aad.last_seq
            {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: String::from(
                        "Packfile 内首尾事件 seq 与 AAD first_seq/last_seq 不一致",
                    ),
                });
            }

            let mut actual_min_hlc = first_ev.header.hlc;
            let mut actual_max_hlc = first_ev.header.hlc;
            let mut prev_seq_in_pack = 0u64;
            for ev in events {
                if ev.header.agent_id != self.agent_id
                    || ev.header.device_id != pack.aad.device_id
                    || ev.header.epoch != pack.aad.epoch
                {
                    return Err(QuetzalcoatlError::IntegrityViolation {
                        detail: String::from(
                            "Packfile 内事件 agent_id/device_id/epoch 与 AAD 不一致",
                        ),
                    });
                }
                if ev.header.seq <= prev_seq_in_pack {
                    return Err(QuetzalcoatlError::IntegrityViolation {
                        detail: String::from("Packfile 内事件序号必须严格单调递增"),
                    });
                }
                prev_seq_in_pack = ev.header.seq;
                if ev.header.hlc < actual_min_hlc {
                    actual_min_hlc = ev.header.hlc;
                }
                if ev.header.hlc > actual_max_hlc {
                    actual_max_hlc = ev.header.hlc;
                }
                ev.header.hlc.validate_drift(local_trusted_wall_ms)?;
                ev.verify(sender_pk)?;

                device_pubkeys_map.insert(ev.header.device_id, *sender_pk);
                let seq_map = by_device.entry(ev.header.device_id).or_default();
                if let Some((existing, _, _, _)) = seq_map.get(&ev.header.seq)
                    && existing.event_blake3 != ev.event_blake3
                {
                    return Err(QuetzalcoatlError::IntegrityViolation {
                        detail: format!(
                            "同一批次中检测到设备 {} seq={} 双签分叉",
                            ev.header.device_id, ev.header.seq
                        ),
                    });
                }
                seq_map.insert(
                    ev.header.seq,
                    (ev, pack.aad.compartment, Some(pack.pack_id), *sender_pk),
                );
            }

            if actual_min_hlc != pack.aad.min_hlc || actual_max_hlc != pack.aad.max_hlc {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("Packfile 内事件 HLC 极值与 AAD min_hlc/max_hlc 不一致"),
                });
            }
            packs_to_store.push(pack.clone());
        }

        for (ev, comp, sender_pk) in tail_events {
            if ev.header.agent_id != self.agent_id {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("尾部事件 agent_id 与目标脊柱不一致"),
                });
            }
            ev.header.hlc.validate_drift(local_trusted_wall_ms)?;
            ev.verify(sender_pk)?;
            device_pubkeys_map.insert(ev.header.device_id, *sender_pk);
            let seq_map = by_device.entry(ev.header.device_id).or_default();
            if let Some((existing, _, _, _)) = seq_map.get(&ev.header.seq) {
                if existing.event_blake3 != ev.event_blake3 {
                    return Err(QuetzalcoatlError::IntegrityViolation {
                        detail: format!(
                            "尾部事件与已封包事件在设备 {} seq={} 处发生分叉",
                            ev.header.device_id, ev.header.seq
                        ),
                    });
                }
            } else {
                seq_map.insert(ev.header.seq, (ev.clone(), *comp, None, *sender_pk));
            }
        }

        // 在写入 SQLite 或更新本机 HLC 之前，完整校验每台设备的单写者连续哈希链！
        let mut verified_commits = Vec::<(SpineEvent, PackCompartment, Option<ArtifactId>)>::new();
        let mut returned_events = Vec::<SpineEvent>::new();
        let mut simulated_hlc = self.hlc;
        let local_tag = self.local_device.device_id().hlc_node_tag();

        for (dev_id, seq_map) in by_device {
            let existing_events = self.store.list_device_events(dev_id)?;
            let existing_by_seq: BTreeMap<u64, &SpineEvent> =
                existing_events.iter().map(|e| (e.header.seq, e)).collect();
            let mut running_head: Option<(u64, ArtifactId)> = existing_events
                .last()
                .map(|last| (last.header.seq, last.event_blake3));

            for (seq, (ev, comp, opt_pack_id, _pk)) in seq_map {
                if let Some(&already) = existing_by_seq.get(&seq) {
                    if already.event_blake3 != ev.event_blake3 {
                        return Err(QuetzalcoatlError::IntegrityViolation {
                            detail: format!("远端设备 {dev_id} 在 seq={seq} 处与本地已有事件分叉"),
                        });
                    }
                    if opt_pack_id.is_some() {
                        verified_commits.push((ev.clone(), comp, opt_pack_id));
                    }
                    returned_events.push(ev);
                    continue;
                }

                match running_head {
                    None => {
                        if seq != 1 || ev.header.prev_blake3 != ArtifactId::ZERO {
                            return Err(QuetzalcoatlError::IntegrityViolation {
                                detail: format!(
                                    "远端设备 {dev_id} 首条事件必须为 seq=1 且 prev_blake3=0，实际 seq={seq}"
                                ),
                            });
                        }
                    }
                    Some((last_seq, last_b3)) => {
                        let expected_seq = last_seq.saturating_add(1);
                        if seq != expected_seq || ev.header.prev_blake3 != last_b3 {
                            return Err(QuetzalcoatlError::IntegrityViolation {
                                detail: format!(
                                    "远端设备 {dev_id} 批次内哈希链断裂：期望 seq={expected_seq}/prev={last_b3}，实际 seq={seq}/prev={}",
                                    ev.header.prev_blake3
                                ),
                            });
                        }
                    }
                }

                simulated_hlc = simulated_hlc.observe_remote(
                    ev.header.hlc,
                    local_trusted_wall_ms,
                    local_tag,
                )?;
                running_head = Some((seq, ev.event_blake3));
                returned_events.push(ev.clone());
                verified_commits.push((ev, comp, opt_pack_id));
            }
        }

        let pubkey_list: Vec<(DeviceId, [u8; 32])> = device_pubkeys_map.into_iter().collect();
        self.store
            .commit_verified_event_batch(&pubkey_list, &verified_commits, &packs_to_store)?;
        self.hlc = simulated_hlc;
        Ok(returned_events)
    }

    /// 校验并原子合入远端加密 Packfile（任一字节篡改、哈希链断裂或时钟超限均整包拒收、零脏写）。
    pub fn ingest_remote_packfile(
        &mut self,
        pack: &SealedPackfile,
        epoch_key: &EpochKey,
        sender_ed25519_pubkey: &[u8; 32],
        local_trusted_wall_ms: u64,
    ) -> Result<Vec<SpineEvent>> {
        self.ingest_remote_packfiles(
            std::slice::from_ref(pack),
            epoch_key,
            sender_ed25519_pubkey,
            local_trusted_wall_ms,
        )
    }

    /// 原子批量合入远端多个 Packfiles（支持跨 `Core` / `ExternalChannel` 分舱交错序号排序验链）。
    pub fn ingest_remote_packfiles(
        &mut self,
        packs: &[SealedPackfile],
        epoch_key: &EpochKey,
        sender_ed25519_pubkey: &[u8; 32],
        local_trusted_wall_ms: u64,
    ) -> Result<Vec<SpineEvent>> {
        if packs.is_empty() {
            return Ok(Vec::new());
        }
        let inputs: Vec<(&SealedPackfile, &EpochKey, &[u8; 32])> = packs
            .iter()
            .map(|p| (p, epoch_key, sender_ed25519_pubkey))
            .collect();
        self.ingest_verified_batch(&inputs, &[], local_trusted_wall_ms)
    }

    /// 显式封存检查点（例如 `Commit Run` 结项或设备主动挂起移交前）：
    /// 将 `Core` 与 `ExternalChannel` 未封包事件分别密封为物理隔离的加密 Packfiles。
    pub fn seal_checkpoint(
        &mut self,
        run_id: Option<RunId>,
        local_wall_ms: u64,
    ) -> Result<Vec<SealedPackfile>> {
        let mut sealed = Vec::new();
        if let Some(core_pack) = self.seal_compartment_if_nonempty(PackCompartment::Core)? {
            sealed.push(core_pack);
        }
        if let Some(ext_pack) =
            self.seal_compartment_if_nonempty(PackCompartment::ExternalChannel)?
        {
            sealed.push(ext_pack);
        }

        let dev_id = self.local_device.device_id();
        let cp_hlc = self.hlc.tick(local_wall_ms, dev_id.hlc_node_tag())?;
        self.hlc = cp_hlc;

        let (last_seq, last_event_blake3) = self
            .store
            .device_chain_head(dev_id)?
            .unwrap_or((0, ArtifactId::ZERO));
        let pack_ids: Vec<ArtifactId> = sealed.iter().map(|p| p.pack_id).collect();

        let mut hasher = blake3::Hasher::new_derive_key(CHECKPOINT_DOMAIN_CONTEXT);
        hasher.update(self.agent_id.as_bytes());
        hasher.update(dev_id.as_bytes());
        hasher.update(&cp_hlc.to_be_bytes());
        hasher.update(&last_seq.to_be_bytes());
        hasher.update(last_event_blake3.as_bytes());
        for pid in &pack_ids {
            hasher.update(pid.as_bytes());
        }
        let checkpoint_id = ArtifactId::from_bytes(*hasher.finalize().as_bytes());

        let checkpoint = SpineCheckpoint {
            checkpoint_id,
            agent_id: self.agent_id,
            device_id: dev_id,
            epoch: self.epoch_ring.current_epoch(),
            hlc: cp_hlc,
            last_seq,
            last_event_blake3,
            run_id,
            pack_ids,
        };
        self.store.put_checkpoint(&checkpoint)?;
        Ok(sealed)
    }

    pub fn export_zip(&self, zip_path: &Path, options: ZipExportOptions) -> Result<()> {
        export_zip_archive(self, zip_path, options)
    }

    pub fn import_zip(&mut self, zip_path: &Path, local_trusted_wall_ms: u64) -> Result<usize> {
        import_zip_archive(self, zip_path, local_trusted_wall_ms)
    }

    pub fn import_v1(
        &mut self,
        soul_dir: &Path,
        db_paths: &[PathBuf],
        local_wall_ms: u64,
    ) -> Result<V1ImportReport> {
        run_import_v1(self, soul_dir, db_paths, local_wall_ms)
    }
}
