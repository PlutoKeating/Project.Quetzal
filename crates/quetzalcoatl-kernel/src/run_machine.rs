#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 持久化双态 `Run` 状态机（`Explore ↔ Commit`）、`Checkpoint` 锁定与外部写前幂等令牌。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use quetzalcoatl_spine::{MaterializedRun, MaterializedStore, SpineEngine};
use quetzalcoatl_types::{ArtifactId, HlcTimestamp, QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};

use crate::grant::{MovementRecord, OutboxItem};
use crate::registry::{EvolvedSkillDescriptor, SinkClass};
use crate::verifier::VerificationMark;

const KERNEL_SPINE_SCHEMA: &str = "quetzalcoatl.kernel.v1";
const IDEMPOTENCY_PAYLOAD_DOMAIN: &str = "quetzalcoatl/v2/kernel-idempotency-payload-v1";
const IDEMPOTENCY_TOKEN_DOMAIN: &str = "quetzalcoatl/v2/kernel-idempotency-token-v1";

/// 双态认知与执行模式。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    Explore,
    Commit,
}

impl RunMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Explore => "explore",
            Self::Commit => "commit",
        }
    }
}

/// 持久化 `Run` 生命周期状态。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Active,
    SuspendedCheckpoint,
    VerifiedPendingMark,
    Completed,
    Aborted,
}

impl RunStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::SuspendedCheckpoint => "suspended_checkpoint",
            Self::VerifiedPendingMark => "verified_pending_mark",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
        }
    }
}

/// `Commit Run` 认领后锁定的状态脊柱断点元数据。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointLock {
    pub checkpoint_id: ArtifactId,
    pub locked_hlc: HlcTimestamp,
    pub workspace_tree_blake3: Option<ArtifactId>,
}

/// 外部副作用执行前预写落盘的幂等去重令牌。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteAheadIdempotencyToken {
    pub token_id: ArtifactId,
    pub run_id: RunId,
    pub capability_id: String,
    pub idempotency_key: String,
    pub payload_blake3: ArtifactId,
    pub issued_hlc: HlcTimestamp,
}

/// 外部写前幂等锁判定结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExternalWriteDisposition {
    PermittedNew { token: WriteAheadIdempotencyToken },
    DuplicateSuppressed { token: WriteAheadIdempotencyToken },
}

/// 物化在状态脊柱中的完整 `Run` 数据记录（非临时内存进程句柄）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunRecord {
    pub run_id: RunId,
    pub mode: RunMode,
    pub status: RunStatus,
    pub title: String,
    pub workspace_dir: Option<PathBuf>,
    pub checkpoint_lock: Option<CheckpointLock>,
    pub touched_sinks: BTreeSet<SinkClass>,
    pub evolved_skills: Vec<String>,
    pub verification_mark: Option<VerificationMark>,
    pub updated_hlc: HlcTimestamp,
}

impl RunRecord {
    /// 是否触及必须经洁净室校验器验收的高危/代码变更汇点。
    #[must_use]
    pub fn requires_clean_room_verifier(&self) -> bool {
        self.touched_sinks
            .iter()
            .copied()
            .any(SinkClass::requires_clean_room_verifier)
    }

    pub(crate) fn to_materialized(&self) -> Result<MaterializedRun> {
        let detail =
            serde_json::to_string(self).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("序列化 RunRecord 物化详情失败: {e}"),
            })?;
        Ok(MaterializedRun {
            run_id: self.run_id,
            mode: String::from(self.mode.as_str()),
            status: String::from(self.status.as_str()),
            title: self.title.clone(),
            detail,
            updated_hlc: self.updated_hlc,
        })
    }
}

/// `Commit Run` 结项回执。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitCompletionReport {
    pub run_id: RunId,
    pub verifier_runs: u64,
    pub verification_mark: Option<VerificationMark>,
    pub final_status: RunStatus,
}

/// 写入状态脊柱事件链的盲内核结构化审计载荷。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct KernelSpineEnvelope {
    pub schema: String,
    pub event: KernelSpinePayload,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum KernelSpinePayload {
    RunUpserted { run: Box<RunRecord> },
    MovementLogged { movement: MovementRecord },
    OutboxQueued { item: OutboxItem },
    OutboxDrained { epoch: u64, drained_count: usize },
    WriteAheadTokenIssued { token: WriteAheadIdempotencyToken },
    SkillSynthesized { skill: EvolvedSkillDescriptor },
}

impl KernelSpineEnvelope {
    pub(crate) fn encode(event: KernelSpinePayload) -> Result<String> {
        serde_json::to_string(&Self {
            schema: String::from(KERNEL_SPINE_SCHEMA),
            event,
        })
        .map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("编码内核脊柱事件载荷失败: {e}"),
        })
    }
}

