#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 确定性能力授权交集引擎（`Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings`）、两态租约门禁与动作审计账本。

use std::collections::BTreeSet;

use quetzalcoatl_types::{Epoch, HlcTimestamp, QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::registry::{CapabilityOrigin, ExecutionSurface, InterfaceRegistry, SinkClass};
use crate::run_machine::RunMode;

/// 执行主体逻辑角色。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalRole {
    Router,
    Worker,
}

/// 两态围栏租约姿态（联网见证全权态 vs 断网分区本地受限态）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "posture", rename_all = "snake_case")]
pub enum LeasePosture {
    Witnessed { witness_epoch: Epoch },
    PartitionLocal,
}

/// 能力集合抽象（支持全集单位元与显式有限集合交集运算）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "items", rename_all = "snake_case")]
pub enum CapabilitySet {
    All,
    Explicit(BTreeSet<String>),
}

impl CapabilitySet {
    #[must_use]
    pub fn explicit<I, S>(iter: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::Explicit(iter.into_iter().map(Into::into).collect())
    }

    #[must_use]
    pub fn contains(&self, capability_id: &str) -> bool {
        match self {
            Self::All => true,
            Self::Explicit(set) => set.contains(capability_id),
        }
    }

    #[must_use]
    pub fn intersect(&self, other: &Self) -> Self {
        match (self, other) {
            (Self::All, rhs) => rhs.clone(),
            (lhs, Self::All) => lhs.clone(),
            (Self::Explicit(a), Self::Explicit(b)) => {
                Self::Explicit(a.intersection(b).cloned().collect())
            }
        }
    }
}

/// 多跳衰减授权范围链（每增加一跳只能单调收窄权限交集，绝不可越跳扩权）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeChain {
    hops: Vec<BTreeSet<String>>,
}

impl ScopeChain {
    #[must_use]
    pub fn unrestricted() -> Self {
        Self { hops: Vec::new() }
    }

    #[must_use]
    pub fn from_hops(hops: Vec<BTreeSet<String>>) -> Self {
        Self { hops }
    }

    #[must_use]
    pub fn attenuate<I, S>(&self, hop_ceiling: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut next = self.hops.clone();
        next.push(hop_ceiling.into_iter().map(Into::into).collect());
        Self { hops: next }
    }

    #[must_use]
    pub fn hops(&self) -> &[BTreeSet<String>] {
        &self.hops
    }

    /// 计算整条委派链的单调衰减交集：$\bigcap_{i=0}^{k-1} \text{hop}_i$。
    #[must_use]
    pub fn effective_ceiling(&self) -> CapabilitySet {
        let mut iter = self.hops.iter();
        let Some(first) = iter.next() else {
            return CapabilitySet::All;
        };
        let mut acc = first.clone();
        for hop in iter {
            acc = acc.intersection(hop).cloned().collect();
        }
        CapabilitySet::Explicit(acc)
    }
}

/// 单次能力求值上下文。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantContext {
    pub principal: PrincipalRole,
    pub run_id: Option<RunId>,
    pub run_mode: Option<RunMode>,
    pub worker_ceiling: CapabilitySet,
    pub scope_chain: ScopeChain,
    pub authored_bindings: BTreeSet<String>,
    pub lease_posture: LeasePosture,
}

/// 能力调用请求（即使模型传入伪造的 `model_claimed_sink`，内核亦完全忽略）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityInvocation {
    pub capability_id: String,
    pub arguments_json: String,
    pub idempotency_key: Option<String>,
    pub model_claimed_sink: Option<SinkClass>,
}

impl CapabilityInvocation {
    #[must_use]
    pub fn new(capability_id: impl Into<String>, arguments_json: impl Into<String>) -> Self {
        Self {
            capability_id: capability_id.into(),
            arguments_json: arguments_json.into(),
            idempotency_key: None,
            model_claimed_sink: None,
        }
    }
}

