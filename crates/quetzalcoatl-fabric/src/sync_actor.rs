#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `SpineSyncActor` — 密文 `SealedPackfile` 的 `iroh` P2P 直连同步与 `quetzalcoatl-hub` 错峰异步同步器。

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;

use iroh::EndpointAddr;
use quetzalcoatl_crypto::SealedPackfile;
use quetzalcoatl_kernel::BlindKernel;
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{AgentId, ArtifactId, DeviceId, Epoch, QuetzalcoatlError, Result};

use crate::endpoint::{FabricNode, FabricRpcRequest, FabricRpcResponse, HubClient};

/// Packfile 同步统计报告。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub uploaded_packs: usize,
    pub downloaded_packs: usize,
    pub ingested_events: usize,
    pub rehydrated_runs: usize,
    pub new_hub_cursor_seq: u64,
}

/// 增量拉取远端 `SealedPackfile` 批次的异步结果（`(next_cursor, packs)`）。
pub type PackfileBatchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(u64, Vec<SealedPackfile>)>> + Send + 'a>>;

/// 异步 Packfile 远端暂存后端抽象（生产绑定 `HubClient`，混沌仿真可挂载带故障注入的零知识 Hub）。
pub trait SpineSyncBackend: Send + Sync {
    fn upload_pack<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        pack: &'a SealedPackfile,
    ) -> Pin<Box<dyn Future<Output = Result<u64>> + Send + 'a>>;

    fn fetch_packs_after<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        after_seq: u64,
    ) -> PackfileBatchFuture<'a>;
}

impl SpineSyncBackend for HubClient {
    fn upload_pack<'a>(
        &'a self,
        agent_id: AgentId,
        _device_id: DeviceId,
        pack: &'a SealedPackfile,
    ) -> Pin<Box<dyn Future<Output = Result<u64>> + Send + 'a>> {
        Box::pin(async move { self.upload_packfile(agent_id, pack).await })
    }

    fn fetch_packs_after<'a>(
        &'a self,
        agent_id: AgentId,
        _device_id: DeviceId,
        after_seq: u64,
    ) -> Pin<Box<dyn Future<Output = Result<(u64, Vec<SealedPackfile>)>> + Send + 'a>> {
        Box::pin(async move {
            self.list_and_download_packfiles(agent_id, after_seq, 200)
                .await
        })
    }
}

/// 状态脊柱双模同步器。
pub struct SpineSyncActor {
    hub_cursor_seq: u64,
    uploaded_pack_ids: BTreeSet<ArtifactId>,
}

impl Default for SpineSyncActor {
    fn default() -> Self {
        Self::new()
    }
}