pub(crate) fn compute_payload_digest(capability_id: &str, arguments_json: &str) -> ArtifactId {
    let mut h = blake3::Hasher::new_derive_key(IDEMPOTENCY_PAYLOAD_DOMAIN);
    h.update(&(capability_id.len() as u64).to_be_bytes());
    h.update(capability_id.as_bytes());
    h.update(&(arguments_json.len() as u64).to_be_bytes());
    h.update(arguments_json.as_bytes());
    ArtifactId::from_bytes(*h.finalize().as_bytes())
}

pub(crate) fn compute_write_ahead_token_id(
    run_id: RunId,
    capability_id: &str,
    idempotency_key: &str,
    payload_blake3: ArtifactId,
) -> ArtifactId {
    let mut h = blake3::Hasher::new_derive_key(IDEMPOTENCY_TOKEN_DOMAIN);
    h.update(run_id.as_bytes());
    h.update(&(capability_id.len() as u64).to_be_bytes());
    h.update(capability_id.as_bytes());
    h.update(&(idempotency_key.len() as u64).to_be_bytes());
    h.update(idempotency_key.as_bytes());
    h.update(payload_blake3.as_bytes());
    ArtifactId::from_bytes(*h.finalize().as_bytes())
}

/// 双态 `Run` 持久化状态机。
#[derive(Clone, Debug, Default)]
pub struct RunStateMachine {
    runs: BTreeMap<RunId, RunRecord>,
    idempotency_tokens: BTreeMap<(RunId, String), WriteAheadIdempotencyToken>,
}

impl RunStateMachine {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn get_run(&self, run_id: RunId) -> Option<&RunRecord> {
        self.runs.get(&run_id)
    }

    pub(crate) fn get_run_mut(&mut self, run_id: RunId) -> Option<&mut RunRecord> {
        self.runs.get_mut(&run_id)
    }

    pub(crate) fn put_run(&mut self, record: RunRecord) {
        self.runs.insert(record.run_id, record);
    }

    #[must_use]
    pub fn list_runs(&self) -> Vec<&RunRecord> {
        self.runs.values().collect()
    }

    /// 检查或签发外部写前幂等锁令牌：相同 `(run_id, idempotency_key)` 载荷一致时抑制双发，载荷不一致时报错防篡改。
    pub(crate) fn check_or_issue_write_ahead_token(
        &mut self,
        run_id: RunId,
        capability_id: &str,
        idempotency_key: &str,
        arguments_json: &str,
        hlc: HlcTimestamp,
    ) -> Result<ExternalWriteDisposition> {
        let payload_blake3 = compute_payload_digest(capability_id, arguments_json);
        let lookup_key = (run_id, idempotency_key.to_owned());

        if let Some(existing) = self.idempotency_tokens.get(&lookup_key) {
            if existing.payload_blake3 != payload_blake3 || existing.capability_id != capability_id
            {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!(
                        "外部写前幂等键 `{idempotency_key}` 发生载荷冲突（禁止同一幂等键携带不同参数重放）"
                    ),
                });
            }
            return Ok(ExternalWriteDisposition::DuplicateSuppressed {
                token: existing.clone(),
            });
        }

        let token = WriteAheadIdempotencyToken {
            token_id: compute_write_ahead_token_id(
                run_id,
                capability_id,
                idempotency_key,
                payload_blake3,
            ),
            run_id,
            capability_id: capability_id.to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            payload_blake3,
            issued_hlc: hlc,
        };
        self.idempotency_tokens.insert(lookup_key, token.clone());
        Ok(ExternalWriteDisposition::PermittedNew { token })
    }

    pub(crate) fn restore_write_ahead_token(&mut self, token: WriteAheadIdempotencyToken) {
        self.idempotency_tokens
            .insert((token.run_id, token.idempotency_key.clone()), token);
    }

    /// 从签名事件脊柱确定性重水合 `Run` 记录与写前幂等令牌表（严格幂等）。
    pub fn rehydrate_from_spine<S: MaterializedStore>(
        &mut self,
        spine: &SpineEngine<S>,
    ) -> Result<usize> {
        self.runs.clear();
        self.idempotency_tokens.clear();
        let all_events = spine.store().list_all_events()?;
        let mut applied = 0usize;

        for (ev, _) in all_events {
            let Ok(envelope) = serde_json::from_str::<KernelSpineEnvelope>(&ev.payload_utf8) else {
                continue;
            };
            if envelope.schema != KERNEL_SPINE_SCHEMA {
                continue;
            }
            match envelope.event {
                KernelSpinePayload::RunUpserted { run } => {
                    let run = *run;
                    if let Some(mark) = &run.verification_mark {
                        mark.verify_integrity()?;
                    }
                    self.runs.insert(run.run_id, run);
                    applied = applied.saturating_add(1);
                }
                KernelSpinePayload::WriteAheadTokenIssued { token } => {
                    self.restore_write_ahead_token(token);
                    applied = applied.saturating_add(1);
                }
                KernelSpinePayload::MovementLogged { .. }
                | KernelSpinePayload::OutboxQueued { .. }
                | KernelSpinePayload::OutboxDrained { .. }
                | KernelSpinePayload::SkillSynthesized { .. } => {}
            }
        }

        Ok(applied)
    }
}
