#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing, SealedPackfile};
use quetzalcoatl_fabric::{
    FencedDeliveryOutcome, FencedLeaseCoordinator, LeaseCoordinatorConfig, LeaseWitnessBackend,
    LeaseWitnessRecord, RouterLeaseState, SimulatedMonotonicClock, SpineSyncActor,
    SpineSyncBackend,
};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityDescriptor, CapabilityInvocation, CapabilityOrigin, CapabilitySet,
    ExecutionSurface, HeartScheduler, LeasePosture, PrincipalRole, ScopeChain, SinkClass,
    SleepPhase,
};
use quetzalcoatl_sandbox::{SandboxConfig, SandboxManager};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{
    AgentId, ArtifactId, DeviceId, Epoch, HlcTimestamp, QuetzalcoatlError, Result,
};
use uuid::Uuid;

type TestResult = std::result::Result<(), Box<dyn Error + Send + Sync>>;

/// 确定性 SplitMix64 伪随机数发生器（保证 100 个种子在任何机器与时刻 100% 可复现）。
struct DeterministicRng {
    state: u64,
}

impl DeterministicRng {
    const fn new(seed: u64) -> Self {
        Self {
            state: seed.wrapping_add(0x9e37_79b9_7f4a_7c15),
        }
    }

    fn next_u64(&mut self) -> u64 {
        let mut z = {
            self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            self.state
        };
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn gen_range(&mut self, upper_exclusive: u64) -> u64 {
        if upper_exclusive <= 1 {
            return 0;
        }
        self.next_u64() % upper_exclusive
    }

    fn chance_percent(&mut self, pct: u64) -> bool {
        self.gen_range(100) < pct
    }
}

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> std::result::Result<Self, Box<dyn Error + Send + Sync>> {
        let parent = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
        let uid = Uuid::new_v4().simple().to_string();
        let path = parent.join(format!("{prefix}_{}", &uid[..12]));
        std::fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct ChaosHubState {
    hub_time_ms: i64,
    holder_device: Option<DeviceId>,
    witness_epoch: u64,
    expires_at_ms: i64,
    packs: Vec<(u64, SealedPackfile)>,
    next_server_seq: u64,
    partitioned_devices: BTreeSet<DeviceId>,
    drop_next_for_device: BTreeSet<DeviceId>,
    packets_received_from_expired_node: u64,
}

/// 具备确定性网络分区、丢包与非对称断连注入能力的仿真 Hub（严格对齐 Go `SQLiteStore::AcquireLease` CAS 语义）。
#[derive(Clone)]
struct ChaosHubBackend {
    inner: Arc<Mutex<ChaosHubState>>,
}

impl ChaosHubBackend {
    fn new(initial_ms: i64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ChaosHubState {
                hub_time_ms: initial_ms,
                holder_device: None,
                witness_epoch: 0,
                expires_at_ms: 0,
                packs: Vec::new(),
                next_server_seq: 1,
                partitioned_devices: BTreeSet::new(),
                drop_next_for_device: BTreeSet::new(),
                packets_received_from_expired_node: 0,
            })),
        }
    }

    fn advance_hub_clock(&self, delta_ms: u64) {
        if let Ok(mut g) = self.inner.lock() {
            g.hub_time_ms = g
                .hub_time_ms
                .saturating_add(i64::try_from(delta_ms).unwrap_or(0));
        }
    }

    fn set_partitioned(&self, dev: DeviceId, is_partitioned: bool) {
        if let Ok(mut g) = self.inner.lock() {
            if is_partitioned {
                g.partitioned_devices.insert(dev);
            } else {
                g.partitioned_devices.remove(&dev);
            }
        }
    }

    fn inject_one_packet_drop(&self, dev: DeviceId) {
        if let Ok(mut g) = self.inner.lock() {
            g.drop_next_for_device.insert(dev);
        }
    }

    fn heal_all(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.partitioned_devices.clear();
            g.drop_next_for_device.clear();
        }
    }

    fn check_reachability(state: &mut ChaosHubState, dev: DeviceId) -> Result<()> {
        if state.partitioned_devices.contains(&dev) {
            return Err(QuetzalcoatlError::PartitionRestricted {
                detail: format!("device {dev} partitioned from Hub"),
            });
        }
        if state.drop_next_for_device.remove(&dev) {
            return Err(QuetzalcoatlError::StorageError {
                detail: format!("simulated packet drop for device {dev}"),
            });
        }
        Ok(())
    }
}

