#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `FencedLeaseCoordinator` — 两态围栏动态 `Router` 租约协调器（防坑规范 #7 & Review Focus #2）。

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use iroh::EndpointAddr;
use quetzalcoatl_crypto::{PackCompartment, SealedPackfile};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityInvocation, CapabilitySet, ExternalWriteDisposition, LeasePosture,
    OutboxItem, PrincipalRole, ScopeChain,
};
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{AgentId, ArtifactId, DeviceId, Epoch, QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::endpoint::{
    FabricNode, FabricRpcRequest, FabricRpcResponse, HubClient, LeaseWitnessRecord,
};
use crate::sync_actor::{SpineSyncActor, SpineSyncBackend};

const FABRIC_DELIVERY_SCHEMA: &str = "quetzalcoatl/v2/fabric-external-delivery-v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct FabricDeliverySpineRecord {
    schema: String,
    capability_id: String,
    idempotency_key: String,
    witness_epoch: u64,
    outbox_id: Option<Uuid>,
    #[serde(default)]
    aborted_before_send: bool,
}

#[derive(Deserialize)]
struct PartialKernelEnvelope {
    schema: String,
    event: serde_json::Value,
}

#[derive(Deserialize)]
struct OutboxQueuedOnly {
    item: OutboxItem,
}

/// 单调时钟抽象（生产环境基于 `std::time::Instant`，混沌分区测试可注入确定性休眠跳变时钟）。
pub trait MonotonicClock: Send + Sync + 'static {
    fn now_millis(&self) -> u64;
}

/// 生产级 `std::time::Instant` 单调时钟。
#[derive(Clone, Debug)]
pub struct StdMonotonicClock {
    origin: Instant,
}

impl Default for StdMonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl StdMonotonicClock {
    #[must_use]
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl MonotonicClock for StdMonotonicClock {
    fn now_millis(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// 供确定性仿真使用的可控单调时钟（支持模拟笔记本合盖休眠 2 小时瞬间跳变）。
#[derive(Clone, Debug, Default)]
pub struct SimulatedMonotonicClock {
    now_ms: Arc<AtomicU64>,
}

impl SimulatedMonotonicClock {
    #[must_use]
    pub fn new(initial_ms: u64) -> Self {
        Self {
            now_ms: Arc::new(AtomicU64::new(initial_ms)),
        }
    }

    pub fn advance_ms(&self, delta_ms: u64) -> u64 {
        self.now_ms
            .fetch_add(delta_ms, Ordering::SeqCst)
            .saturating_add(delta_ms)
    }

    pub fn set_ms(&self, value_ms: u64) {
        self.now_ms.store(value_ms, Ordering::SeqCst);
    }
}

impl MonotonicClock for SimulatedMonotonicClock {
    fn now_millis(&self) -> u64 {
        self.now_ms.load(Ordering::SeqCst)
    }
}

/// 远端 CAS 租约见证器抽象（生产绑定 Go `quetzalcoatl-hub`，混沌仿真支持故障注入）。
pub trait LeaseWitnessBackend: Send + Sync {
    fn acquire_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        expected_epoch: u64,
        ttl_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>>;

    fn renew_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
        ttl_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>>;

    fn release_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>>;
}

impl LeaseWitnessBackend for HubClient {
    fn acquire_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        expected_epoch: u64,
        ttl_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>> {
        Box::pin(async move {
            self.acquire_lease(agent_id, device_id, expected_epoch, ttl_ms)
                .await
        })
    }

    fn renew_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
        ttl_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>> {
        Box::pin(async move {
            self.renew_lease(agent_id, device_id, witness_epoch, ttl_ms)
                .await
        })
    }

    fn release_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>> {
        Box::pin(async move { self.release_lease(agent_id, device_id, witness_epoch).await })
    }
}

/// 围栏租约协调器参数配置。
#[derive(Clone, Debug)]
pub struct LeaseCoordinatorConfig {
    pub ttl_ms: u64,
    pub safety_margin_ms: u64,
    pub offline_grace_ms: u64,
}

impl Default for LeaseCoordinatorConfig {
    fn default() -> Self {
        Self {
            ttl_ms: 30_000,
            safety_margin_ms: 2_000,
            offline_grace_ms: 5_000,
        }
    }
}

/// 本机逻辑 `Router` 租约状态。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum RouterLeaseState {
    ActiveRouter {
        witness_epoch: Epoch,
        expires_mono_ms: u64,
    },
    Standby {
        known_holder: Option<DeviceId>,
        highest_seen_epoch: u64,
    },
    PartitionLocal {
        entered_mono_ms: u64,
        highest_seen_epoch: u64,
    },
}

/// 围栏保护下的外部通道发送执行结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FencedDeliveryOutcome {
    Delivered { witness_epoch: Epoch },
    DeduplicatedAlreadySent,
    QueuedInOutbox,
}

/// 单次"网络阶段"租约结果（完全不接触 `BlindKernel`，供守护进程在不持有内核锁时执行）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseNetworkOutcome {
    Renewed { witness_epoch: Epoch },
    Acquired { witness_epoch: Epoch },
    Stale { current: u64 },
    Unreachable,
    Skipped,
}

