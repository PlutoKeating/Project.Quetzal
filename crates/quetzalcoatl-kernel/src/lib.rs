#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-kernel` — 盲微内核。
//!
//! 严格收敛于状态脊柱、权限隔离、事件路由与客观校验四项原语，对上层具体模型供应商、
//! 外部通讯通道与业务工具实现保持完全盲视。

pub mod grant;
pub mod heart;
pub mod registry;
pub mod run_machine;
pub mod verifier;

pub use grant::{
    CapabilityInvocation, CapabilitySet, GrantContext, GrantEngine, GrantedInvocation,
    LeasePosture, MovementLedger, MovementOutcome, MovementRecord, OutboxItem, PrincipalRole,
    ScopeChain,
};
pub use heart::{
    EndogenousDrives, FALL_ASLEEP_THRESHOLD, HeartScheduler, HostInhibitors,
    NATURAL_WAKE_THRESHOLD, SleepPhase, TAU_SLEEP_HOURS, TAU_WAKE_HOURS, WakeSignalResult,
};
pub use registry::{
    ArtifactEntry, ArtifactEntryKind, ArtifactManifest, ArtifactRef, CapabilityDescriptor,
    CapabilityOrigin, EvolvedSkillDescriptor, EvolvedSkillSpec, ExecutionSurface,
    InterfaceRegistry, SinkClass, compute_workspace_tree_blake3, compute_workspace_tree_manifest,
};
pub use run_machine::{
    CheckpointLock, CommitCompletionReport, ExternalWriteDisposition, RunMode, RunRecord,
    RunStateMachine, RunStatus, WriteAheadIdempotencyToken,
};
pub use verifier::{
    CleanRoomVerifierDag, CleanRoomVerifierEngine, ParsedTestCounts, VerificationMark,
    VerifiedCandidateReceipt, VerifierNode, parse_verifier_test_counts,
};

use std::collections::BTreeSet;
use std::path::PathBuf;

use quetzalcoatl_crypto::PackCompartment;
use quetzalcoatl_sandbox::{
    NetworkPolicy, SandboxCommand, SandboxExecutionOutput, SandboxManager, SandboxMode,
    TicketRequest,
};
use quetzalcoatl_spine::{MaterializedStore, SpineEngine};
use quetzalcoatl_types::{Epoch, HlcTimestamp, QuetzalcoatlError, Result, RunId};

use crate::registry::validate_and_hash_evolved_skill_script;
use crate::run_machine::{KernelSpineEnvelope, KernelSpinePayload};

/// 能力调用与写前幂等综合核准结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelDispatchDecision {
    pub granted: GrantedInvocation,
    pub write_ahead: Option<ExternalWriteDisposition>,
}

/// 统一盲微内核门面。
pub struct BlindKernel<S: MaterializedStore> {
    spine: SpineEngine<S>,
    sandbox: SandboxManager,
    registry: InterfaceRegistry,
    grant_engine: GrantEngine,
    ledger: MovementLedger,
    heart: HeartScheduler,
    runs: RunStateMachine,
    verifier: CleanRoomVerifierEngine,
    lease_posture: LeasePosture,
}

impl<S: MaterializedStore> BlindKernel<S> {
    #[must_use]
    pub fn new(
        spine: SpineEngine<S>,
        sandbox: SandboxManager,
        heart: HeartScheduler,
        lease_posture: LeasePosture,
    ) -> Self {
        Self {
            spine,
            sandbox,
            registry: InterfaceRegistry::new(),
            grant_engine: GrantEngine::new(),
            ledger: MovementLedger::new(),
            heart,
            runs: RunStateMachine::new(),
            verifier: CleanRoomVerifierEngine::new(),
            lease_posture,
        }
    }

    #[must_use]
    pub const fn spine(&self) -> &SpineEngine<S> {
        &self.spine
    }

    pub fn spine_mut(&mut self) -> &mut SpineEngine<S> {
        &mut self.spine
    }

    #[must_use]
    pub const fn sandbox(&self) -> &SandboxManager {
        &self.sandbox
    }

    #[must_use]
    pub const fn registry(&self) -> &InterfaceRegistry {
        &self.registry
    }

    #[must_use]
    pub const fn ledger(&self) -> &MovementLedger {
        &self.ledger
    }