/// 动作账本裁决结果。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MovementOutcome {
    Granted,
    DeliveryRefused,
    PermissionDenied,
    QueuedPartitionOutbox,
}

/// 不可变动作审计记录（含拒绝投递与断网暂存记录）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MovementRecord {
    pub movement_id: Uuid,
    pub run_id: Option<RunId>,
    pub principal: PrincipalRole,
    pub run_mode: Option<RunMode>,
    pub lease_posture: LeasePosture,
    pub capability_id: String,
    pub resolved_sink: Option<SinkClass>,
    pub outcome: MovementOutcome,
    pub detail: String,
    pub hlc: HlcTimestamp,
}

/// 断网分区本地租约期间暂存的非幂等公网外发队列项。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxItem {
    pub outbox_id: Uuid,
    pub run_id: Option<RunId>,
    pub capability_id: String,
    pub arguments_json: String,
    pub idempotency_key: Option<String>,
    pub queued_hlc: HlcTimestamp,
}

/// 通过全部门禁核准的能力调用凭证。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantedInvocation {
    pub capability_id: String,
    pub resolved_sink: SinkClass,
    pub surface: ExecutionSurface,
    pub movement_id: Uuid,
}

/// 内核动作账本与断网暂存发件箱。
#[derive(Clone, Debug, Default)]
pub struct MovementLedger {
    records: Vec<MovementRecord>,
    outbox: Vec<OutboxItem>,
}

impl MovementLedger {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn records(&self) -> &[MovementRecord] {
        &self.records
    }

    #[must_use]
    pub fn outbox(&self) -> &[OutboxItem] {
        &self.outbox
    }

    pub fn record_movement(&mut self, record: MovementRecord) {
        self.records.push(record);
    }

    pub fn enqueue_outbox(&mut self, item: OutboxItem) {
        self.outbox.push(item);
    }

    pub fn drain_reconciled_outbox(&mut self, _witness_epoch: Epoch) -> Vec<OutboxItem> {
        std::mem::take(&mut self.outbox)
    }

    pub(crate) fn clear_for_rehydrate(&mut self) {
        self.records.clear();
        self.outbox.clear();
    }
}

/// 模型外确定性能力授权重算引擎。
#[derive(Clone, Debug, Default)]
pub struct GrantEngine;

impl GrantEngine {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// 每次请求到达时在模型外确定性重算 `Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings`。
    #[must_use]
    pub fn compute_effective_grant(
        registry: &InterfaceRegistry,
        ctx: &GrantContext,
    ) -> BTreeSet<String> {
        let ceiling = ctx
            .worker_ceiling
            .intersect(&ctx.scope_chain.effective_ceiling());

        let mut granted = BTreeSet::<String>::new();
        for bound_cap in &ctx.authored_bindings {
            if ceiling.contains(bound_cap)
                && let Some(desc) = registry.get_capability(bound_cap)
            {
                if let CapabilityOrigin::SandboxEvolved { run_id, .. } = &desc.origin
                    && (ctx.principal != PrincipalRole::Worker || ctx.run_id != Some(*run_id))
                {
                    continue;
                }
                granted.insert(bound_cap.clone());
            }
        }

        // 若当前 Worker Run 已在交集内获得至少一项宿主级 SandboxSelfEvolution 授权，
        // 则允许同一 Run 即时调用自己合成在 CoW 沙箱内的自演化技能（零人工审批弹窗）。
        let has_self_evolve_grant = ctx.principal == PrincipalRole::Worker
            && granted.iter().any(|cap_id| {
                registry
                    .get_capability(cap_id)
                    .map(|desc| {
                        matches!(desc.origin, CapabilityOrigin::HostRegistered)
                            && desc.sink_class == SinkClass::SandboxSelfEvolution
                    })
                    .unwrap_or(false)
            });

        if has_self_evolve_grant && let Some(active_run_id) = ctx.run_id {
            for desc in registry.list_capabilities() {
                if let CapabilityOrigin::SandboxEvolved { run_id, .. } = &desc.origin
                    && *run_id == active_run_id
                {
                    granted.insert(desc.capability_id.clone());
                }
            }
        }

        // 架构级硬剥夺 `Router` 的终端、文件改写、代码库变更与沙箱自演化能力
        if ctx.principal == PrincipalRole::Router {
            granted.retain(|cap_id| {
                registry
                    .get_capability(cap_id)
                    .map(|desc| {
                        !matches!(
                            desc.surface,
                            ExecutionSurface::SandboxShell | ExecutionSurface::SandboxFileWrite
                        ) && !matches!(
                            desc.sink_class,
                            SinkClass::CodeRepositoryMutation | SinkClass::SandboxSelfEvolution
                        )
                    })
                    .unwrap_or(false)
            });
        }

        // `Explore Run` 硬剥夺一切外部通道与高危外部写能力
        if ctx.run_mode == Some(RunMode::Explore) {
            granted.retain(|cap_id| {
                registry
                    .get_capability(cap_id)
                    .map(|desc| {
                        matches!(
                            desc.sink_class,
                            SinkClass::LocalRead | SinkClass::SandboxSelfEvolution
                        ) && desc.surface != ExecutionSurface::ExternalChannel
                    })
                    .unwrap_or(false)
            });
        }

        granted
    }

