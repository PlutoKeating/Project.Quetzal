#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `RemoteWorkerPool` — 在线节点能力签名广播与跨机器异构 Harness + 洁净室 `Verifier` 调度池。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use iroh::{EndpointAddr, EndpointId};
use quetzalcoatl_crypto::{
    DeviceIdentity, EpochKeyRing, SealedPackfile, hex_decode_fixed, hex_encode,
    verify_ed25519_signature,
};
use quetzalcoatl_kernel::{
    ArtifactEntryKind, BlindKernel, CapabilityInvocation, CapabilitySet, CleanRoomVerifierDag,
    PrincipalRole, ScopeChain, VerificationMark, compute_workspace_tree_manifest,
};
use quetzalcoatl_sandbox::{NetworkPolicy, SandboxCommand, SandboxMode, TicketRequest};
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{AgentId, ArtifactId, DeviceId, QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::endpoint::{FabricNode, FabricRpcRequest, FabricRpcResponse, PeerPathKind};

const CAPABILITY_SIGN_DOMAIN: &str = "quetzalcoatl/v2/fabric-capability-announcement-v1";

/// 本机可广播的静态算力与 Harness 能力描述。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeCapabilitySpec {
    pub os: String,
    pub arch: String,
    pub available_harnesses: Vec<String>,
    pub capability_tags: BTreeSet<String>,
    pub sandbox_available: bool,
    pub max_workers: u32,
}

/// 在线节点向 `Router` 广播的 Ed25519 签名能力通告。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeCapabilityAnnouncement {
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub endpoint_id_hex: String,
    pub os: String,
    pub arch: String,
    pub available_harnesses: Vec<String>,
    pub capability_tags: BTreeSet<String>,
    pub sandbox_available: bool,
    pub active_workers: u32,
    pub max_workers: u32,
    pub announced_at_ms: u64,
    pub signature_hex: String,
}

impl NodeCapabilityAnnouncement {
    fn signing_digest(&self) -> Result<[u8; 32]> {
        let mut sorted_harnesses = self.available_harnesses.clone();
        sorted_harnesses.sort();
        let tags_vec: Vec<&String> = self.capability_tags.iter().collect();
        let canonical = serde_json::json!({
            "active_workers": self.active_workers,
            "agent_id": self.agent_id.to_string(),
            "announced_at_ms": self.announced_at_ms,
            "arch": self.arch,
            "available_harnesses": sorted_harnesses,
            "capability_tags": tags_vec,
            "device_id": self.device_id.to_string(),
            "endpoint_id_hex": self.endpoint_id_hex.to_ascii_lowercase(),
            "max_workers": self.max_workers,
            "os": self.os,
            "sandbox_available": self.sandbox_available,
        });
        let encoded =
            serde_json::to_vec(&canonical).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("序列化能力通告签名摘要失败: {e}"),
            })?;
        Ok(blake3::derive_key(CAPABILITY_SIGN_DOMAIN, &encoded))
    }

    pub fn sign_new(
        agent_id: AgentId,
        device: &DeviceIdentity,
        spec: &NodeCapabilitySpec,
        active_workers: u32,
        announced_at_ms: u64,
    ) -> Result<Self> {
        let endpoint_id_hex = hex_encode(device.ed25519_public_key());
        let mut draft = Self {
            agent_id,
            device_id: device.device_id(),
            endpoint_id_hex,
            os: spec.os.clone(),
            arch: spec.arch.clone(),
            available_harnesses: spec.available_harnesses.clone(),
            capability_tags: spec.capability_tags.clone(),
            sandbox_available: spec.sandbox_available,
            active_workers,
            max_workers: spec.max_workers.max(1),
            announced_at_ms,
            signature_hex: String::new(),
        };
        let digest = draft.signing_digest()?;
        let sig = device.sign_bytes(&digest)?;
        draft.signature_hex = hex_encode(&sig);
        Ok(draft)
    }

    pub fn verify_against_ring(&self, epoch_ring: &EpochKeyRing) -> Result<()> {
        if self.agent_id != epoch_ring.agent_id() {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("能力通告 agent_id 与当前主权脊柱不匹配"),
            });
        }
        let Some(pubkey) = epoch_ring.active_device_pubkey(self.device_id) else {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("能力通告来自未授权或已吊销设备 {}", self.device_id),
            });
        };
        let expected_ep_hex = hex_encode(pubkey);
        if !self.endpoint_id_hex.eq_ignore_ascii_case(&expected_ep_hex) {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("能力通告 endpoint_id_hex 与设备授权公钥不一致"),
            });
        }
        let sig = hex_decode_fixed::<64>("capability.signature_hex", &self.signature_hex)?;
        let digest = self.signing_digest()?;
        verify_ed25519_signature(pubkey, &digest, &sig)
    }

    #[must_use]
    pub fn matches_required_tags(&self, required_tags: &[String]) -> bool {
        if !self.sandbox_available || self.active_workers >= self.max_workers {
            return false;
        }
        required_tags.iter().all(|req| {
            let r = req.trim();
            self.capability_tags
                .iter()
                .any(|t| t.eq_ignore_ascii_case(r))
                || self
                    .available_harnesses
                    .iter()
                    .any(|h| h.eq_ignore_ascii_case(r))
                || self.os.eq_ignore_ascii_case(r)
                || self.arch.eq_ignore_ascii_case(r)
        })
    }
}

