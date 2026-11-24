#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `SayIt`（`sayit-handoff.md` v2.1）JSON-v2 子树吸纳器。
//!
//! 四条硬性交接规则（AGENTS.md 防坑规范 #11 ①–④）：
//! 1. `meta.emb_model_id` / `emb_dim` 异源：在线时用本脊柱规范嵌入器重算；
//!    离线时 `semanticWeight=0` 走词法+结构对齐，并将异源节点排队 `reembed()`；
//! 2. 分支对齐强制 `data.role`（`project` / `record` / `section`）同粒度；
//! 3. 以 `(sayit_user_hash, slice_id, session_id, snapshot_sha256)` 记录；同一
//!    `session_id` 重归属重编译时，先双时态 `invalidate()` 旧独占节点再合并新版；
//! 4. 归并结果采用确定性 UTF-16 码元序，两次运行字节稳定。
//! 5. 仅允许个人主权 Agent；共享角色群组 Agent 一律 `PermissionDenied`。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use quetzalcoatl_ewave::{
    AlignOptions, EwaveSnapshot, MergeOptions, NodeId, SayItIngestContext, SayItIngestStatus,
    SerpentineGraph,
};
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::{CapabilityDescriptor, CapabilityPermissions, ImplementationRef};
use sha2::{Digest, Sha256};

/// 本能力包的稳定 ID。
pub const CAPABILITY_ID: &str = "sayit-ingestor";

/// 声明式描述符：仅绑定个人主权 Agent，绝无网络外发。
#[must_use]
pub fn descriptor() -> CapabilityDescriptor {
    CapabilityDescriptor {
        id: String::from(CAPABILITY_ID),
        display_name: String::from("SayIt 子树吸纳"),
        description: String::from(
            "消费 SayIt v2.1 JSON-v2 子树快照，经 align()/merge() 归并入个人主权 SerpentineGraph。",
        ),
        implementation: ImplementationRef {
            crate_name: String::from("quetzalcoatl-capabilities"),
            module: String::from("sayit_ingestor"),
        },
        permissions: CapabilityPermissions {
            network: false,
            filesystem: vec![String::from("QUETZALCOATL_HOME/ewave")],
            sinks: vec![String::from("memory.observe"), String::from("journal.note")],
        },
        status: String::from("declared"),
    }
}

/// 吸纳目标 Agent 的主权范围。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum SovereignScope {
    /// 个人主权 Agent（唯一允许的吸纳目标）。
    PersonalSovereign,
    /// 共享角色群组 Agent（物理隔离，禁止吸纳个人 `SayIt` 子树）。
    SharedRole { group_id: String },
}

/// 吸纳目标。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SayItTarget {
    pub agent_id: AgentId,
    pub scope: SovereignScope,
}

/// 快照元数据；`snapshot_sha256` 为空时自动按原始字节计算。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SayItSnapshotMeta {
    pub sayit_user_hash: String,
    pub slice_id: String,
    pub session_id: String,
    pub snapshot_sha256: String,
}

/// 单次吸纳回执（绝不含快照正文）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SayItIngestReceipt {
    /// `ingested_new` / `duplicate_no_op` / `refiled_updated`。
    pub status: String,
    pub invalidated_node_ids: Vec<NodeId>,
    pub exclusive_node_ids: Vec<NodeId>,
    pub added_branches: usize,
    pub added_leaves: usize,
    pub reembedded_foreign_vectors: bool,
    pub offline_lexical_fallback: bool,
    pub queued_reembed: usize,
}

/// 批量吸纳的单文件结果。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SayItBatchOutcome {
    pub path: PathBuf,
    pub receipt: Option<SayItIngestReceipt>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
}

/// `SayIt` 子树吸纳器：持有一张本地 `SerpentineGraph`。
pub struct SayItIngestor {
    target: SayItTarget,
    graph: SerpentineGraph,
}