impl LeaseWitnessBackend for ChaosHubBackend {
    fn acquire_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        expected_epoch: u64,
        ttl_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>> {
        Box::pin(async move {
            let mut g = self
                .inner
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("chaos hub lock"),
                })?;
            Self::check_reachability(&mut g, device_id)?;
            let now = g.hub_time_ms;
            let ttl_i64 = i64::try_from(ttl_ms).unwrap_or(30_000);

            if g.witness_epoch == 0 {
                if expected_epoch > 0 {
                    return Err(QuetzalcoatlError::StaleLeaseEpoch {
                        provided: expected_epoch,
                        current: 0,
                    });
                }
                g.witness_epoch = 1;
                g.holder_device = Some(device_id);
                g.expires_at_ms = now + ttl_i64;
                return Ok(LeaseWitnessRecord {
                    agent_id,
                    holder_device_id: device_id.to_string(),
                    witness_epoch: 1,
                    expires_at_ms: g.expires_at_ms,
                    updated_at_ms: now,
                });
            }

            if expected_epoch > 0 && expected_epoch != g.witness_epoch {
                return Err(QuetzalcoatlError::StaleLeaseEpoch {
                    provided: expected_epoch,
                    current: g.witness_epoch,
                });
            }

            let active = g.holder_device.is_some() && g.expires_at_ms > now;
            if active {
                if g.holder_device != Some(device_id) {
                    return Err(QuetzalcoatlError::StaleLeaseEpoch {
                        provided: expected_epoch,
                        current: g.witness_epoch,
                    });
                }
                g.expires_at_ms = now + ttl_i64;
                return Ok(LeaseWitnessRecord {
                    agent_id,
                    holder_device_id: device_id.to_string(),
                    witness_epoch: g.witness_epoch,
                    expires_at_ms: g.expires_at_ms,
                    updated_at_ms: now,
                });
            }

            g.witness_epoch = g.witness_epoch.saturating_add(1);
            g.holder_device = Some(device_id);
            g.expires_at_ms = now + ttl_i64;
            Ok(LeaseWitnessRecord {
                agent_id,
                holder_device_id: device_id.to_string(),
                witness_epoch: g.witness_epoch,
                expires_at_ms: g.expires_at_ms,
                updated_at_ms: now,
            })
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
            let mut g = self
                .inner
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("chaos hub lock"),
                })?;
            Self::check_reachability(&mut g, device_id)?;
            let now = g.hub_time_ms;
            if g.witness_epoch != witness_epoch
                || g.holder_device != Some(device_id)
                || g.expires_at_ms <= now
            {
                if g.expires_at_ms <= now {
                    g.packets_received_from_expired_node += 1;
                }
                return Err(QuetzalcoatlError::StaleLeaseEpoch {
                    provided: witness_epoch,
                    current: g.witness_epoch,
                });
            }
            let ttl_i64 = i64::try_from(ttl_ms).unwrap_or(30_000);
            g.expires_at_ms = now + ttl_i64;
            Ok(LeaseWitnessRecord {
                agent_id,
                holder_device_id: device_id.to_string(),
                witness_epoch: g.witness_epoch,
                expires_at_ms: g.expires_at_ms,
                updated_at_ms: now,
            })
        })
    }

    fn release_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>> {
        Box::pin(async move {
            let mut g = self
                .inner
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("chaos hub lock"),
                })?;
            Self::check_reachability(&mut g, device_id)?;
            let now = g.hub_time_ms;
            if g.witness_epoch != witness_epoch || g.holder_device != Some(device_id) {
                return Err(QuetzalcoatlError::StaleLeaseEpoch {
                    provided: witness_epoch,
                    current: g.witness_epoch,
                });
            }
            g.holder_device = None;
            g.expires_at_ms = now;
            Ok(LeaseWitnessRecord {
                agent_id,
                holder_device_id: String::new(),
                witness_epoch: g.witness_epoch,
                expires_at_ms: now,
                updated_at_ms: now,
            })
        })
    }
}