impl SpineSyncActor {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            hub_cursor_seq: 0,
            uploaded_pack_ids: BTreeSet::new(),
        }
    }

    #[must_use]
    pub const fn hub_cursor_seq(&self) -> u64 {
        self.hub_cursor_seq
    }

    pub fn mark_pack_uploaded(&mut self, pack_id: ArtifactId) {
        self.uploaded_pack_ids.insert(pack_id);
    }

    /// 经由零知识 `quetzalcoatl-hub` 执行双向错峰同步（先上传本机新增密文 Packfile，再按 `server_seq` 游标增量拉取远端 Packfile 解密重水合）。
    pub async fn sync_via_hub<S: MaterializedStore>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        hub: &dyn SpineSyncBackend,
        local_trusted_wall_ms: u64,
    ) -> Result<SyncReport> {
        let agent_id = kernel.spine().agent_id();
        let local_dev_id = kernel.spine().local_device().device_id();

        let local_packs = kernel.spine().store().list_packfiles()?;
        let mut existing_ids: BTreeSet<ArtifactId> =
            local_packs.iter().map(|p| p.pack_id).collect();

        let mut uploaded_packs = 0usize;
        for pack in &local_packs {
            if pack.aad.device_id == local_dev_id && !self.uploaded_pack_ids.contains(&pack.pack_id)
            {
                let _ = hub.upload_pack(agent_id, local_dev_id, pack).await?;
                self.uploaded_pack_ids.insert(pack.pack_id);
                uploaded_packs = uploaded_packs.saturating_add(1);
            }
        }

        let (next_cursor, remote_packs) = hub
            .fetch_packs_after(agent_id, local_dev_id, self.hub_cursor_seq)
            .await?;

        let mut to_ingest = Vec::new();
        for rp in remote_packs {
            if !existing_ids.contains(&rp.pack_id) && rp.aad.device_id != local_dev_id {
                existing_ids.insert(rp.pack_id);
                to_ingest.push(rp);
            }
        }

        let downloaded_packs = to_ingest.len();
        let (ingested_events, rehydrated_runs) = if to_ingest.is_empty() {
            (0, 0)
        } else {
            Self::ingest_packfiles_and_rehydrate(kernel, &to_ingest, local_trusted_wall_ms)?
        };

        self.hub_cursor_seq = next_cursor;
        Ok(SyncReport {
            uploaded_packs,
            downloaded_packs,
            ingested_events,
            rehydrated_runs,
            new_hub_cursor_seq: self.hub_cursor_seq,
        })
    }

    /// 经由 `iroh` 直连流与在线对等节点双向同步 `SealedPackfile`。
    pub async fn sync_with_peer<S: MaterializedStore>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        fabric: &FabricNode,
        peer_addr: EndpointAddr,
        local_trusted_wall_ms: u64,
    ) -> Result<SyncReport> {
        let agent_id = kernel.spine().agent_id();
        let local_dev_id = kernel.spine().local_device().device_id();
        let local_packs: Vec<SealedPackfile> = kernel
            .spine()
            .store()
            .list_packfiles()?
            .into_iter()
            .filter(|p| p.aad.device_id == local_dev_id)
            .collect();

        let mut uploaded_packs = 0usize;
        if !local_packs.is_empty() {
            let push_resp = fabric
                .send_rpc(
                    peer_addr.clone(),
                    &FabricRpcRequest::PushPackfiles {
                        agent_id,
                        sender_device_id: local_dev_id,
                        packs: local_packs.clone(),
                    },
                )
                .await?;
            if let FabricRpcResponse::Error { detail, .. } = push_resp {
                return Err(QuetzalcoatlError::StorageError { detail });
            }
            uploaded_packs = local_packs.len();
        }

        let mut known_heads = Vec::new();
        for &dev_id in kernel.spine().epoch_ring().active_devices().keys() {
            let seq = kernel
                .spine()
                .store()
                .device_chain_head(dev_id)?
                .map(|(s, _)| s)
                .unwrap_or(0);
            known_heads.push((dev_id, seq));
        }

        let pull_resp = fabric
            .send_rpc(
                peer_addr,
                &FabricRpcRequest::PullPackfiles {
                    agent_id,
                    sender_device_id: local_dev_id,
                    known_heads,
                },
            )
            .await?;

        let pulled_packs = match pull_resp {
            FabricRpcResponse::PackfilesBatch { packs } => packs,
            FabricRpcResponse::Error { detail, .. } => {
                return Err(QuetzalcoatlError::StorageError { detail });
            }
            other => {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: format!("unexpected PullPackfiles response: {other:?}"),
                });
            }
        };

        let downloaded_packs = pulled_packs.len();
        let (ingested_events, rehydrated_runs) = if pulled_packs.is_empty() {
            (0, 0)
        } else {
            Self::ingest_packfiles_and_rehydrate(kernel, &pulled_packs, local_trusted_wall_ms)?
        };

        Ok(SyncReport {
            uploaded_packs,
            downloaded_packs,
            ingested_events,
            rehydrated_runs,
            new_hub_cursor_seq: self.hub_cursor_seq,
        })
    }

    /// 校验、解密并按单写者链序批量合入远端 `SealedPackfile`，随后触发 `BlindKernel::rehydrate_from_spine()`。
    pub fn ingest_packfiles_and_rehydrate<S: MaterializedStore>(
        kernel: &mut BlindKernel<S>,
        packs: &[SealedPackfile],
        local_trusted_wall_ms: u64,
    ) -> Result<(usize, usize)> {
        if packs.is_empty() {
            return Ok((0, 0));
        }

        let mut grouped = BTreeMap::<(DeviceId, Epoch), Vec<SealedPackfile>>::new();
        for p in packs {
            grouped
                .entry((p.aad.device_id, Epoch::new(p.aad.epoch)))
                .or_default()
                .push(p.clone());
        }

        let mut total_events = 0usize;
        for ((sender_dev, epoch), mut group_packs) in grouped {
            group_packs.sort_by_key(|p| (p.aad.first_seq, p.aad.last_seq));

            let epoch_key = kernel
                .spine()
                .epoch_ring()
                .epoch_key(epoch)
                .cloned()
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: format!("缺少解密远端 Packfile 所需的 EpochKey[{}]", epoch.get()),
                })?;

            let sender_pk = if let Some(pk) =
                kernel.spine().epoch_ring().active_device_pubkey(sender_dev)
            {
                *pk
            } else if let Some(stored_pk) = kernel.spine().store().get_device_pubkey(sender_dev)? {
                stored_pk
            } else {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: format!("拒绝合入未知或未授权设备 {sender_dev} 的 Packfile"),
                });
            };

            let events = kernel.spine_mut().ingest_remote_packfiles(
                &group_packs,
                &epoch_key,
                &sender_pk,
                local_trusted_wall_ms,
            )?;
            total_events = total_events.saturating_add(events.len());
        }

        let rehydrated_runs = kernel.rehydrate_from_spine()?;
        Ok((total_events, rehydrated_runs))
    }
}