/// 跨机器远程 `Commit Run` 派发载荷。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteWorkerTaskSpec {
    pub run_id: RunId,
    pub title: String,
    pub required_tags: Vec<String>,
    pub worker_shell_script: String,
    pub workspace_files: BTreeMap<String, Vec<u8>>,
    pub verifier_suite_files: BTreeMap<String, Vec<u8>>,
    pub verifier_shell_cmd: Option<String>,
}

/// 远端 Worker 节点在无容器 OS 沙箱 + 断网洁净室 `CleanRoomVerifierDag` 内完成后的回执。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteWorkerTaskResult {
    pub run_id: RunId,
    pub executed_by_device_id: DeviceId,
    pub verification_mark: Option<VerificationMark>,
    pub artifact_tree_blake3: ArtifactId,
    pub output_files: BTreeMap<String, Vec<u8>>,
    pub sealed_packfiles: Vec<SealedPackfile>,
    pub worker_stdout: String,
}

/// 远程异构 Worker 调度池。
#[derive(Clone, Debug, Default)]
pub struct RemoteWorkerPool {
    nodes: BTreeMap<DeviceId, NodeCapabilityAnnouncement>,
}

impl RemoteWorkerPool {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ingest_announcement(
        &mut self,
        announcement: NodeCapabilityAnnouncement,
        epoch_ring: &EpochKeyRing,
    ) -> Result<()> {
        announcement.verify_against_ring(epoch_ring)?;
        if let Some(existing) = self.nodes.get(&announcement.device_id)
            && announcement.announced_at_ms < existing.announced_at_ms
        {
            return Ok(());
        }
        self.nodes.insert(announcement.device_id, announcement);
        Ok(())
    }

    pub fn remove_device(&mut self, device_id: DeviceId) {
        self.nodes.remove(&device_id);
    }

    #[must_use]
    pub fn list_announcements(&self) -> Vec<NodeCapabilityAnnouncement> {
        self.nodes.values().cloned().collect()
    }

    #[must_use]
    pub fn select_best_node(&self, required_tags: &[String]) -> Option<NodeCapabilityAnnouncement> {
        self.select_best_node_with_direct_preference(required_tags, &BTreeSet::new())
    }

    #[must_use]
    pub fn select_best_node_with_direct_preference(
        &self,
        required_tags: &[String],
        direct_peers: &BTreeSet<DeviceId>,
    ) -> Option<NodeCapabilityAnnouncement> {
        self.nodes
            .values()
            .filter(|ann| ann.matches_required_tags(required_tags))
            .min_by_key(|ann| {
                let not_direct = u8::from(!direct_peers.contains(&ann.device_id));
                let load_permille =
                    (u64::from(ann.active_workers) * 1_000) / u64::from(ann.max_workers.max(1));
                (not_direct, load_permille, ann.device_id)
            })
            .cloned()
    }