impl SpineSyncBackend for ChaosHubBackend {
    fn upload_pack<'a>(
        &'a self,
        _agent_id: AgentId,
        device_id: DeviceId,
        pack: &'a SealedPackfile,
    ) -> Pin<Box<dyn Future<Output = Result<u64>> + Send + 'a>> {
        Box::pin(async move {
            let mut g = self
                .inner
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("chaos hub lock"),
                })?;
            Self::check_reachability(&mut g, device_id)?;
            if let Some((seq, _)) = g.packs.iter().find(|(_, p)| p.pack_id == pack.pack_id) {
                return Ok(*seq);
            }
            let seq = g.next_server_seq;
            g.next_server_seq = g.next_server_seq.saturating_add(1);
            g.packs.push((seq, pack.clone()));
            Ok(seq)
        })
    }

    fn fetch_packs_after<'a>(
        &'a self,
        _agent_id: AgentId,
        device_id: DeviceId,
        after_seq: u64,
    ) -> Pin<Box<dyn Future<Output = Result<(u64, Vec<SealedPackfile>)>> + Send + 'a>> {
        Box::pin(async move {
            let mut g = self
                .inner
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("chaos hub lock"),
                })?;
            Self::check_reachability(&mut g, device_id)?;
            let mut max_seq = after_seq;
            let mut out = Vec::new();
            for (seq, p) in &g.packs {
                if *seq > after_seq {
                    if *seq > max_seq {
                        max_seq = *seq;
                    }
                    out.push(p.clone());
                }
            }
            Ok((max_seq, out))
        })
    }
}

struct SimNode {
    device_id: DeviceId,
    clock: SimulatedMonotonicClock,
    kernel: BlindKernel<RusqliteWalStore>,
    sync_actor: SpineSyncActor,
    coordinator: FencedLeaseCoordinator<SimulatedMonotonicClock>,
}

fn build_sim_node(
    dir: &Path,
    agent_id: AgentId,
    device: DeviceIdentity,
    ring: EpochKeyRing,
    initial_ms: u64,
) -> std::result::Result<SimNode, Box<dyn Error + Send + Sync>> {
    std::fs::create_dir_all(dir)?;
    let dev_id = device.device_id();
    let store = RusqliteWalStore::open(&dir.join("spine.sqlite"))?;
    let hlc = HlcTimestamp::from_parts(initial_ms, 0, dev_id.hlc_node_tag());
    let spine = SpineEngine::new(agent_id, device, ring, hlc, store)?;
    let sandbox = SandboxManager::new(SandboxConfig::new(dir));
    let mut kernel = BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(1, 0.15, SleepPhase::Awake),
        LeasePosture::PartitionLocal,
    );
    for (cap_id, sink, surface, idempotent) in [
        (
            "dialogue.reply",
            SinkClass::RoutineResponse,
            ExecutionSurface::ThreadVoice,
            true,
        ),
        (
            "eldercare.local_siren",
            SinkClass::EmergencyLocalAlert,
            ExecutionSurface::ThreadVoice,
            true,
        ),
        (
            "public.channel.send",
            SinkClass::RoutineResponse,
            ExecutionSurface::ExternalChannel,
            false,
        ),
    ] {
        kernel.register_capability(CapabilityDescriptor {
            capability_id: String::from(cap_id),
            interface_id: String::from("quetzalcoatl.chaos"),
            sink_class: sink,
            surface,
            idempotent,
            origin: CapabilityOrigin::HostRegistered,
        })?;
    }

    let clock = SimulatedMonotonicClock::new(initial_ms);
    let coordinator = FencedLeaseCoordinator::new(
        clock.clone(),
        LeaseCoordinatorConfig {
            ttl_ms: 10_000,
            safety_margin_ms: 1_500,
            offline_grace_ms: 3_000,
        },
    );
    Ok(SimNode {
        device_id: dev_id,
        clock,
        kernel,
        sync_actor: SpineSyncActor::new(),
        coordinator,
    })
}