/// 网络阶段产物：待合入内核的远端 `SealedPackfile` 与同步游标。
#[derive(Clone, Debug)]
pub struct LeaseNetworkReport {
    pub outcome: LeaseNetworkOutcome,
    pub fetched_packs: Vec<SealedPackfile>,
    pub uploaded_packs: usize,
    pub new_cursor: u64,
}

/// `Outbox` 对账计划中的单条待投递外发项。
#[derive(Clone, Debug)]
pub struct OutboxReconcileItem {
    pub item: OutboxItem,
    pub idempotency_key: String,
}

/// `Outbox` 对账计划（内核侧完成扫链与写前令牌核验，零网络）。
#[derive(Clone, Debug, Default)]
pub struct OutboxReconcilePlan {
    pub witness_epoch: Option<Epoch>,
    pub items: Vec<OutboxReconcileItem>,
}

/// 单条外发项的真实投递结果。
#[derive(Clone, Debug)]
pub struct OutboxReconcileOutcome {
    pub entry: OutboxReconcileItem,
    pub delivered: bool,
}

/// 两态围栏动态 `Router` 租约协调器。
pub struct FencedLeaseCoordinator<C: MonotonicClock = StdMonotonicClock> {
    clock: C,
    config: LeaseCoordinatorConfig,
    state: RouterLeaseState,
    last_hub_contact_mono_ms: Option<u64>,
    clock_jump_demotions: u64,
    stale_epoch_demotions: u64,
}

impl<C: MonotonicClock> FencedLeaseCoordinator<C> {
    #[must_use]
    pub fn new(clock: C, config: LeaseCoordinatorConfig) -> Self {
        Self {
            clock,
            config,
            state: RouterLeaseState::Standby {
                known_holder: None,
                highest_seen_epoch: 0,
            },
            last_hub_contact_mono_ms: None,
            clock_jump_demotions: 0,
            stale_epoch_demotions: 0,
        }
    }

    #[must_use]
    pub const fn state(&self) -> &RouterLeaseState {
        &self.state
    }

    #[must_use]
    pub const fn config(&self) -> &LeaseCoordinatorConfig {
        &self.config
    }

    #[must_use]
    pub const fn clock_jump_demotions(&self) -> u64 {
        self.clock_jump_demotions
    }

    #[must_use]
    pub const fn stale_epoch_demotions(&self) -> u64 {
        self.stale_epoch_demotions
    }

    #[must_use]
    pub const fn highest_seen_epoch(&self) -> u64 {
        match self.state {
            RouterLeaseState::ActiveRouter { witness_epoch, .. } => witness_epoch.get(),
            RouterLeaseState::Standby {
                highest_seen_epoch, ..
            }
            | RouterLeaseState::PartitionLocal {
                highest_seen_epoch, ..
            } => highest_seen_epoch,
        }
    }

    fn effective_local_ttl_ms(&self) -> u64 {
        self.config
            .ttl_ms
            .saturating_sub(self.config.safety_margin_ms)
            .max(500)
    }

    /// Fix Round 2 / Item 2：网络阶段 0 门禁——在任何 Hub/对等网络 I/O 之前**同时**降级协调器状态
    /// 与内核 `LeasePosture`，返回是否发生了合盖/挂起导致的单调时钟过期降级。
    pub fn begin_network_tick<S: MaterializedStore>(
        &mut self,
        kernel: &mut BlindKernel<S>,
    ) -> bool {
        self.check_monotonic_expiry_before_io(kernel)
    }

    /// Review Focus #2：在发出任何网络包或执行任何外部写之前，先读取本机单调时钟 `Instant` 自检租约是否已过期；
    /// 若合盖休眠后苏醒发现已超期，立即在发包前自降级为 `Standby / PartitionLocal`！
    pub fn check_monotonic_expiry_before_io<S: MaterializedStore>(
        &mut self,
        kernel: &mut BlindKernel<S>,
    ) -> bool {
        let demoted = self.demote_if_monotonic_expired();
        if demoted {
            kernel.set_lease_posture(LeasePosture::PartitionLocal);
        }
        demoted
    }

    /// 零内核依赖的单调时钟过期自检（仅推进协调器状态，由调用方在短锁内应用内核姿态）。
    fn demote_if_monotonic_expired(&mut self) -> bool {
        let now_mono = self.clock.now_millis();
        if let RouterLeaseState::ActiveRouter {
            witness_epoch,
            expires_mono_ms,
        } = self.state
            && now_mono >= expires_mono_ms
        {
            self.clock_jump_demotions = self.clock_jump_demotions.saturating_add(1);
            self.state = RouterLeaseState::Standby {
                known_holder: None,
                highest_seen_epoch: witness_epoch.get(),
            };
            return true;
        }
        false
    }