    pub async fn dispatch_task(
        &self,
        fabric: &FabricNode,
        peer_addrs: &BTreeMap<DeviceId, EndpointAddr>,
        witness_epoch: u64,
        task: &RemoteWorkerTaskSpec,
    ) -> Result<RemoteWorkerTaskResult> {
        let direct_peers: BTreeSet<DeviceId> = fabric
            .peer_statuses()
            .into_iter()
            .filter_map(|p| match p.path {
                PeerPathKind::DirectIp { .. } => Some(p.device_id),
                _ => None,
            })
            .collect();

        let target = self
            .select_best_node_with_direct_preference(&task.required_tags, &direct_peers)
            .ok_or_else(|| QuetzalcoatlError::StorageError {
                detail: format!(
                    "RemoteWorkerPool 中没有满足能力标签 {:?} 且沙箱就绪的在线节点",
                    task.required_tags
                ),
            })?;

        let target_addr = if let Some(addr) = peer_addrs.get(&target.device_id) {
            addr.clone()
        } else {
            let ep_id = EndpointId::from_str(&target.endpoint_id_hex)
                .map_err(|e| QuetzalcoatlError::invalid_id("EndpointId", e.to_string()))?;
            EndpointAddr::new(ep_id)
        };

        let resp = fabric
            .send_rpc(
                target_addr,
                &FabricRpcRequest::ExecuteRemoteWorkerTask {
                    agent_id: fabric.agent_id(),
                    requester_device_id: fabric.device_id(),
                    witness_epoch,
                    task: task.clone(),
                },
            )
            .await?;

        match resp {
            FabricRpcResponse::RemoteWorkerTaskCompleted { result } => {
                let res = *result;
                if res.executed_by_device_id != target.device_id {
                    return Err(QuetzalcoatlError::IntegrityViolation {
                        detail: String::from("远端 Worker 回执设备 ID 与派发目标不一致"),
                    });
                }
                if task.verifier_shell_cmd.is_some() {
                    let mark = res.verification_mark.as_ref().ok_or_else(|| {
                        QuetzalcoatlError::VerificationFailed {
                            detail: String::from(
                                "远端 Worker 未返回强制要求的洁净室 VerificationMark",
                            ),
                        }
                    })?;
                    mark.verify_integrity()?;
                    if mark.run_id != task.run_id {
                        return Err(QuetzalcoatlError::IntegrityViolation {
                            detail: String::from("远端 VerificationMark 绑定的 RunId 不匹配"),
                        });
                    }
                }
                Ok(res)
            }
            FabricRpcResponse::Error { code, detail } => {
                if code == "VERIFICATION_FAILED" {
                    Err(QuetzalcoatlError::VerificationFailed { detail })
                } else if code == "SANDBOX_VIOLATION" {
                    Err(QuetzalcoatlError::SandboxViolation { detail })
                } else {
                    Err(QuetzalcoatlError::StorageError { detail })
                }
            }
            other => Err(QuetzalcoatlError::SerializationError {
                detail: format!("unexpected ExecuteRemoteWorkerTask response: {other:?}"),
            }),
        }
    }
}

fn validate_safe_rel_path(rel: &str) -> Result<&Path> {
    let p = Path::new(rel);
    if p.is_absolute() || rel.trim().is_empty() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("拒绝绝对或空相对路径: `{rel}`"),
        });
    }
    for comp in p.components() {
        if !matches!(comp, Component::Normal(_)) {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("拒绝包含目录逃逸组件的相对路径: `{rel}`"),
            });
        }
    }
    Ok(p)
}

fn remote_worker_scratch_base() -> PathBuf {
    let var_tmp = Path::new("/var/tmp");
    let root = if !cfg!(windows) && var_tmp.is_dir() {
        var_tmp.to_path_buf()
    } else {
        std::env::temp_dir()
    };
    root.join(format!(
        "quetzalcoatl-remote-worker-{}",
        Uuid::new_v4().simple()
    ))
}

struct ScratchDirCleanup(PathBuf);