impl SayItIngestor {
    /// 构造个人主权吸纳器；共享角色目标立即拒绝。
    pub fn new(target: SayItTarget) -> Result<Self> {
        if !matches!(target.scope, SovereignScope::PersonalSovereign) {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("SayIt 吸纳仅允许个人主权 Agent，拒绝共享角色群组 Agent"),
            });
        }
        let graph = SerpentineGraph::new(quetzalcoatl_ewave::GraphOptions::default())?;
        Ok(Self { target, graph })
    }

    /// 以既有个人主权图构造吸纳器。
    pub fn from_graph(target: SayItTarget, graph: SerpentineGraph) -> Result<Self> {
        if !matches!(target.scope, SovereignScope::PersonalSovereign) {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("SayIt 吸纳仅允许个人主权 Agent，拒绝共享角色群组 Agent"),
            });
        }
        Ok(Self { target, graph })
    }

    #[must_use]
    pub fn target(&self) -> &SayItTarget {
        &self.target
    }

    #[must_use]
    pub fn graph(&self) -> &SerpentineGraph {
        &self.graph
    }

    pub fn graph_mut(&mut self) -> &mut SerpentineGraph {
        &mut self.graph
    }

    /// 吸纳一段 JSON-v2 快照。
    pub fn ingest_snapshot(
        &mut self,
        snapshot_json: &str,
        meta: &SayItSnapshotMeta,
        now_ms: u64,
        embedder_online: bool,
    ) -> Result<SayItIngestReceipt> {
        ingest_snapshot_into_graph(
            &mut self.graph,
            &self.target,
            snapshot_json,
            meta,
            now_ms,
            embedder_online,
        )
    }

    /// 从 `u/<hash>/subtrees/<sliceId>/<sessionId>.ewave.json` 路径吸纳，
    /// 元数据自动从路径派生并按文件字节计算 `snapshot_sha256`。
    pub fn ingest_file(
        &mut self,
        path: &Path,
        now_ms: u64,
        embedder_online: bool,
    ) -> Result<SayItIngestReceipt> {
        ingest_file_into_graph(&mut self.graph, &self.target, path, now_ms, embedder_online)
    }

    /// 批量吸纳目录下所有 `*.ewave.json`；单文件失败不影响其他文件。
    pub fn ingest_batch(
        &mut self,
        root: &Path,
        now_ms: u64,
        embedder_online: bool,
    ) -> Result<Vec<SayItBatchOutcome>> {
        ingest_batch_into_graph(&mut self.graph, &self.target, root, now_ms, embedder_online)
    }
}

/// 将一段 `SayIt` 快照直接吸纳进既有个人主权图。
pub fn ingest_snapshot_into_graph(
    graph: &mut SerpentineGraph,
    target: &SayItTarget,
    snapshot_json: &str,
    meta: &SayItSnapshotMeta,
    now_ms: u64,
    embedder_online: bool,
) -> Result<SayItIngestReceipt> {
    ensure_personal(target)?;
    let snapshot: EwaveSnapshot =
        serde_json::from_str(snapshot_json).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("解析 SayIt EwaveSnapshot JSON-v2 失败: {e}"),
        })?;
    let mut resolved = meta.clone();
    if resolved.snapshot_sha256.trim().is_empty() {
        resolved.snapshot_sha256 = sha256_hex(snapshot_json.as_bytes());
    }

    graph.set_embedder_online(embedder_online);
    let merge_options = MergeOptions {
        align: AlignOptions {
            semantic_weight: if embedder_online { 0.62 } else { 0.0 },
            offline_fallback: !embedder_online,
            ..AlignOptions::default()
        },
        ..MergeOptions::default()
    };
    let ctx = SayItIngestContext {
        sayit_user_hash: resolved.sayit_user_hash,
        slice_id: resolved.slice_id,
        session_id: resolved.session_id,
        snapshot_sha256: resolved.snapshot_sha256,
        now_ms,
        merge_options,
    };
    let result = graph.ingest_sayit_subtree(snapshot, ctx)?;
    let (added_branches, added_leaves) = result
        .merge_result
        .as_ref()
        .map_or((0, 0), |m| (m.added_branches.len(), m.added_leaves.len()));
    let (reembedded, offline, queued) = result.merge_result.as_ref().map_or(
        (false, !embedder_online, graph.pending_reembed_ids().len()),
        |m| {
            (
                m.alignment.reembedded_foreign_vectors,
                m.alignment.used_offline_lexical_fallback,
                m.queued_reembed_ids.len(),
            )
        },
    );
    let mut exclusive_node_ids: Vec<NodeId> = Vec::new();
    if let Some(merge) = &result.merge_result {
        exclusive_node_ids.extend(merge.added_leaves.iter().map(|n| n.id.clone()));
        exclusive_node_ids.extend(merge.added_branches.iter().map(|n| n.id.clone()));
    }
    exclusive_node_ids.sort();
    exclusive_node_ids.dedup();
    Ok(SayItIngestReceipt {
        status: status_str(result.status).to_owned(),
        invalidated_node_ids: result.invalidated_node_ids,
        exclusive_node_ids,
        added_branches,
        added_leaves,
        reembedded_foreign_vectors: reembedded,
        offline_lexical_fallback: offline,
        queued_reembed: queued,
    })
}