    #[must_use]
    pub const fn heart(&self) -> &HeartScheduler {
        &self.heart
    }

    pub fn heart_mut(&mut self) -> &mut HeartScheduler {
        &mut self.heart
    }

    #[must_use]
    pub const fn runs(&self) -> &RunStateMachine {
        &self.runs
    }

    #[must_use]
    pub const fn lease_posture(&self) -> LeasePosture {
        self.lease_posture
    }

    #[must_use]
    pub const fn total_verifier_runs(&self) -> u64 {
        self.verifier.total_verifier_runs()
    }

    pub fn set_lease_posture(&mut self, posture: LeasePosture) {
        self.lease_posture = posture;
    }

    fn append_kernel_payload(
        &mut self,
        payload: KernelSpinePayload,
        local_wall_ms: u64,
    ) -> Result<HlcTimestamp> {
        let encoded = KernelSpineEnvelope::encode(payload)?;
        let ev = self
            .spine
            .append_event(PackCompartment::Core, &encoded, local_wall_ms)?;
        Ok(ev.header.hlc)
    }

    fn persist_run_record(&mut self, record: RunRecord, local_wall_ms: u64) -> Result<RunRecord> {
        let mut updated = record;
        let predicted_hlc = self.spine.local_hlc().tick(
            local_wall_ms,
            self.spine.local_device().device_id().hlc_node_tag(),
        )?;
        updated.updated_hlc = predicted_hlc;
        let event_hlc = self.append_kernel_payload(
            KernelSpinePayload::RunUpserted {
                run: Box::new(updated.clone()),
            },
            local_wall_ms,
        )?;
        updated.updated_hlc = event_hlc;
        let materialized = updated.to_materialized()?;
        self.spine.store_mut().upsert_run(&materialized)?;
        self.runs.put_run(updated.clone());
        Ok(updated)
    }

    fn lock_spine_checkpoint_for_run(
        &mut self,
        run_id: RunId,
        workspace_dir: Option<&PathBuf>,
        local_wall_ms: u64,
    ) -> Result<CheckpointLock> {
        let ws_blake3 = match workspace_dir {
            Some(ws) => Some(compute_workspace_tree_blake3(ws)?),
            None => None,
        };
        let _ = self.spine.seal_checkpoint(Some(run_id), local_wall_ms)?;
        let latest_cp = self.spine.store().latest_checkpoint()?.ok_or_else(|| {
            QuetzalcoatlError::StorageError {
                detail: String::from("封存 Commit Run 检查点后未能读取最新 SpineCheckpoint"),
            }
        })?;
        Ok(CheckpointLock {
            checkpoint_id: latest_cp.checkpoint_id,
            locked_hlc: latest_cp.hlc,
            workspace_tree_blake3: ws_blake3,
        })
    }

    /// 重获联网见证纪元后对账排空断网期间暂存的 Outbox。
    pub fn drain_reconciled_outbox(&mut self, witness_epoch: Epoch) -> Result<Vec<OutboxItem>> {
        match self.lease_posture {
            LeasePosture::PartitionLocal => Err(QuetzalcoatlError::PartitionRestricted {
                detail: String::from("当前仍处于断网分区受限租约，禁止排空发送 Outbox"),
            }),
            LeasePosture::Witnessed {
                witness_epoch: current_epoch,
            } => {
                if witness_epoch < current_epoch {
                    return Err(QuetzalcoatlError::StaleLeaseEpoch {
                        provided: witness_epoch.get(),
                        current: current_epoch.get(),
                    });
                }
                let items = self.ledger.drain_reconciled_outbox(witness_epoch);
                let now_ms = self.spine.local_hlc().wall_ms();
                let _ = self.append_kernel_payload(
                    KernelSpinePayload::OutboxDrained {
                        epoch: witness_epoch.get(),
                        drained_count: items.len(),
                    },
                    now_ms,
                )?;
                Ok(items)
            }
        }
    }

    pub fn register_capability(&mut self, descriptor: CapabilityDescriptor) -> Result<()> {
        self.registry.register_host_capability(descriptor)
    }