impl Drop for ScratchDirCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// 在远端 Worker 节点本机无容器沙箱与断网洁净室校验器中执行任务并密封返回 `SealedPackfile`。
pub fn execute_remote_worker_task_locally<S: MaterializedStore>(
    kernel: &mut BlindKernel<S>,
    task: &RemoteWorkerTaskSpec,
    local_wall_ms: u64,
) -> Result<RemoteWorkerTaskResult> {
    let probe = kernel.sandbox().probe()?;
    if !probe.available {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!(
                "远端 Worker 节点无容器 OS 沙箱不可用，拒绝执行任务: {}",
                probe.detail
            ),
        });
    }

    let scratch = ScratchDirCleanup(remote_worker_scratch_base());
    let ws_dir = scratch.0.join("workspace");
    let suite_dir = scratch.0.join("verifier_suite");
    fs::create_dir_all(&ws_dir).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("创建远端 Worker 隔离工作区失败: {e}"),
    })?;
    fs::create_dir_all(&suite_dir).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("创建远端洁净室校验套件目录失败: {e}"),
    })?;
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(&scratch.0, fs::Permissions::from_mode(0o700));
    }

    for (rel, content) in &task.workspace_files {
        let safe_rel = validate_safe_rel_path(rel)?;
        let dest = ws_dir.join(safe_rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        }
        fs::write(&dest, content).map_err(|e| QuetzalcoatlError::StorageError {
            detail: e.to_string(),
        })?;
    }

    for (rel, content) in &task.verifier_suite_files {
        let safe_rel = validate_safe_rel_path(rel)?;
        let dest = suite_dir.join(safe_rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        }
        fs::write(&dest, content).map_err(|e| QuetzalcoatlError::StorageError {
            detail: e.to_string(),
        })?;
        #[cfg(unix)]
        if rel.ends_with(".sh") {
            let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
        }
    }

    // 启动绑定本地沙箱工作区的 Commit Run
    let spawned = kernel.spawn_commit_run(&task.title, Some(ws_dir.clone()), local_wall_ms)?;
    let local_run_id = spawned.run_id;

    if kernel.registry().get_capability("code.mutate").is_some() {
        let _ = kernel.authorize_capability(
            PrincipalRole::Worker,
            Some(local_run_id),
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            BTreeSet::from([String::from("code.mutate")]),
            &CapabilityInvocation::new("code.mutate", r#"{"remote_worker":true}"#),
            local_wall_ms,
        )?;
    }

    // 签发强制断网隔离 + 工作区可写的 OS 沙箱票据执行远端 Worker 脚本
    let ticket = kernel.sandbox().mint_ticket(TicketRequest {
        run_id: local_run_id,
        workspace_dir: ws_dir.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::Isolated,
        ttl_ms: Some(60_000),
        now_wall_ms: local_wall_ms,
    })?;
    let exec_out = kernel.sandbox().execute_with_ticket(
        &ticket,
        &SandboxCommand::shell(task.worker_shell_script.clone()),
        local_wall_ms,
    )?;
    if exec_out.exit_code != 0 {
        let _ = kernel.abort_run(local_run_id, "remote worker script failed", local_wall_ms);
        return Err(QuetzalcoatlError::VerificationFailed {
            detail: format!(
                "远端 Worker 沙箱任务退出码非零 ({}): {}",
                exec_out.exit_code,
                exec_out.stderr_lossy()
            ),
        });
    }

    let dag_opt = task.verifier_shell_cmd.as_ref().map(|vcmd| {
        let wrapped_cmd = format!(
            "export QZ_VERIFIER_SUITE='{}' QZ_CANDIDATE_WORKSPACE='{}'; {}",
            suite_dir.to_string_lossy().replace('\'', "'\\''"),
            ws_dir.to_string_lossy().replace('\'', "'\\''"),
            vcmd
        );
        CleanRoomVerifierDag::single(
            "remote-clean-room-verifier",
            suite_dir.clone(),
            SandboxCommand::shell(wrapped_cmd),
        )
    });

    let completion = match kernel.complete_commit_run(
        local_run_id,
        dag_opt.as_ref(),
        local_wall_ms.saturating_add(10),
    ) {
        Ok(rep) => rep,
        Err(err) => {
            let _ = kernel.abort_run(
                local_run_id,
                "remote clean-room verifier failed",
                local_wall_ms.saturating_add(11),
            );
            return Err(err);
        }
    };

    // 若调用方传入了逻辑 task.run_id，确保返回的 VerificationMark 绑定调用方期望的 task.run_id（当二者不同时由洁净室对同一候选树重新签发绑定 task.run_id 的收据）
    let final_mark = if let Some(ref vdag) = dag_opt {
        if task.run_id != local_run_id {
            let mut engine = quetzalcoatl_kernel::CleanRoomVerifierEngine::new();
            let receipt = engine.execute_dag(kernel.sandbox(), task.run_id, &ws_dir, vdag)?;
            let mark_hlc = kernel.spine().local_hlc().tick(
                local_wall_ms.saturating_add(12),
                kernel.spine().local_device().device_id().hlc_node_tag(),
            )?;
            Some(engine.mint_mark_for_receipt(&receipt, mark_hlc)?)
        } else {
            completion.verification_mark
        }
    } else {
        completion.verification_mark
    };

    let manifest = compute_workspace_tree_manifest(&ws_dir)?;
    let mut output_files = BTreeMap::new();
    for entry in &manifest.entries {
        if matches!(entry.kind, ArtifactEntryKind::RegularFile { .. }) {
            let bytes = fs::read(ws_dir.join(&entry.rel_path)).map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: e.to_string(),
                }
            })?;
            output_files.insert(entry.rel_path.clone(), bytes);
        }
    }

    let _ = kernel
        .spine_mut()
        .seal_checkpoint(Some(local_run_id), local_wall_ms.saturating_add(15))?;
    let local_dev_id = kernel.spine().local_device().device_id();
    let sealed_packfiles: Vec<SealedPackfile> = kernel
        .spine()
        .store()
        .list_packfiles()?
        .into_iter()
        .filter(|p| p.aad.device_id == local_dev_id)
        .collect();

    Ok(RemoteWorkerTaskResult {
        run_id: task.run_id,
        executed_by_device_id: local_dev_id,
        verification_mark: final_mark,
        artifact_tree_blake3: manifest.tree_blake3,
        output_files,
        sealed_packfiles,
        worker_stdout: exec_out.stdout_lossy(),
    })
}