    pub fn evaluate(
        &self,
        registry: &InterfaceRegistry,
        ctx: &GrantContext,
        invocation: &CapabilityInvocation,
        hlc: HlcTimestamp,
        ledger: &mut MovementLedger,
    ) -> Result<GrantedInvocation> {
        // 严格从内核注册表解析汇点分类，完全忽略 invocation.model_claimed_sink
        let Some(desc) = registry.get_capability(&invocation.capability_id) else {
            let detail = format!("拒绝未在盲内核注册的能力 `{}`", invocation.capability_id);
            ledger.record_movement(MovementRecord {
                movement_id: Uuid::new_v4(),
                run_id: ctx.run_id,
                principal: ctx.principal,
                run_mode: ctx.run_mode,
                lease_posture: ctx.lease_posture,
                capability_id: invocation.capability_id.clone(),
                resolved_sink: None,
                outcome: MovementOutcome::PermissionDenied,
                detail: detail.clone(),
                hlc,
            });
            return Err(QuetzalcoatlError::PermissionDenied { detail });
        };

        let resolved_sink = desc.sink_class;
        let surface = desc.surface;

        // 1. 架构级能力剥夺：Router 严禁触碰终端、文件写、代码仓库变更或沙箱自演化
        if ctx.principal == PrincipalRole::Router
            && (matches!(
                surface,
                ExecutionSurface::SandboxShell | ExecutionSurface::SandboxFileWrite
            ) || matches!(
                resolved_sink,
                SinkClass::CodeRepositoryMutation | SinkClass::SandboxSelfEvolution
            ))
        {
            let detail = format!(
                "架构级能力剥夺：Router 角色禁止调用终端/改文件/代码变更能力 `{}`",
                invocation.capability_id
            );
            ledger.record_movement(MovementRecord {
                movement_id: Uuid::new_v4(),
                run_id: ctx.run_id,
                principal: ctx.principal,
                run_mode: ctx.run_mode,
                lease_posture: ctx.lease_posture,
                capability_id: invocation.capability_id.clone(),
                resolved_sink: Some(resolved_sink),
                outcome: MovementOutcome::PermissionDenied,
                detail: detail.clone(),
                hlc,
            });
            return Err(QuetzalcoatlError::PermissionDenied { detail });
        }

        // 2. Explore Run 外部隔离门禁：仅放行本地只读与沙箱本地自演化，一切外发与仓库写硬拒并记账 DeliveryRefused
        if ctx.run_mode == Some(RunMode::Explore)
            && (!matches!(
                resolved_sink,
                SinkClass::LocalRead | SinkClass::SandboxSelfEvolution
            ) || surface == ExecutionSurface::ExternalChannel)
        {
            let detail = format!(
                "探索态隔离门禁：Explore Run 硬拒外部写与非沙箱汇点能力 `{}` (sink={resolved_sink:?})",
                invocation.capability_id
            );
            ledger.record_movement(MovementRecord {
                movement_id: Uuid::new_v4(),
                run_id: ctx.run_id,
                principal: ctx.principal,
                run_mode: ctx.run_mode,
                lease_posture: ctx.lease_posture,
                capability_id: invocation.capability_id.clone(),
                resolved_sink: Some(resolved_sink),
                outcome: MovementOutcome::DeliveryRefused,
                detail: detail.clone(),
                hlc,
            });
            return Err(QuetzalcoatlError::DeliveryRefused { detail });
        }

        // 3. 确定性交集求值：Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings
        let effective = Self::compute_effective_grant(registry, ctx);
        if !effective.contains(&invocation.capability_id) {
            let detail = format!(
                "能力 `{}` 不在有效授权交集 (WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings) 内",
                invocation.capability_id
            );
            ledger.record_movement(MovementRecord {
                movement_id: Uuid::new_v4(),
                run_id: ctx.run_id,
                principal: ctx.principal,
                run_mode: ctx.run_mode,
                lease_posture: ctx.lease_posture,
                capability_id: invocation.capability_id.clone(),
                resolved_sink: Some(resolved_sink),
                outcome: MovementOutcome::PermissionDenied,
                detail: detail.clone(),
                hlc,
            });
            return Err(QuetzalcoatlError::PermissionDenied { detail });
        }

        // 4. 两态围栏租约门禁：PartitionLocal 放行本地对话、探索与紧急本地看护告警，非幂等公网外发暂存 Outbox
        if ctx.lease_posture == LeasePosture::PartitionLocal {
            let blocked_in_partition = (resolved_sink == SinkClass::HighRiskExternalWrite
                && !desc.idempotent)
                || (surface == ExecutionSurface::ExternalChannel
                    && !desc.idempotent
                    && resolved_sink != SinkClass::EmergencyLocalAlert);

            if blocked_in_partition {
                ledger.enqueue_outbox(OutboxItem {
                    outbox_id: Uuid::new_v4(),
                    run_id: ctx.run_id,
                    capability_id: invocation.capability_id.clone(),
                    arguments_json: invocation.arguments_json.clone(),
                    idempotency_key: invocation.idempotency_key.clone(),
                    queued_hlc: hlc,
                });
                let detail = format!(
                    "断网分区受限租约：非幂等外发动作 `{}` 已暂存 Outbox 待重获见证纪元后对账发送",
                    invocation.capability_id
                );
                ledger.record_movement(MovementRecord {
                    movement_id: Uuid::new_v4(),
                    run_id: ctx.run_id,
                    principal: ctx.principal,
                    run_mode: ctx.run_mode,
                    lease_posture: ctx.lease_posture,
                    capability_id: invocation.capability_id.clone(),
                    resolved_sink: Some(resolved_sink),
                    outcome: MovementOutcome::QueuedPartitionOutbox,
                    detail: detail.clone(),
                    hlc,
                });
                return Err(QuetzalcoatlError::PartitionRestricted { detail });
            }
        }

        let movement_id = Uuid::new_v4();
        ledger.record_movement(MovementRecord {
            movement_id,
            run_id: ctx.run_id,
            principal: ctx.principal,
            run_mode: ctx.run_mode,
            lease_posture: ctx.lease_posture,
            capability_id: invocation.capability_id.clone(),
            resolved_sink: Some(resolved_sink),
            outcome: MovementOutcome::Granted,
            detail: String::from("ok"),
            hlc,
        });

        Ok(GrantedInvocation {
            capability_id: invocation.capability_id.clone(),
            resolved_sink,
            surface,
            movement_id,
        })
    }
}