    /// 启动自由探索态 `Explore Run`（允许本地只读与沙箱本地技能自演化，硬拒一切外部写）。
    pub fn spawn_explore_run(
        &mut self,
        title: impl Into<String>,
        workspace_dir: Option<PathBuf>,
        local_wall_ms: u64,
    ) -> Result<RunRecord> {
        if let Some(ws) = &workspace_dir {
            let _ = compute_workspace_tree_blake3(ws)?;
        }
        let run_id = RunId::new_v4();
        let initial = RunRecord {
            run_id,
            mode: RunMode::Explore,
            status: RunStatus::Active,
            title: title.into(),
            workspace_dir,
            checkpoint_lock: None,
            touched_sinks: BTreeSet::new(),
            evolved_skills: Vec::new(),
            verification_mark: None,
            updated_hlc: self.spine.local_hlc(),
        };
        self.persist_run_record(initial, local_wall_ms)
    }

    /// 启动任务承诺态 `Commit Run` 并立即在状态脊柱上锁定 `Checkpoint`。
    pub fn spawn_commit_run(
        &mut self,
        title: impl Into<String>,
        workspace_dir: Option<PathBuf>,
        local_wall_ms: u64,
    ) -> Result<RunRecord> {
        let run_id = RunId::new_v4();
        let cp_lock =
            self.lock_spine_checkpoint_for_run(run_id, workspace_dir.as_ref(), local_wall_ms)?;
        let initial = RunRecord {
            run_id,
            mode: RunMode::Commit,
            status: RunStatus::Active,
            title: title.into(),
            workspace_dir,
            checkpoint_lock: Some(cp_lock),
            touched_sinks: BTreeSet::new(),
            evolved_skills: Vec::new(),
            verification_mark: None,
            updated_hlc: cp_lock_hlc_fallback(&self.spine),
        };
        self.persist_run_record(initial, local_wall_ms)
    }