#[tokio::test]
async fn deterministic_100_seeds_chaos_partition_clock_jump_zero_double_send_and_convergence()
-> TestResult {
    let base_tmp = TempDirGuard::new("qz_chaos_100_seeds")?;
    let mut total_clock_jump_demotions = 0u64;
    let mut total_delivered_messages = 0usize;

    for seed in 0u64..100u64 {
        let mut rng = DeterministicRng::new(seed);
        let seed_dir = base_tmp.path().join(format!("seed_{seed}"));
        let initial_ms: u64 = 1_795_500_000_000;

        let agent_id = AgentId::new_v4();
        let root_key = AccountRootKey::generate()?;
        let dev0 = DeviceIdentity::generate(DeviceId::new_v4())?;
        let dev1 = DeviceIdentity::generate(DeviceId::new_v4())?;
        let dev2 = DeviceIdentity::generate(DeviceId::new_v4())?;
        let ep1 = EpochKey::generate()?;

        let mut base_ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev0.public_record())?;
        base_ring.insert_epoch_key(Epoch::new(1), ep1);
        let _ = base_ring.add_device(&root_key, dev1.public_record())?;
        let _ = base_ring.add_device(&root_key, dev2.public_record())?;

        let mut nodes = vec![
            build_sim_node(
                &seed_dir.join("n0"),
                agent_id,
                dev0,
                base_ring.clone(),
                initial_ms,
            )?,
            build_sim_node(
                &seed_dir.join("n1"),
                agent_id,
                dev1,
                base_ring.clone(),
                initial_ms,
            )?,
            build_sim_node(
                &seed_dir.join("n2"),
                agent_id,
                dev2,
                base_ring.clone(),
                initial_ms,
            )?,
        ];

        let hub = ChaosHubBackend::new(i64::try_from(initial_ms).unwrap_or(0));
        type DeliveryLog = Arc<Mutex<BTreeMap<String, Vec<(DeviceId, u64)>>>>;
        let external_deliveries: DeliveryLog = Arc::new(Mutex::new(BTreeMap::new()));
        let mut submitted_keys = BTreeSet::<String>::new();
        let mut wall_ms = initial_ms;

        // 每个种子运行 18 步随机混沌事件调度
        for step in 0u64..18u64 {
            let dt = 600 + rng.gen_range(2_800);
            wall_ms = wall_ms.saturating_add(dt);
            hub.advance_hub_clock(dt);
            for n in &nodes {
                n.clock.advance_ms(dt);
            }

            // 随机切换各节点与 Hub 的非对称网络分区状态与单包丢弃
            for n in &nodes {
                let part = rng.chance_percent(35);
                hub.set_partitioned(n.device_id, part);
                if rng.chance_percent(20) {
                    hub.inject_one_packet_drop(n.device_id);
                }
            }

            // 在特定步骤注入「活跃 Router 笔记本合盖休眠 2 小时（7,200,000ms 单调时钟跳变）」场景！
            if (step == 7 || (step == 13 && rng.chance_percent(50)))
                && let Some(router_idx) = nodes.iter().position(|n| {
                    matches!(n.coordinator.state(), RouterLeaseState::ActiveRouter { .. })
                })
            {
                let two_hours_ms: u64 = 2 * 60 * 60 * 1_000;
                // 合盖期间物理时间与 Hub 时间推进 20 秒使旧租约过期，另一节点接管新纪元；
                // 随后旧节点开盖，自身 Instant 单调时钟跳变 +2 小时，但注意我们在此不改偏 wall_ms 超过 +5m 以免触发 HLC 投毒隔离
                hub.advance_hub_clock(20_000);
                wall_ms = wall_ms.saturating_add(20_000);
                for (idx, n) in nodes.iter().enumerate() {
                    if idx == router_idx {
                        n.clock.advance_ms(two_hours_ms);
                    } else {
                        n.clock.advance_ms(20_000);
                    }
                }

                // 另一台在线节点趁机抢占 witness_epoch + 1
                let takeover_idx = (router_idx + 1) % nodes.len();
                hub.set_partitioned(nodes[takeover_idx].device_id, false);
                let deliveries_ref = Arc::clone(&external_deliveries);
                let takeover_dev = nodes[takeover_idx].device_id;
                let SimNode {
                    ref mut kernel,
                    ref mut sync_actor,
                    ref mut coordinator,
                    ..
                } = nodes[takeover_idx];
                let _ = coordinator
                    .tick_and_reconcile(
                        kernel,
                        sync_actor,
                        &hub,
                        &hub,
                        wall_ms,
                        |_, idem_key, _, ep| {
                            if let Ok(mut map) = deliveries_ref.lock() {
                                map.entry(String::from(idem_key))
                                    .or_default()
                                    .push((takeover_dev, ep.get()));
                            }
                            Ok(())
                        },
                    )
                    .await;

                // 旧 Router 开盖苏醒瞬间尝试外发动作：必须在发任何网络包前先通过 Instant 自检立即自降级！
                let expired_before = hub
                    .inner
                    .lock()
                    .map(|g| g.packets_received_from_expired_node)
                    .unwrap_or(0);
                let woke_key = format!("seed-{seed}-wake-key-{step}");
                submitted_keys.insert(woke_key.clone());
                let deliveries_wake = Arc::clone(&external_deliveries);
                let old_dev = nodes[router_idx].device_id;
                let SimNode {
                    ref mut kernel,
                    ref mut sync_actor,
                    ref mut coordinator,
                    ..
                } = nodes[router_idx];
                let run = kernel.spawn_commit_run("wake-commit", None, wall_ms)?;
                let _ = coordinator
                    .execute_fenced_external_send(
                        kernel,
                        sync_actor,
                        &hub,
                        &hub,
                        run.run_id,
                        "public.channel.send",
                        &woke_key,
                        r#"{"msg":"after_lid_wake"}"#,
                        wall_ms,
                        |ep| {
                            if let Ok(mut map) = deliveries_wake.lock() {
                                map.entry(woke_key.clone())
                                    .or_default()
                                    .push((old_dev, ep.get()));
                            }
                            Ok(())
                        },
                    )
                    .await;
                let _ = kernel.complete_commit_run(run.run_id, None, wall_ms)?;
                assert!(
                    coordinator.clock_jump_demotions() >= 1,
                    "seed {seed}: 合盖 2 小时苏醒的旧 Router 必须通过单调时钟 Instant 立即自降级"
                );
                let expired_after = hub
                    .inner
                    .lock()
                    .map(|g| g.packets_received_from_expired_node)
                    .unwrap_or(0);
                assert_eq!(
                    expired_before, expired_after,
                    "seed {seed}: 旧 Router 苏醒自检过期后严禁再用旧纪元发出 renew 包"
                );
            }

            // 所有节点并发尝试心跳续租/竞选对账
            for n in &mut nodes {
                let dev_id = n.device_id;
                let deliveries_ref = Arc::clone(&external_deliveries);
                let _ = n
                    .coordinator
                    .tick_and_reconcile(
                        &mut n.kernel,
                        &mut n.sync_actor,
                        &hub,
                        &hub,
                        wall_ms,
                        |_, idem_key, _, ep| {
                            if let Ok(mut map) = deliveries_ref.lock() {
                                map.entry(String::from(idem_key))
                                    .or_default()
                                    .push((dev_id, ep.get()));
                            }
                            Ok(())
                        },
                    )
                    .await;

                // 若该节点处于 PartitionLocal，断言本地对话与长辈紧急本地告警依然 100% 可用！
                if n.kernel.lease_posture() == LeasePosture::PartitionLocal {
                    let local_run =
                        n.kernel
                            .spawn_commit_run("offline-eldercare", None, wall_ms)?;
                    let bindings = BTreeSet::from([
                        String::from("dialogue.reply"),
                        String::from("eldercare.local_siren"),
                    ]);
                    n.kernel.authorize_capability(
                        PrincipalRole::Worker,
                        Some(local_run.run_id),
                        CapabilitySet::All,
                        ScopeChain::unrestricted(),
                        bindings,
                        &CapabilityInvocation::new("eldercare.local_siren", r#"{"fall":true}"#),
                        wall_ms,
                    )?;
                    let _ = n
                        .kernel
                        .complete_commit_run_without_verifier(local_run.run_id, wall_ms)?;
                }
            }

            // 随机挑选 1~2 台节点（模拟多端同时或重试触发相同/不同幂等键的公网外发请求！）
            let idem_key = if step % 3 == 0 && !submitted_keys.is_empty() {
                // 故意制造跨节点并发重复提交同一个幂等键的脑裂竞态压力！
                submitted_keys
                    .iter()
                    .next_back()
                    .cloned()
                    .unwrap_or_else(|| format!("seed-{seed}-msg-{step}"))
            } else {
                let k = format!("seed-{seed}-msg-{step}");
                submitted_keys.insert(k.clone());
                k
            };

            let target_idx = usize::try_from(rng.gen_range(3)).unwrap_or(0);
            {
                let dev_id = nodes[target_idx].device_id;
                let deliveries_ref = Arc::clone(&external_deliveries);
                let key_copy = idem_key.clone();
                let n = &mut nodes[target_idx];
                let run = n
                    .kernel
                    .spawn_commit_run("public-outbound", None, wall_ms)?;
                let outcome = n
                    .coordinator
                    .execute_fenced_external_send(
                        &mut n.kernel,
                        &mut n.sync_actor,
                        &hub,
                        &hub,
                        run.run_id,
                        "public.channel.send",
                        &idem_key,
                        r#"{"channel":"public","body":"hello"}"#,
                        wall_ms,
                        |ep| {
                            if let Ok(mut map) = deliveries_ref.lock() {
                                map.entry(key_copy).or_default().push((dev_id, ep.get()));
                            }
                            Ok(())
                        },
                    )
                    .await?;
                let _ = n
                    .kernel
                    .complete_commit_run_without_verifier(run.run_id, wall_ms)?;
                assert!(matches!(
                    outcome,
                    FencedDeliveryOutcome::Delivered { .. }
                        | FencedDeliveryOutcome::DeduplicatedAlreadySent
                        | FencedDeliveryOutcome::QueuedInOutbox
                ));
            }
        }

        // 终局网络恢复（Heal Partition）：推进时钟使任何残余半开租约清晰归口，全节点上传检查点、双向同步并对账排空 Outbox！
        hub.heal_all();
        wall_ms = wall_ms.saturating_add(15_000);
        hub.advance_hub_clock(15_000);
        for n in &mut nodes {
            n.clock.advance_ms(15_000);
            let _ = n.kernel.spine_mut().seal_checkpoint(None, wall_ms)?;
            let _ = n
                .sync_actor
                .sync_via_hub(&mut n.kernel, &hub, wall_ms)
                .await?;
        }

        // 由节点 0 合法取得最终 Witnessed 租约并排空全网收敛后的 Outbox，随后再同步一轮保证 3 节点完全一致
        {
            let dev0_id = nodes[0].device_id;
            let deliveries_ref = Arc::clone(&external_deliveries);
            let n0 = &mut nodes[0];
            let posture = n0
                .coordinator
                .tick_and_reconcile(
                    &mut n0.kernel,
                    &mut n0.sync_actor,
                    &hub,
                    &hub,
                    wall_ms + 100,
                    |_, idem_key, _, ep| {
                        if let Ok(mut map) = deliveries_ref.lock() {
                            map.entry(String::from(idem_key))
                                .or_default()
                                .push((dev0_id, ep.get()));
                        }
                        Ok(())
                    },
                )
                .await?;
            assert!(matches!(posture, LeasePosture::Witnessed { .. }));
            let _ = n0.kernel.spine_mut().seal_checkpoint(None, wall_ms + 200)?;
            let _ = n0
                .sync_actor
                .sync_via_hub(&mut n0.kernel, &hub, wall_ms + 200)
                .await?;
        }

        for n in &mut nodes {
            let _ = n.kernel.spine_mut().seal_checkpoint(None, wall_ms + 300)?;
            let _ = n
                .sync_actor
                .sync_via_hub(&mut n.kernel, &hub, wall_ms + 300)
                .await?;
        }
        for n in &mut nodes {
            let _ = n
                .sync_actor
                .sync_via_hub(&mut n.kernel, &hub, wall_ms + 400)
                .await?;
        }

        // 核心铁律断言 ①：全 100 个种子中，每一个幂等键的公网真实投递次数严格 `== 1`（绝不允许 `> 1` 双发，也绝不允许静默丢失）！
        let map_guard = external_deliveries.lock().map_err(|_| "lock deliveries")?;
        for key in &submitted_keys {
            let count = map_guard.get(key).map(Vec::len).unwrap_or(0);
            assert!(
                count <= 1,
                "seed {seed} 发生脑裂公网双发！key={key}, records={:?}",
                map_guard.get(key)
            );
            assert_eq!(
                count, 1,
                "seed {seed} 分区恢复对账后外发消息丢失！key={key}"
            );
            total_delivered_messages += count;
        }

        // 核心铁律断言 ②：统计时钟跳变自降级次数，且 3 个节点的状态脊柱哈希链头 100% 最终一致！
        let seed_demotions: u64 = nodes
            .iter()
            .map(|n| n.coordinator.clock_jump_demotions())
            .sum();
        total_clock_jump_demotions += seed_demotions;

        let all_dev_ids: Vec<DeviceId> = nodes.iter().map(|n| n.device_id).collect();
        let expected_heads: BTreeMap<DeviceId, Option<(u64, ArtifactId)>> = all_dev_ids
            .iter()
            .map(|&d| Ok((d, nodes[0].kernel.spine().store().device_chain_head(d)?)))
            .collect::<Result<_>>()?;

        for (idx, n) in nodes.iter().enumerate().skip(1) {
            for &d in &all_dev_ids {
                let actual_head = n.kernel.spine().store().device_chain_head(d)?;
                assert_eq!(
                    actual_head, expected_heads[&d],
                    "seed {seed}: 节点 {idx} 与节点 0 在设备 {d} 链头上未收敛"
                );
            }
        }

        // 每个种子断言完成后立即清理其独占存储目录，把峰值磁盘占用限定在少数种子而非 100 个；
        // 聚合计数器已累加完毕，清理不影响终局断言。
        drop(nodes);
        let _ = std::fs::remove_dir_all(&seed_dir);
    }

    assert!(
        total_clock_jump_demotions >= 50,
        "100 种子仿真必须真实覆盖大量合盖时钟跳变自降级事件，实际触发: {total_clock_jump_demotions}"
    );
    assert!(total_delivered_messages >= 1000);
    Ok(())
}