/// 从路径吸纳进既有个人主权图。
pub fn ingest_file_into_graph(
    graph: &mut SerpentineGraph,
    target: &SayItTarget,
    path: &Path,
    now_ms: u64,
    embedder_online: bool,
) -> Result<SayItIngestReceipt> {
    ensure_personal(target)?;
    let raw = std::fs::read_to_string(path).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("读取 SayIt 快照失败 ({}): {e}", path.display()),
    })?;
    let meta = meta_from_path(path, &raw)?;
    ingest_snapshot_into_graph(graph, target, &raw, &meta, now_ms, embedder_online)
}

/// 批量吸纳进既有个人主权图。
pub fn ingest_batch_into_graph(
    graph: &mut SerpentineGraph,
    target: &SayItTarget,
    root: &Path,
    now_ms: u64,
    embedder_online: bool,
) -> Result<Vec<SayItBatchOutcome>> {
    ensure_personal(target)?;
    let mut paths = Vec::new();
    collect_snapshots(root, &mut paths)?;
    paths.sort();
    let mut out = Vec::with_capacity(paths.len());
    for (offset, path) in paths.into_iter().enumerate() {
        let tick = now_ms.saturating_add(u64::try_from(offset).unwrap_or(0));
        match ingest_file_into_graph(graph, target, &path, tick, embedder_online) {
            Ok(receipt) => out.push(SayItBatchOutcome {
                path,
                receipt: Some(receipt),
                error_code: None,
                error_detail: None,
            }),
            Err(err) => out.push(SayItBatchOutcome {
                path,
                receipt: None,
                error_code: Some(String::from(err.code().as_str())),
                error_detail: Some(err.to_string()),
            }),
        }
    }
    Ok(out)
}

fn ensure_personal(target: &SayItTarget) -> Result<()> {
    if matches!(target.scope, SovereignScope::PersonalSovereign) {
        Ok(())
    } else {
        Err(QuetzalcoatlError::PermissionDenied {
            detail: String::from("SayIt 吸纳仅允许个人主权 Agent，拒绝共享角色群组 Agent"),
        })
    }
}

fn status_str(status: SayItIngestStatus) -> &'static str {
    match status {
        SayItIngestStatus::IngestedNew => "ingested_new",
        SayItIngestStatus::DuplicateNoOp => "duplicate_no_op",
        SayItIngestStatus::RefiledUpdated => "refiled_updated",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn collect_snapshots(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    let entries = std::fs::read_dir(dir).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("读取 SayIt 批目录失败 ({}): {e}", dir.display()),
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("遍历 SayIt 批目录失败: {e}"),
        })?;
        let path = entry.path();
        if path.is_dir() {
            collect_snapshots(&path, out)?;
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(".ewave.json"))
        {
            out.push(path);
        }
    }
    Ok(())
}

fn meta_from_path(path: &Path, raw: &str) -> Result<SayItSnapshotMeta> {
    let parts: Vec<String> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str().map(str::to_owned))
        .collect();
    let user_hash = parts
        .iter()
        .position(|p| p == "u")
        .and_then(|idx| parts.get(idx + 1))
        .cloned()
        .ok_or_else(|| {
            QuetzalcoatlError::invalid_id("SayItPath", String::from("缺少 u/<hash> 段"))
        })?;
    let subtree_idx = parts.iter().rposition(|p| p == "subtrees").ok_or_else(|| {
        QuetzalcoatlError::invalid_id("SayItPath", String::from("缺少 subtrees 段"))
    })?;
    let slice_id = parts.get(subtree_idx + 1).cloned().ok_or_else(|| {
        QuetzalcoatlError::invalid_id("SayItPath", String::from("缺少 sliceId 段"))
    })?;
    let filename = parts
        .last()
        .cloned()
        .ok_or_else(|| QuetzalcoatlError::invalid_id("SayItPath", String::from("缺少文件名")))?;
    let session_id = filename
        .strip_suffix(".ewave.json")
        .ok_or_else(|| {
            QuetzalcoatlError::invalid_id(
                "SayItPath",
                String::from("文件名必须以 .ewave.json 结尾"),
            )
        })?
        .to_owned();
    Ok(SayItSnapshotMeta {
        sayit_user_hash: user_hash,
        slice_id,
        session_id,
        snapshot_sha256: sha256_hex(raw.as_bytes()),
    })
}

/// 解析快照内 `meta` 的嵌入器信息，供守护进程在异源时记录/断言。
#[must_use]
pub fn snapshot_embedder_meta(snapshot_json: &str) -> BTreeMap<String, serde_json::Value> {
    serde_json::from_str::<EwaveSnapshot>(snapshot_json)
        .ok()
        .and_then(|s| s.meta)
        .unwrap_or_default()
}