    /// 正交状态切换：`Explore -> Commit`（认领现实机会或委托后立即锁定 `Checkpoint`）。
    pub fn claim_explore_into_commit(
        &mut self,
        run_id: RunId,
        commit_title: impl Into<String>,
        workspace_dir: Option<PathBuf>,
        local_wall_ms: u64,
    ) -> Result<RunRecord> {
        let existing = self.runs.get_run(run_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::invalid_id("RunId", format!("未知的 Run `{run_id}`"))
        })?;
        if existing.mode != RunMode::Explore || existing.status != RunStatus::Active {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "仅活跃 Explore Run 可认领转入 Commit 态 (current mode={:?}, status={:?})",
                    existing.mode, existing.status
                ),
            });
        }

        let effective_ws = workspace_dir.or(existing.workspace_dir);
        let cp_lock =
            self.lock_spine_checkpoint_for_run(run_id, effective_ws.as_ref(), local_wall_ms)?;

        let transitioned = RunRecord {
            run_id,
            mode: RunMode::Commit,
            status: RunStatus::Active,
            title: commit_title.into(),
            workspace_dir: effective_ws,
            checkpoint_lock: Some(cp_lock),
            touched_sinks: existing.touched_sinks,
            evolved_skills: existing.evolved_skills,
            verification_mark: None,
            updated_hlc: self.spine.local_hlc(),
        };
        self.persist_run_record(transitioned, local_wall_ms)
    }

    /// 正交状态切换：`Commit -> Explore`（必须已完成客观校验闭环，严禁半途逃逸）。
    pub fn return_commit_to_explore(
        &mut self,
        run_id: RunId,
        feedback_summary: impl Into<String>,
        local_wall_ms: u64,
    ) -> Result<RunRecord> {
        let existing = self.runs.get_run(run_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::invalid_id("RunId", format!("未知的 Run `{run_id}`"))
        })?;
        if existing.mode != RunMode::Commit || existing.status != RunStatus::Completed {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: format!("Commit Run `{run_id}` 尚未通过验收结项，禁止提前回归 Explore 态"),
            });
        }
        if existing.requires_clean_room_verifier() && existing.verification_mark.is_none() {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: String::from(
                    "高危/代码变更 Commit Run 缺少 VerificationMark，禁止回归 Explore",
                ),
            });
        }

        let next_record = RunRecord {
            run_id,
            mode: RunMode::Explore,
            status: RunStatus::Active,
            title: feedback_summary.into(),
            workspace_dir: existing.workspace_dir,
            checkpoint_lock: None,
            touched_sinks: BTreeSet::new(),
            evolved_skills: existing.evolved_skills,
            verification_mark: existing.verification_mark,
            updated_hlc: self.spine.local_hlc(),
        };
        self.persist_run_record(next_record, local_wall_ms)
    }

    /// 在 CoW 沙箱工作区内零人工弹窗即时注册新合成的自演化技能（`Explore` 与 `Commit` 均支持）。
    pub fn synthesize_evolved_skill(
        &mut self,
        run_id: RunId,
        worker_ceiling: &CapabilitySet,
        scope_chain: &ScopeChain,
        authored_bindings: &BTreeSet<String>,
        spec: EvolvedSkillSpec,
        local_wall_ms: u64,
    ) -> Result<EvolvedSkillDescriptor> {
        let run = self.runs.get_run(run_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::invalid_id("RunId", format!("未知的 Run `{run_id}`"))
        })?;
        if run.status != RunStatus::Active {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("非活跃状态的 Run `{run_id}` 无法注册自演化技能"),
            });
        }
        let ws = run
            .workspace_dir
            .clone()
            .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                detail: format!("Run `{run_id}` 未绑定沙箱工作区目录，无法注册本地技能"),
            })?;

        // 确定性求值该 Worker Run 是否拥有至少一项宿主注册的 SandboxSelfEvolution 授权
        let self_evolve_cap_id = self
            .registry
            .list_capabilities()
            .into_iter()
            .find(|c| {
                matches!(c.origin, CapabilityOrigin::HostRegistered)
                    && c.sink_class == SinkClass::SandboxSelfEvolution
                    && authored_bindings.contains(&c.capability_id)
            })
            .map(|c| c.capability_id.clone())
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: String::from("当前绑定集合未授予 SandboxSelfEvolution 自演化权限"),
            })?;

        let _ = self.authorize_capability(
            PrincipalRole::Worker,
            Some(run_id),
            worker_ceiling.clone(),
            scope_chain.clone(),
            authored_bindings.clone(),
            &CapabilityInvocation::new(
                self_evolve_cap_id,
                format!(r#"{{"synthesize_skill":"{}"}}"#, spec.skill_id),
            ),
            local_wall_ms,
        )?;

        let descriptor = self.registry.register_evolved_skill(run_id, &ws, spec)?;
        let _ = self.append_kernel_payload(
            KernelSpinePayload::SkillSynthesized {
                skill: descriptor.clone(),
            },
            local_wall_ms,
        )?;

        if let Some(mut updated_run) = self.runs.get_run(run_id).cloned() {
            if !updated_run.evolved_skills.contains(&descriptor.skill_id) {
                updated_run.evolved_skills.push(descriptor.skill_id.clone());
            }
            let _ = self.persist_run_record(updated_run, local_wall_ms)?;
        }

        Ok(descriptor)
    }

    /// 在真实无容器 OS 沙箱中执行当前 `Run` 新合成的本地自演化技能（强制断网隔离防旁路外泄）。
    #[allow(clippy::too_many_arguments)]
    pub fn execute_evolved_skill(
        &mut self,
        run_id: RunId,
        skill_id: &str,
        args: Vec<String>,
        worker_ceiling: &CapabilitySet,
        scope_chain: &ScopeChain,
        authored_bindings: &BTreeSet<String>,
        local_wall_ms: u64,
    ) -> Result<SandboxExecutionOutput> {
        let run = self.runs.get_run(run_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::invalid_id("RunId", format!("未知的 Run `{run_id}`"))
        })?;
        if run.status != RunStatus::Active {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("非活跃状态的 Run `{run_id}` 无法执行自演化技能"),
            });
        }
        let ws = run
            .workspace_dir
            .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                detail: format!("Run `{run_id}` 未绑定沙箱工作区目录"),
            })?;

        let args_json = serde_json::to_string(&args).unwrap_or_else(|_| String::from("[]"));
        let _ = self.authorize_capability(
            PrincipalRole::Worker,
            Some(run_id),
            worker_ceiling.clone(),
            scope_chain.clone(),
            authored_bindings.clone(),
            &CapabilityInvocation::new(skill_id, args_json),
            local_wall_ms,
        )?;

        let skill = self
            .registry
            .get_evolved_skill(skill_id)
            .cloned()
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!("未找到已注册的自演化技能 `{skill_id}`"),
            })?;
        if skill.run_id != run_id {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("禁止跨 Run 调用他人的沙箱本地自演化技能 `{skill_id}`"),
            });
        }

        let (script_full_path, actual_blake3) =
            validate_and_hash_evolved_skill_script(&ws, &skill.relative_script_path)?;
        if actual_blake3 != skill.script_blake3 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "自演化技能脚本 `{skill_id}` 内容哈希与注册快照不符，请重新合成注册"
                ),
            });
        }

        let ticket = self.sandbox.mint_ticket(TicketRequest {
            run_id,
            workspace_dir: ws,
            mode: SandboxMode::WorkspaceWritable,
            network_policy: NetworkPolicy::Isolated,
            ttl_ms: Some(30_000),
            now_wall_ms: local_wall_ms,
        })?;

        let mut cmd_args = Vec::with_capacity(1 + args.len());
        cmd_args.push(script_full_path.to_string_lossy().into_owned());
        cmd_args.extend(args);
        let cmd = SandboxCommand::new(skill.interpreter, cmd_args);

        self.sandbox
            .execute_with_ticket(&ticket, &cmd, local_wall_ms)
    }

    /// 每次能力调用到达时在模型外确定性重算 `Grant`、记录动作账本并执行外部写前幂等锁定。
    #[allow(clippy::too_many_arguments)]
    pub fn authorize_capability(
        &mut self,
        principal: PrincipalRole,
        run_id: Option<RunId>,
        worker_ceiling: CapabilitySet,
        scope_chain: ScopeChain,
        authored_bindings: BTreeSet<String>,
        invocation: &CapabilityInvocation,
        local_wall_ms: u64,
    ) -> Result<KernelDispatchDecision> {
        let run_mode = match run_id {
            Some(rid) => {
                let rec = self.runs.get_run(rid).ok_or_else(|| {
                    QuetzalcoatlError::invalid_id("RunId", format!("未知的 Run `{rid}`"))
                })?;
                if rec.status != RunStatus::Active && rec.status != RunStatus::VerifiedPendingMark {
                    return Err(QuetzalcoatlError::PermissionDenied {
                        detail: format!(
                            "Run `{rid}` 已处于终态 {:?}，禁止继续执行能力",
                            rec.status
                        ),
                    });
                }
                Some(rec.mode)
            }
            None => None,
        };

        let eval_hlc = self.spine.local_hlc().tick(
            local_wall_ms,
            self.spine.local_device().device_id().hlc_node_tag(),
        )?;
        let outbox_before = self.ledger.outbox().len();

        let ctx = GrantContext {
            principal,
            run_id,
            run_mode,
            worker_ceiling,
            scope_chain,
            authored_bindings,
            lease_posture: self.lease_posture,
        };

        let eval_res = self.grant_engine.evaluate(
            &self.registry,
            &ctx,
            invocation,
            eval_hlc,
            &mut self.ledger,
        );

        if let Some(latest_movement) = self.ledger.records().last().cloned() {
            let _ = self.append_kernel_payload(
                KernelSpinePayload::MovementLogged {
                    movement: latest_movement,
                },
                local_wall_ms,
            )?;
        }
        if self.ledger.outbox().len() > outbox_before
            && let Some(latest_outbox) = self.ledger.outbox().last().cloned()
        {
            let _ = self.append_kernel_payload(
                KernelSpinePayload::OutboxQueued {
                    item: latest_outbox,
                },
                local_wall_ms,
            )?;
        }

        let granted = eval_res?;

        // 外部高危写或外发通道动作：强制执行写前幂等令牌预写落盘
        let mut write_ahead: Option<ExternalWriteDisposition> = None;
        if let Some(rid) = run_id
            && (granted.resolved_sink == SinkClass::HighRiskExternalWrite
                || granted.surface == ExecutionSurface::ExternalChannel)
        {
            let idem_key = invocation.idempotency_key.clone().unwrap_or_else(|| {
                format!("auto:{}:{}", granted.capability_id, granted.movement_id)
            });
            let disposition = self.runs.check_or_issue_write_ahead_token(
                rid,
                &granted.capability_id,
                &idem_key,
                &invocation.arguments_json,
                self.spine.local_hlc(),
            )?;
            if let ExternalWriteDisposition::PermittedNew { ref token } = disposition {
                let _ = self.append_kernel_payload(
                    KernelSpinePayload::WriteAheadTokenIssued {
                        token: token.clone(),
                    },
                    local_wall_ms,
                )?;
            }
            write_ahead = Some(disposition);
        }

        // 将内核权威判定的 SinkClass 记入对应 Run 的触达汇点集合；
        // 若此前处于 VerifiedPendingMark 状态且新触发了高危/代码变更动作，立即退回 Active 强制重验！
        if let Some(rid) = run_id
            && let Some(mut rec) = self.runs.get_run(rid).cloned()
        {
            let sink_inserted = rec.touched_sinks.insert(granted.resolved_sink);
            let invalidated_pending = rec.status == RunStatus::VerifiedPendingMark
                && granted.resolved_sink.requires_clean_room_verifier();
            if invalidated_pending {
                rec.status = RunStatus::Active;
            }
            if sink_inserted || invalidated_pending {
                let _ = self.persist_run_record(rec, local_wall_ms)?;
            } else if let Some(in_mem) = self.runs.get_run_mut(rid) {
                in_mem.updated_hlc = self.spine.local_hlc();
            }
        }

        Ok(KernelDispatchDecision {
            granted,
            write_ahead,
        })
    }

    /// 日常对话 / 生活陪伴 / 普通伴学 `Commit Run` 免检结项（0 次洁净室子进程开销；若曾触及代码或高危汇点则硬拦截）。
    pub fn complete_commit_run_without_verifier(
        &mut self,
        run_id: RunId,
        local_wall_ms: u64,
    ) -> Result<CommitCompletionReport> {
        let mut run = self.runs.get_run(run_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::invalid_id("RunId", format!("未知的 Run `{run_id}`"))
        })?;
        if run.mode != RunMode::Commit {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: format!("Run `{run_id}` 非 Commit 模式，无法执行 Commit 结项"),
            });
        }
        if run.requires_clean_room_verifier() {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: format!(
                    "Commit Run `{run_id}` 触及高危或代码变更汇点 ({:?})，强制要求通过断网洁净室 CleanRoomVerifierDag 验收",
                    run.touched_sinks
                ),
            });
        }

        run.status = RunStatus::Completed;
        let saved = self.persist_run_record(run, local_wall_ms)?;
        Ok(CommitCompletionReport {
            run_id,
            verifier_runs: 0,
            verification_mark: None,
            final_status: saved.status,
        })
    }

    /// 第一阶段客观验收：在断网只读洁净室沙箱中运行 `CleanRoomVerifierDag` 并生成候选收据。
    pub fn verify_commit_candidate(
        &mut self,
        run_id: RunId,
        dag: &CleanRoomVerifierDag,
        local_wall_ms: u64,
    ) -> Result<VerifiedCandidateReceipt> {
        let mut run = self.runs.get_run(run_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::invalid_id("RunId", format!("未知的 Run `{run_id}`"))
        })?;
        if run.mode != RunMode::Commit {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: format!("Run `{run_id}` 非 Commit 模式，无法执行洁净室校验"),
            });
        }
        if run.status == RunStatus::Completed || run.status == RunStatus::Aborted {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: format!("Run `{run_id}` 已处于终态 {:?}", run.status),
            });
        }
        let candidate_ws =
            run.workspace_dir
                .clone()
                .ok_or_else(|| QuetzalcoatlError::VerificationFailed {
                    detail: format!("Commit Run `{run_id}` 缺少候选工作区路径"),
                })?;

        let receipt = self
            .verifier
            .execute_dag(&self.sandbox, run_id, &candidate_ws, dag)?;

        run.status = RunStatus::VerifiedPendingMark;
        let _ = self.persist_run_record(run, local_wall_ms)?;
        Ok(receipt)
    }

    /// 第二阶段签发凭证并结项：复核候选工作区树 `BLAKE3` 未发生漂移后签发 `VerificationMark` 并封存脊柱检查点。
    pub fn finalize_commit_with_receipt(
        &mut self,
        receipt: &VerifiedCandidateReceipt,
        local_wall_ms: u64,
    ) -> Result<CommitCompletionReport> {
        let mut run = self.runs.get_run(receipt.run_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::invalid_id("RunId", format!("未知的 Run `{}`", receipt.run_id))
        })?;
        if run.mode != RunMode::Commit {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: String::from("仅 Commit Run 可签发 VerificationMark 结项"),
            });
        }
        if run.status != RunStatus::VerifiedPendingMark {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: format!(
                    "Commit Run `{}` 当前状态为 {:?}，必须先通过最新候选校验进入 VerifiedPendingMark",
                    receipt.run_id, run.status
                ),
            });
        }
        if run.workspace_dir.as_deref() != Some(receipt.candidate_workspace.as_path()) {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("候选校验收据绑定的工作区路径与目标 Commit Run 不一致"),
            });
        }

        let mark_hlc = self.spine.local_hlc().tick(
            local_wall_ms,
            self.spine.local_device().device_id().hlc_node_tag(),
        )?;
        let mark = self.verifier.mint_mark_for_receipt(receipt, mark_hlc)?;
        mark.verify_integrity()?;

        run.status = RunStatus::Completed;
        run.verification_mark = Some(mark.clone());
        let saved = self.persist_run_record(run, local_wall_ms)?;
        let _ = self
            .spine
            .seal_checkpoint(Some(receipt.run_id), local_wall_ms)?;

        Ok(CommitCompletionReport {
            run_id: receipt.run_id,
            verifier_runs: receipt.verifier_runs,
            verification_mark: Some(mark),
            final_status: saved.status,
        })
    }

    /// 按汇点自动路由 `Commit Run` 结项：普通问答免检零延迟秒结；代码/高危汇点强制执行洁净室 `CleanRoomVerifierDag`。
    pub fn complete_commit_run(
        &mut self,
        run_id: RunId,
        dag: Option<&CleanRoomVerifierDag>,
        local_wall_ms: u64,
    ) -> Result<CommitCompletionReport> {
        let requires_verifier = self
            .runs
            .get_run(run_id)
            .map(RunRecord::requires_clean_room_verifier)
            .unwrap_or(false);

        match (requires_verifier, dag) {
            (false, None) => self.complete_commit_run_without_verifier(run_id, local_wall_ms),
            (_, Some(verifier_dag)) => {
                let receipt = self.verify_commit_candidate(run_id, verifier_dag, local_wall_ms)?;
                self.finalize_commit_with_receipt(&receipt, local_wall_ms)
            }
            (true, None) => Err(QuetzalcoatlError::VerificationFailed {
                detail: format!(
                    "Commit Run `{run_id}` 触及高危或代码变更汇点，必须提供 CleanRoomVerifierDag"
                ),
            }),
        }
    }

    /// 从状态脊柱确定性重水合 `Run`、动作账本、断网 Outbox、写前幂等令牌与自演化技能记录。
    pub fn rehydrate_from_spine(&mut self) -> Result<usize> {
        self.ledger.clear_for_rehydrate();
        let all_events = self.spine.store().list_all_events()?;
        for (ev, _) in all_events {
            let Ok(env) = serde_json::from_str::<KernelSpineEnvelope>(&ev.payload_utf8) else {
                continue;
            };
            match env.event {
                KernelSpinePayload::SkillSynthesized { skill } => {
                    self.registry.restore_evolved_skill(skill);
                }
                KernelSpinePayload::MovementLogged { movement } => {
                    self.ledger.record_movement(movement);
                }
                KernelSpinePayload::OutboxQueued { item } => {
                    self.ledger.enqueue_outbox(item);
                }
                KernelSpinePayload::OutboxDrained { epoch, .. } => {
                    let _ = self.ledger.drain_reconciled_outbox(Epoch::new(epoch));
                }
                KernelSpinePayload::RunUpserted { .. }
                | KernelSpinePayload::WriteAheadTokenIssued { .. } => {}
            }
        }
        self.runs.rehydrate_from_spine(&self.spine)
    }
}

fn cp_lock_hlc_fallback<S: MaterializedStore>(spine: &SpineEngine<S>) -> HlcTimestamp {
    spine.local_hlc()
}