    /// 观察到来自 Hub 或对等节点的 `witness_epoch`：若高于本地纪元则强制降级；若持有者就是本机则同步提升为 `ActiveRouter`。
    pub fn observe_remote_epoch<S: MaterializedStore>(
        &mut self,
        observed_epoch: u64,
        holder: Option<DeviceId>,
        kernel: &mut BlindKernel<S>,
    ) -> bool {
        let local_dev = kernel.spine().local_device().device_id();
        let now_mono = self.clock.now_millis();
        if holder == Some(local_dev) && observed_epoch > 0 {
            let ep = Epoch::new(observed_epoch);
            self.last_hub_contact_mono_ms = Some(now_mono);
            self.state = RouterLeaseState::ActiveRouter {
                witness_epoch: ep,
                expires_mono_ms: now_mono.saturating_add(self.effective_local_ttl_ms()),
            };
            kernel.set_lease_posture(LeasePosture::Witnessed { witness_epoch: ep });
            return false;
        }

        let current_ep = self.highest_seen_epoch();
        if let RouterLeaseState::ActiveRouter { witness_epoch, .. } = self.state
            && observed_epoch >= witness_epoch.get()
            && holder != Some(local_dev)
        {
            self.stale_epoch_demotions = self.stale_epoch_demotions.saturating_add(1);
            self.state = RouterLeaseState::Standby {
                known_holder: holder,
                highest_seen_epoch: observed_epoch.max(current_ep),
            };
            kernel.set_lease_posture(LeasePosture::PartitionLocal);
            return true;
        }

        if observed_epoch > current_ep {
            self.state = match self.state {
                RouterLeaseState::PartitionLocal {
                    entered_mono_ms, ..
                } => RouterLeaseState::PartitionLocal {
                    entered_mono_ms,
                    highest_seen_epoch: observed_epoch,
                },
                _ => RouterLeaseState::Standby {
                    known_holder: holder,
                    highest_seen_epoch: observed_epoch,
                },
            };
        }
        false
    }

    fn handle_hub_unreachable<S: MaterializedStore>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        now_mono: u64,
    ) {
        if self.classify_hub_unreachable(now_mono) {
            kernel.set_lease_posture(LeasePosture::PartitionLocal);
        }
    }

    /// 零内核依赖的网络不可达分类（返回是否应回落 `PartitionLocal`）。
    fn classify_hub_unreachable(&mut self, now_mono: u64) -> bool {
        let highest = self.highest_seen_epoch();
        let beyond_grace = match self.last_hub_contact_mono_ms {
            Some(last) => now_mono.saturating_sub(last) >= self.config.offline_grace_ms,
            None => true,
        };
        if beyond_grace || !matches!(self.state, RouterLeaseState::ActiveRouter { .. }) {
            let entered = match self.state {
                RouterLeaseState::PartitionLocal {
                    entered_mono_ms, ..
                } => entered_mono_ms,
                _ => now_mono,
            };
            self.state = RouterLeaseState::PartitionLocal {
                entered_mono_ms: entered,
                highest_seen_epoch: highest,
            };
            return true;
        }
        false
    }

    /// 扫描状态脊柱提取全局已提交公网投递的幂等键集合与跨设备历史 `OutboxQueued` 待对账列表。
    fn scan_spine_delivery_state<S: MaterializedStore>(
        kernel: &BlindKernel<S>,
    ) -> Result<(BTreeSet<String>, Vec<OutboxItem>)> {
        let mut committed_keys = BTreeSet::<String>::new();
        let mut queued_by_id = BTreeMap::<Uuid, OutboxItem>::new();
        let mut committed_outbox_ids = BTreeSet::<Uuid>::new();

        for (ev, _) in kernel.spine().store().list_all_events()? {
            if let Ok(rec) = serde_json::from_str::<FabricDeliverySpineRecord>(&ev.payload_utf8)
                && rec.schema == FABRIC_DELIVERY_SCHEMA
            {
                if rec.aborted_before_send {
                    // 投递见证单调：一旦该幂等键被记录为已投递，后续迟到的 abort 记录
                    // （来自其他设备/旧轮次）绝不能把它重新排回待投递队列。
                    if !committed_keys.contains(&rec.idempotency_key)
                        && let Some(oid) = rec.outbox_id
                    {
                        committed_outbox_ids.remove(&oid);
                    }
                } else {
                    committed_keys.insert(rec.idempotency_key);
                    if let Some(oid) = rec.outbox_id {
                        committed_outbox_ids.insert(oid);
                    }
                }
                continue;
            }
            if let Ok(env) = serde_json::from_str::<PartialKernelEnvelope>(&ev.payload_utf8)
                && env.schema == "quetzalcoatl.kernel.v1"
                && env.event.get("kind").and_then(|v| v.as_str()) == Some("outbox_queued")
                && let Ok(parsed) = serde_json::from_value::<OutboxQueuedOnly>(env.event)
            {
                queued_by_id.insert(parsed.item.outbox_id, parsed.item);
            }
        }

        let pending = queued_by_id
            .into_iter()
            .filter(|(oid, item)| {
                !committed_outbox_ids.contains(oid)
                    && !item
                        .idempotency_key
                        .as_ref()
                        .is_some_and(|k| committed_keys.contains(k))
            })
            .map(|(_, item)| item)
            .collect();
        Ok((committed_keys, pending))
    }

    fn has_abort_record<S: MaterializedStore>(
        kernel: &BlindKernel<S>,
        idempotency_key: &str,
    ) -> Result<bool> {
        for (ev, _) in kernel.spine().store().list_all_events()? {
            if let Ok(rec) = serde_json::from_str::<FabricDeliverySpineRecord>(&ev.payload_utf8)
                && rec.schema == FABRIC_DELIVERY_SCHEMA
                && rec.aborted_before_send
                && rec.idempotency_key == idempotency_key
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 内核侧 `Outbox` 对账准备（零网络）：扫链、跳过已见证幂等键、核验 Run 洁净室状态并签发写前令牌。
    pub fn prepare_outbox_reconcile<S: MaterializedStore>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        local_wall_ms: u64,
    ) -> Result<OutboxReconcilePlan> {
        let RouterLeaseState::ActiveRouter { witness_epoch, .. } = self.state else {
            return Ok(OutboxReconcilePlan::default());
        };
        if !kernel.ledger().outbox().is_empty() {
            let _ = kernel.drain_reconciled_outbox(witness_epoch)?;
        }
        let (committed_keys, pending_items) = Self::scan_spine_delivery_state(kernel)?;
        // 同一幂等键可能对应多条 Outbox 行（分区重试/跨设备重建）：必须只保留一条，杜绝同键双发。
        let delivered_keys = committed_keys.clone();
        let mut claimed_keys = committed_keys;
        let mut items = Vec::new();
        for item in pending_items {
            if self.check_monotonic_expiry_before_io(kernel) {
                break;
            }
            let idem_key = item
                .idempotency_key
                .clone()
                .unwrap_or_else(|| format!("outbox:{}", item.outbox_id));
            if !claimed_keys.insert(idem_key.clone()) {
                continue;
            }
            match kernel.commit_reconciled_outbox_item(&item, witness_epoch, local_wall_ms) {
                Ok(ExternalWriteDisposition::DuplicateSuppressed { .. }) => {
                    // 仅当脊柱已存在 delivered 见证时才视为已完成；仅有 abort/预写令牌仍须重试。
                    if delivered_keys.contains(&idem_key) {
                        continue;
                    }
                }
                Ok(_) => {}
                Err(_) => continue,
            }
            items.push(OutboxReconcileItem {
                item,
                idempotency_key: idem_key,
            });
        }
        Ok(OutboxReconcilePlan {
            witness_epoch: Some(witness_epoch),
            items,
        })
    }

    /// 内核侧记录真实投递结果（零网络）：成功写 delivered、失败写 `aborted_before_send=true` 补偿记录，
    /// 返回需上传 Hub 见证的新密封 `SealedPackfile`，由调用方在零内核锁阶段上传。
    pub fn record_outbox_outcomes<S: MaterializedStore>(
        &self,
        kernel: &mut BlindKernel<S>,
        plan: &OutboxReconcilePlan,
        outcomes: &[OutboxReconcileOutcome],
        local_wall_ms: u64,
    ) -> Result<Vec<SealedPackfile>> {
        let Some(witness_epoch) = plan.witness_epoch else {
            return Ok(Vec::new());
        };
        let mut packs = Vec::new();
        for outcome in outcomes {
            let entry = &outcome.entry;
            if !outcome.delivered && Self::has_abort_record(kernel, &entry.idempotency_key)? {
                // 已存在同键补偿记录：通道持续拒收时不再重复写盘，避免脊柱无界膨胀。
                continue;
            }
            let delivery_record = FabricDeliverySpineRecord {
                schema: String::from(FABRIC_DELIVERY_SCHEMA),
                capability_id: entry.item.capability_id.clone(),
                idempotency_key: entry.idempotency_key.clone(),
                witness_epoch: witness_epoch.get(),
                outbox_id: Some(entry.item.outbox_id),
                aborted_before_send: !outcome.delivered,
            };
            let encoded = serde_json::to_string(&delivery_record).map_err(|e| {
                QuetzalcoatlError::SerializationError {
                    detail: e.to_string(),
                }
            })?;
            let _ =
                kernel
                    .spine_mut()
                    .append_event(PackCompartment::Core, &encoded, local_wall_ms)?;
            let sealed = kernel
                .spine_mut()
                .seal_checkpoint(entry.item.run_id, local_wall_ms)?;
            packs.extend(sealed);
        }
        Ok(packs)
    }

    #[allow(clippy::too_many_arguments)]
    async fn reconcile_pending_outbox<S: MaterializedStore, F>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        sync_actor: &mut SpineSyncActor,
        lease_backend: &dyn LeaseWitnessBackend,
        sync_backend: &dyn SpineSyncBackend,
        witness_epoch: Epoch,
        local_wall_ms: u64,
        mut outbox_deliver_fn: F,
    ) -> Result<()>
    where
        F: FnMut(&str, &str, &str, Epoch) -> Result<()>,
    {
        let plan = self.prepare_outbox_reconcile(kernel, local_wall_ms)?;
        if plan.items.is_empty() {
            return Ok(());
        }
        let agent_id = kernel.spine().agent_id();
        let local_dev_id = kernel.spine().local_device().device_id();

        let mut outcomes = Vec::new();
        for entry in plan.items.clone() {
            if self.check_monotonic_expiry_before_io(kernel) {
                break;
            }
            // 逐条在 Hub 上续租核验 witness_epoch 仍归本机所有（失败则不触碰任何本地幂等状态）。
            let pre_mono = self.clock.now_millis();
            match lease_backend
                .renew_lease(
                    agent_id,
                    local_dev_id,
                    witness_epoch.get(),
                    self.config.ttl_ms,
                )
                .await
            {
                Ok(rec) => {
                    let ep = Epoch::new(rec.witness_epoch);
                    self.last_hub_contact_mono_ms = Some(pre_mono);
                    self.state = RouterLeaseState::ActiveRouter {
                        witness_epoch: ep,
                        expires_mono_ms: pre_mono.saturating_add(self.effective_local_ttl_ms()),
                    };
                    kernel.set_lease_posture(LeasePosture::Witnessed { witness_epoch: ep });
                }
                Err(QuetzalcoatlError::StaleLeaseEpoch { current, .. }) => {
                    self.stale_epoch_demotions = self.stale_epoch_demotions.saturating_add(1);
                    self.state = RouterLeaseState::Standby {
                        known_holder: None,
                        highest_seen_epoch: current,
                    };
                    kernel.set_lease_posture(LeasePosture::PartitionLocal);
                    break;
                }
                Err(_) => {
                    self.handle_hub_unreachable(kernel, pre_mono);
                    break;
                }
            }

            let delivered = outbox_deliver_fn(
                &entry.item.capability_id,
                &entry.idempotency_key,
                &entry.item.arguments_json,
                witness_epoch,
            )
            .is_ok();
            outcomes.push(OutboxReconcileOutcome { entry, delivered });
        }

        let packs = self.record_outbox_outcomes(kernel, &plan, &outcomes, local_wall_ms)?;
        for p in &packs {
            if sync_backend
                .upload_pack(agent_id, local_dev_id, p)
                .await
                .is_err()
            {
                self.handle_hub_unreachable(kernel, self.clock.now_millis());
                return Ok(());
            }
            sync_actor.mark_pack_uploaded(p.pack_id);
        }
        Ok(())
    }

    /// 阶段一（零内核锁）：纯网络心跳——上传本地密文包、增量拉取远端包、续租或 CAS 竞选 `witness_epoch`。
    /// 调用方必须在**不持有** `BlindKernel` 锁的情况下执行本方法，随后用 `apply_network_report` 短锁落库。
    #[allow(clippy::too_many_arguments)]
    pub async fn network_tick(
        &mut self,
        agent_id: AgentId,
        local_device: DeviceId,
        sync_actor: &mut SpineSyncActor,
        lease_backend: &dyn LeaseWitnessBackend,
        sync_backend: &dyn SpineSyncBackend,
        local_packs: &[SealedPackfile],
        existing_pack_ids: &BTreeSet<ArtifactId>,
    ) -> LeaseNetworkReport {
        let _ = self.demote_if_monotonic_expired();
        let mut uploaded_packs = 0usize;
        let mut new_cursor = sync_actor.hub_cursor_seq();
        let mut fetched_packs: Vec<SealedPackfile> = Vec::new();
        let mut seen_ids: BTreeSet<ArtifactId> = existing_pack_ids.clone();

        for pack in local_packs {
            if !sync_actor.should_upload(pack.pack_id) {
                continue;
            }
            if sync_backend
                .upload_pack(agent_id, local_device, pack)
                .await
                .is_err()
            {
                self.classify_hub_unreachable(self.clock.now_millis());
                return LeaseNetworkReport {
                    outcome: LeaseNetworkOutcome::Unreachable,
                    fetched_packs,
                    uploaded_packs,
                    new_cursor,
                };
            }
            sync_actor.mark_pack_uploaded(pack.pack_id);
            uploaded_packs = uploaded_packs.saturating_add(1);
        }

        match sync_backend
            .fetch_packs_after(agent_id, local_device, new_cursor)
            .await
        {
            Ok((next, packs)) => {
                new_cursor = next;
                for p in packs {
                    if p.aad.device_id != local_device && seen_ids.insert(p.pack_id) {
                        fetched_packs.push(p);
                    }
                }
            }
            Err(_) => {
                self.classify_hub_unreachable(self.clock.now_millis());
                return LeaseNetworkReport {
                    outcome: LeaseNetworkOutcome::Unreachable,
                    fetched_packs,
                    uploaded_packs,
                    new_cursor,
                };
            }
        }

        let now_mono = self.clock.now_millis();
        let outcome = if let RouterLeaseState::ActiveRouter { witness_epoch, .. } = self.state {
            match lease_backend
                .renew_lease(
                    agent_id,
                    local_device,
                    witness_epoch.get(),
                    self.config.ttl_ms,
                )
                .await
            {
                Ok(rec) => {
                    let ep = Epoch::new(rec.witness_epoch);
                    self.last_hub_contact_mono_ms = Some(now_mono);
                    self.state = RouterLeaseState::ActiveRouter {
                        witness_epoch: ep,
                        expires_mono_ms: now_mono.saturating_add(self.effective_local_ttl_ms()),
                    };
                    LeaseNetworkOutcome::Renewed { witness_epoch: ep }
                }
                Err(QuetzalcoatlError::StaleLeaseEpoch { current, .. }) => {
                    self.stale_epoch_demotions = self.stale_epoch_demotions.saturating_add(1);
                    self.state = RouterLeaseState::Standby {
                        known_holder: None,
                        highest_seen_epoch: current,
                    };
                    LeaseNetworkOutcome::Stale { current }
                }
                Err(_) => {
                    self.classify_hub_unreachable(now_mono);
                    LeaseNetworkOutcome::Unreachable
                }
            }
        } else {
            match lease_backend
                .acquire_lease(agent_id, local_device, 0, self.config.ttl_ms)
                .await
            {
                Ok(rec) => {
                    let ep = Epoch::new(rec.witness_epoch);
                    self.last_hub_contact_mono_ms = Some(now_mono);
                    self.state = RouterLeaseState::ActiveRouter {
                        witness_epoch: ep,
                        expires_mono_ms: now_mono.saturating_add(self.effective_local_ttl_ms()),
                    };
                    // 取得新纪元激活前再拉一次增量，杜绝跨纪元漏看幂等令牌。
                    match sync_backend
                        .fetch_packs_after(agent_id, local_device, new_cursor)
                        .await
                    {
                        Ok((next, packs)) => {
                            new_cursor = next;
                            for p in packs {
                                if p.aad.device_id != local_device && seen_ids.insert(p.pack_id) {
                                    fetched_packs.push(p);
                                }
                            }
                            LeaseNetworkOutcome::Acquired { witness_epoch: ep }
                        }
                        Err(_) => {
                            self.state = RouterLeaseState::PartitionLocal {
                                entered_mono_ms: now_mono,
                                highest_seen_epoch: ep.get(),
                            };
                            LeaseNetworkOutcome::Unreachable
                        }
                    }
                }
                Err(QuetzalcoatlError::StaleLeaseEpoch { current, .. }) => {
                    self.last_hub_contact_mono_ms = Some(now_mono);
                    self.state = RouterLeaseState::Standby {
                        known_holder: None,
                        highest_seen_epoch: current.max(self.highest_seen_epoch()),
                    };
                    LeaseNetworkOutcome::Stale { current }
                }
                Err(_) => {
                    self.classify_hub_unreachable(now_mono);
                    LeaseNetworkOutcome::Unreachable
                }
            }
        };

        LeaseNetworkReport {
            outcome,
            fetched_packs,
            uploaded_packs,
            new_cursor,
        }
    }

    /// 阶段二（短锁）：把网络结果合入内核——解密重水合远端 Packfile、更新游标并落定两态姿态。
    pub fn apply_network_report<S: MaterializedStore>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        sync_actor: &mut SpineSyncActor,
        report: &LeaseNetworkReport,
        local_wall_ms: u64,
    ) -> Result<LeasePosture> {
        if !report.fetched_packs.is_empty()
            && let Err(err) = SpineSyncActor::ingest_packfiles_and_rehydrate(
                kernel,
                &report.fetched_packs,
                local_wall_ms,
            )
        {
            // 合入失败必须 fail-closed 回落分区受限，严禁带着不完整历史继续当 Router。
            kernel.set_lease_posture(LeasePosture::PartitionLocal);
            return Err(err);
        }
        sync_actor.set_hub_cursor_seq(report.new_cursor);
        match report.outcome {
            LeaseNetworkOutcome::Renewed { witness_epoch }
            | LeaseNetworkOutcome::Acquired { witness_epoch } => {
                kernel.set_lease_posture(LeasePosture::Witnessed { witness_epoch });
            }
            LeaseNetworkOutcome::Stale { .. } | LeaseNetworkOutcome::Unreachable => {
                kernel.set_lease_posture(LeasePosture::PartitionLocal);
            }
            LeaseNetworkOutcome::Skipped => {}
        }
        Ok(kernel.lease_posture())
    }

    /// 执行一次租约续期/竞选与断网 `Outbox` 对账周期（单线程测试与离线工具使用的组合编排）。
    pub async fn tick_and_reconcile<S: MaterializedStore, F>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        sync_actor: &mut SpineSyncActor,
        lease_backend: &dyn LeaseWitnessBackend,
        sync_backend: &dyn SpineSyncBackend,
        local_wall_ms: u64,
        outbox_deliver_fn: F,
    ) -> Result<LeasePosture>
    where
        F: FnMut(&str, &str, &str, Epoch) -> Result<()>,
    {
        let _ = self.check_monotonic_expiry_before_io(kernel);
        let agent_id = kernel.spine().agent_id();
        let local_dev_id = kernel.spine().local_device().device_id();
        let _ = kernel.spine_mut().seal_checkpoint(None, local_wall_ms);
        let local_packs = kernel.spine().store().list_packfiles()?;
        let existing_ids: BTreeSet<ArtifactId> = local_packs.iter().map(|p| p.pack_id).collect();
        let report = self
            .network_tick(
                agent_id,
                local_dev_id,
                sync_actor,
                lease_backend,
                sync_backend,
                &local_packs,
                &existing_ids,
            )
            .await;
        let posture = self.apply_network_report(kernel, sync_actor, &report, local_wall_ms)?;
        if let LeasePosture::Witnessed { witness_epoch } = posture {
            self.reconcile_pending_outbox(
                kernel,
                sync_actor,
                lease_backend,
                sync_backend,
                witness_epoch,
                local_wall_ms,
                outbox_deliver_fn,
            )
            .await?;
        }
        Ok(kernel.lease_posture())
    }

    /// 合盖/挂起/优雅退出 `<100ms` 主动租约释放与在线对等节点无缝接班。
    pub async fn voluntary_handoff<S: MaterializedStore>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        sync_actor: &mut SpineSyncActor,
        lease_backend: &dyn LeaseWitnessBackend,
        sync_backend: Option<&dyn SpineSyncBackend>,
        fabric_and_target: Option<(&FabricNode, EndpointAddr)>,
        local_wall_ms: u64,
    ) -> Result<u64> {
        let _ = self.check_monotonic_expiry_before_io(kernel);
        let RouterLeaseState::ActiveRouter { witness_epoch, .. } = self.state else {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("当前节点未持有活跃 Router 租约，无法发起主动移交"),
            });
        };

        let agent_id = kernel.spine().agent_id();
        let local_dev_id = kernel.spine().local_device().device_id();
        let released_epoch = witness_epoch.get();

        // 1. 密封最新状态脊柱检查点
        let latest_packs = kernel.spine_mut().seal_checkpoint(None, local_wall_ms)?;
        if let Some(sb) = sync_backend {
            for p in &latest_packs {
                if sb.upload_pack(agent_id, local_dev_id, p).await.is_ok() {
                    sync_actor.mark_pack_uploaded(p.pack_id);
                }
            }
        }

        // 2. 在 Hub 上立即释放当前 witness_epoch
        let _ = lease_backend
            .release_lease(agent_id, local_dev_id, released_epoch)
            .await?;

        self.state = RouterLeaseState::Standby {
            known_holder: None,
            highest_seen_epoch: released_epoch,
        };
        kernel.set_lease_posture(LeasePosture::PartitionLocal);

        // 3. 若指定了在线对等节点，通过已打通的 iroh 直连流直接推送最新检查点并触发 <100ms 接班！
        if let Some((fabric, target_addr)) = fabric_and_target {
            let resp = fabric
                .send_rpc(
                    target_addr,
                    &FabricRpcRequest::VoluntaryLeaseHandoff {
                        agent_id,
                        from_device_id: local_dev_id,
                        released_epoch,
                        latest_packs,
                    },
                )
                .await?;
            match resp {
                FabricRpcResponse::LeaseHandoffAccepted {
                    new_holder_device_id,
                    new_witness_epoch,
                } => {
                    self.state = RouterLeaseState::Standby {
                        known_holder: Some(new_holder_device_id),
                        highest_seen_epoch: new_witness_epoch,
                    };
                    return Ok(new_witness_epoch);
                }
                FabricRpcResponse::Error { detail, .. } => {
                    return Err(QuetzalcoatlError::StorageError { detail });
                }
                other => {
                    return Err(QuetzalcoatlError::SerializationError {
                        detail: format!("unexpected handoff response: {other:?}"),
                    });
                }
            }
        }

        Ok(released_epoch)
    }

    fn queue_into_partition_outbox<S: MaterializedStore>(
        kernel: &mut BlindKernel<S>,
        run_id: Option<RunId>,
        capability_id: &str,
        idempotency_key: &str,
        arguments_json: &str,
        local_wall_ms: u64,
    ) -> Result<FencedDeliveryOutcome> {
        kernel.set_lease_posture(LeasePosture::PartitionLocal);
        let bindings = BTreeSet::from([String::from(capability_id)]);
        let mut inv = CapabilityInvocation::new(capability_id, arguments_json);
        inv.idempotency_key = Some(String::from(idempotency_key));
        let auth_res = kernel.authorize_capability(
            PrincipalRole::Worker,
            run_id,
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            bindings,
            &inv,
            local_wall_ms,
        );
        match auth_res {
            Err(QuetzalcoatlError::PartitionRestricted { .. }) => {
                Ok(FencedDeliveryOutcome::QueuedInOutbox)
            }
            Err(other) => Err(other),
            Ok(_) => Ok(FencedDeliveryOutcome::QueuedInOutbox),
        }
    }

    /// 执行受单调时钟自检 + Hub 见证屏障保护的公网外发动作（防坑规范 #7 & Review Focus #2：零脑裂双发）。
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_fenced_external_send<S: MaterializedStore, F>(
        &mut self,
        kernel: &mut BlindKernel<S>,
        sync_actor: &mut SpineSyncActor,
        lease_backend: &dyn LeaseWitnessBackend,
        sync_backend: &dyn SpineSyncBackend,
        run_id: RunId,
        capability_id: &str,
        idempotency_key: &str,
        arguments_json: &str,
        local_wall_ms: u64,
        deliver_fn: F,
    ) -> Result<FencedDeliveryOutcome>
    where
        F: FnOnce(Epoch) -> Result<()>,
    {
        // 第一道防线：发任何网络包之前强制读取本机单调时钟 Instant 自检，合盖超时立即自降级并入队 Outbox！
        if self.check_monotonic_expiry_before_io(kernel) {
            return Self::queue_into_partition_outbox(
                kernel,
                Some(run_id),
                capability_id,
                idempotency_key,
                arguments_json,
                local_wall_ms,
            );
        }

        let RouterLeaseState::ActiveRouter { witness_epoch, .. } = self.state else {
            return Self::queue_into_partition_outbox(
                kernel,
                Some(run_id),
                capability_id,
                idempotency_key,
                arguments_json,
                local_wall_ms,
            );
        };

        let agent_id = kernel.spine().agent_id();
        let local_dev_id = kernel.spine().local_device().device_id();

        // 第二道防线：同步 Hub 密文脊柱，确认全局没有任何前序节点已投递相同 idempotency_key
        if sync_actor
            .sync_via_hub(kernel, sync_backend, local_wall_ms)
            .await
            .is_err()
        {
            self.handle_hub_unreachable(kernel, self.clock.now_millis());
            return Self::queue_into_partition_outbox(
                kernel,
                Some(run_id),
                capability_id,
                idempotency_key,
                arguments_json,
                local_wall_ms,
            );
        }

        let (committed_keys, _) = Self::scan_spine_delivery_state(kernel)?;
        if committed_keys.contains(idempotency_key) {
            return Ok(FencedDeliveryOutcome::DeduplicatedAlreadySent);
        }

        // 第三道防线：发送前在 Hub 上续租核验 witness_epoch 仍归本机所有（拦截非对称网络切分！）
        let pre_mono = self.clock.now_millis();
        let active_epoch = match lease_backend
            .renew_lease(
                agent_id,
                local_dev_id,
                witness_epoch.get(),
                self.config.ttl_ms,
            )
            .await
        {
            Ok(rec) => {
                let ep = Epoch::new(rec.witness_epoch);
                self.last_hub_contact_mono_ms = Some(pre_mono);
                self.state = RouterLeaseState::ActiveRouter {
                    witness_epoch: ep,
                    expires_mono_ms: pre_mono.saturating_add(self.effective_local_ttl_ms()),
                };
                kernel.set_lease_posture(LeasePosture::Witnessed { witness_epoch: ep });
                ep
            }
            Err(QuetzalcoatlError::StaleLeaseEpoch { current, .. }) => {
                self.stale_epoch_demotions = self.stale_epoch_demotions.saturating_add(1);
                let holder = DeviceId::from_str("").ok();
                self.state = RouterLeaseState::Standby {
                    known_holder: holder,
                    highest_seen_epoch: current,
                };
                return Self::queue_into_partition_outbox(
                    kernel,
                    Some(run_id),
                    capability_id,
                    idempotency_key,
                    arguments_json,
                    local_wall_ms,
                );
            }
            Err(_) => {
                self.handle_hub_unreachable(kernel, pre_mono);
                return Self::queue_into_partition_outbox(
                    kernel,
                    Some(run_id),
                    capability_id,
                    idempotency_key,
                    arguments_json,
                    local_wall_ms,
                );
            }
        };

        let bindings = BTreeSet::from([String::from(capability_id)]);
        let mut inv = CapabilityInvocation::new(capability_id, arguments_json);
        inv.idempotency_key = Some(String::from(idempotency_key));
        let decision = kernel.authorize_capability(
            PrincipalRole::Worker,
            Some(run_id),
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            bindings,
            &inv,
            local_wall_ms,
        )?;
        if matches!(
            decision.write_ahead,
            Some(ExternalWriteDisposition::DuplicateSuppressed { .. })
        ) {
            return Ok(FencedDeliveryOutcome::DeduplicatedAlreadySent);
        }

        // 第四道防线（Write-Ahead Witnessing）：先将幂等提交凭证封包上传至 Hub，若上传瞬间断网则写补偿回滚记录并入队 Outbox！
        let delivery_record = FabricDeliverySpineRecord {
            schema: String::from(FABRIC_DELIVERY_SCHEMA),
            capability_id: String::from(capability_id),
            idempotency_key: String::from(idempotency_key),
            witness_epoch: active_epoch.get(),
            outbox_id: None,
            aborted_before_send: false,
        };
        let encoded = serde_json::to_string(&delivery_record).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        let _ = kernel
            .spine_mut()
            .append_event(PackCompartment::Core, &encoded, local_wall_ms)?;
        let packs = kernel
            .spine_mut()
            .seal_checkpoint(Some(run_id), local_wall_ms)?;

        for p in &packs {
            if sync_backend
                .upload_pack(agent_id, local_dev_id, p)
                .await
                .is_err()
            {
                let abort_rec = FabricDeliverySpineRecord {
                    schema: String::from(FABRIC_DELIVERY_SCHEMA),
                    capability_id: String::from(capability_id),
                    idempotency_key: String::from(idempotency_key),
                    witness_epoch: active_epoch.get(),
                    outbox_id: None,
                    aborted_before_send: true,
                };
                if let Ok(abort_json) = serde_json::to_string(&abort_rec) {
                    let _ = kernel.spine_mut().append_event(
                        PackCompartment::Core,
                        &abort_json,
                        local_wall_ms,
                    );
                }
                self.handle_hub_unreachable(kernel, self.clock.now_millis());
                return Self::queue_into_partition_outbox(
                    kernel,
                    None,
                    capability_id,
                    idempotency_key,
                    arguments_json,
                    local_wall_ms,
                );
            }
            sync_actor.mark_pack_uploaded(p.pack_id);
        }

        deliver_fn(active_epoch)?;
        Ok(FencedDeliveryOutcome::Delivered {
            witness_epoch: active_epoch,
        })
    }
}
