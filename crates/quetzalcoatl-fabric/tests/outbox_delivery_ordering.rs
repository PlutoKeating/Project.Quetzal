#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Fix Round 1 / Important #2：断网 `Outbox` 对账必须先尝试真实投递，只有投递成功才写
//! `aborted_before_send=false` 的"已投递"见证记录；投递失败必须写 `aborted_before_send=true`
//! 的补偿记录并保持待投递状态，下一轮通道恢复后仍能重试，绝不永久静默丢失。

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing};
use quetzalcoatl_fabric::{
    FencedLeaseCoordinator, LeaseCoordinatorConfig, LeaseWitnessBackend, LeaseWitnessRecord,
    SimulatedMonotonicClock, SpineSyncActor, SpineSyncBackend,
};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityDescriptor, CapabilityInvocation, CapabilityOrigin, CapabilitySet,
    ExecutionSurface, HeartScheduler, LeasePosture, PrincipalRole, ScopeChain, SinkClass,
    SleepPhase,
};
use quetzalcoatl_sandbox::{SandboxConfig, SandboxManager};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{
    AgentId, DeviceId, Epoch, ErrorCode, HlcTimestamp, QuetzalcoatlError, Result as QzResult,
};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;
type BoxError = Box<dyn Error + Send + Sync>;
type Kernel = BlindKernel<RusqliteWalStore>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, BoxError> {
        let base = PathBuf::from("/tmp/opencode");
        let parent = if base.is_dir() {
            base
        } else {
            std::env::temp_dir()
        };
        let path = parent.join(format!("{prefix}_{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

const NOW_MS: u64 = 1_795_400_000_000;

fn build_kernel(home: &Path, posture: LeasePosture) -> Result<Kernel, BoxError> {
    let agent_id = AgentId::new_v4();
    let root = AccountRootKey::generate()?;
    let device = DeviceIdentity::generate(DeviceId::new_v4())?;
    let store = RusqliteWalStore::open(&home.join("spine.sqlite"))?;
    let hlc = HlcTimestamp::from_parts(NOW_MS, 0, device.device_id().hlc_node_tag());
    let mut ring = EpochKeyRing::new_genesis(agent_id, &root, device.public_record())?;
    ring.insert_epoch_key(Epoch::new(1), EpochKey::generate()?);
    let spine = SpineEngine::new(agent_id, device, ring, hlc, store)?;
    let sandbox = SandboxManager::new(SandboxConfig::new(home));
    let mut kernel = BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(1, 0.15, SleepPhase::Awake),
        posture,
    );
    kernel.register_capability(CapabilityDescriptor {
        capability_id: String::from("external.send"),
        interface_id: String::from("quetzalcoatl.core"),
        sink_class: SinkClass::HighRiskExternalWrite,
        surface: ExecutionSurface::ExternalChannel,
        idempotent: false,
        origin: CapabilityOrigin::HostRegistered,
    })?;
    Ok(kernel)
}

struct StaticHub {
    witness_epoch: u64,
    uploads: Arc<AtomicUsize>,
}

impl LeaseWitnessBackend for StaticHub {
    fn acquire_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        _expected_epoch: u64,
        _ttl_ms: u64,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = QzResult<LeaseWitnessRecord>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(LeaseWitnessRecord {
                agent_id,
                holder_device_id: device_id.to_string(),
                witness_epoch: self.witness_epoch,
                expires_at_ms: i64::try_from(NOW_MS + 30_000).unwrap_or(0),
                updated_at_ms: i64::try_from(NOW_MS).unwrap_or(0),
            })
        })
    }

    fn renew_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        _witness_epoch: u64,
        _ttl_ms: u64,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = QzResult<LeaseWitnessRecord>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(LeaseWitnessRecord {
                agent_id,
                holder_device_id: device_id.to_string(),
                witness_epoch: self.witness_epoch,
                expires_at_ms: i64::try_from(NOW_MS + 30_000).unwrap_or(0),
                updated_at_ms: i64::try_from(NOW_MS).unwrap_or(0),
            })
        })
    }

    fn release_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        _witness_epoch: u64,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = QzResult<LeaseWitnessRecord>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(LeaseWitnessRecord {
                agent_id,
                holder_device_id: device_id.to_string(),
                witness_epoch: self.witness_epoch,
                expires_at_ms: i64::try_from(NOW_MS).unwrap_or(0),
                updated_at_ms: i64::try_from(NOW_MS).unwrap_or(0),
            })
        })
    }
}

impl SpineSyncBackend for StaticHub {
    fn upload_pack<'a>(
        &'a self,
        _agent_id: AgentId,
        _device_id: DeviceId,
        _pack: &'a quetzalcoatl_crypto::SealedPackfile,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = QzResult<u64>> + Send + 'a>> {
        let counter = Arc::clone(&self.uploads);
        let seq = self.witness_epoch;
        Box::pin(async move {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(seq)
        })
    }

    fn fetch_packs_after<'a>(
        &'a self,
        _agent_id: AgentId,
        _device_id: DeviceId,
        _after_seq: u64,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = QzResult<(u64, Vec<quetzalcoatl_crypto::SealedPackfile>)>,
                > + Send
                + 'a,
        >,
    > {
        let cursor = self.witness_epoch;
        Box::pin(async move { Ok((cursor, Vec::new())) })
    }
}

fn delivery_records(kernel: &Kernel) -> Result<Vec<serde_json::Value>, BoxError> {
    let mut out = Vec::new();
    for (ev, _) in kernel.spine().store().list_all_events()? {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&ev.payload_utf8)
            && val
                .get("schema")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s == "quetzalcoatl/v2/fabric-external-delivery-v1")
        {
            out.push(val);
        }
    }
    Ok(out)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outbox_delivers_before_witnessing_and_refused_delivery_stays_queued_for_retry()
-> TestResult {
    let tmp = TempDirGuard::new("qz_outbox_delivery_order")?;
    let home = tmp.path().join("node");
    fs::create_dir_all(&home)?;
    let mut kernel = build_kernel(&home, LeasePosture::PartitionLocal)?;

    // 1. 断网期间排入一条非幂等公网外发项。
    let run = kernel.spawn_commit_run("outbox channel task", None, NOW_MS)?;
    let mut call =
        CapabilityInvocation::new("external.send", r#"{"channel":"public","target":"friend"}"#);
    call.idempotency_key = Some(String::from("idem-outbox-fix-round1"));
    let queued = kernel
        .authorize_capability(
            PrincipalRole::Worker,
            Some(run.run_id),
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            BTreeSet::from([String::from("external.send")]),
            &call,
            NOW_MS + 1,
        )
        .err()
        .ok_or("PartitionLocal 下必须暂存 Outbox")?;
    assert_eq!(queued.code(), ErrorCode::PartitionRestricted);
    assert_eq!(kernel.ledger().outbox().len(), 1);

    // 2. 恢复联网见证态（epoch=2）。
    let local_device = kernel.spine().local_device().device_id();
    kernel.set_lease_posture(LeasePosture::Witnessed {
        witness_epoch: Epoch::new(2),
    });
    let mut coord = FencedLeaseCoordinator::new(
        SimulatedMonotonicClock::new(0),
        LeaseCoordinatorConfig {
            ttl_ms: 30_000,
            safety_margin_ms: 2_000,
            offline_grace_ms: 5_000,
        },
    );
    coord.observe_remote_epoch(2, Some(local_device), &mut kernel);
    let hub = StaticHub {
        witness_epoch: 2,
        uploads: Arc::new(AtomicUsize::new(0)),
    };
    let uploads = Arc::clone(&hub.uploads);
    let mut sync = SpineSyncActor::new();
    let attempts = Arc::new(AtomicUsize::new(0));

    // 3. 第一轮：通道拒绝投递 → 必须保持待投递，且只写 aborted_before_send=true 补偿记录。
    let refuse_attempts = Arc::clone(&attempts);
    let refusal = coord
        .tick_and_reconcile(
            &mut kernel,
            &mut sync,
            &hub,
            &hub,
            NOW_MS + 10,
            move |_cap, _idem, _args, _epoch| {
                refuse_attempts.fetch_add(1, Ordering::SeqCst);
                Err(QuetzalcoatlError::DeliveryRefused {
                    detail: String::from("通道暂不可用（测试注入）"),
                })
            },
        )
        .await
        .err();
    assert!(
        refusal.is_none(),
        "通道拒绝不应让对账周期整体失败: {refusal:?}"
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    let records = delivery_records(&kernel)?;
    let delivered: Vec<&serde_json::Value> = records
        .iter()
        .filter(|r| r["aborted_before_send"].as_bool() == Some(false))
        .collect();
    let aborted: Vec<&serde_json::Value> = records
        .iter()
        .filter(|r| r["aborted_before_send"].as_bool() == Some(true))
        .collect();
    assert!(
        delivered.is_empty(),
        "投递被拒绝时严禁先写已投递见证记录: {records:?}"
    );
    assert_eq!(aborted.len(), 1, "投递被拒绝必须写补偿记录");
    assert_eq!(
        aborted[0]["idempotency_key"].as_str(),
        Some("idem-outbox-fix-round1")
    );
    assert!(
        uploads.load(Ordering::SeqCst) >= 1,
        "补偿记录必须上传 Hub 见证，防其他设备误判已投递"
    );

    // 3b. 通道持续拒收：第二次对账仍拒绝，但不得重复写补偿记录（防脊柱无界膨胀）。
    let uploads_after_first = uploads.load(Ordering::SeqCst);
    let refuse_again = Arc::clone(&attempts);
    let second_refusal = coord
        .tick_and_reconcile(
            &mut kernel,
            &mut sync,
            &hub,
            &hub,
            NOW_MS + 15,
            move |_cap, _idem, _args, _epoch| {
                refuse_again.fetch_add(1, Ordering::SeqCst);
                Err(QuetzalcoatlError::DeliveryRefused {
                    detail: String::from("通道仍不可用（测试注入）"),
                })
            },
        )
        .await
        .err();
    assert!(second_refusal.is_none());
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    let records_after_second = delivery_records(&kernel)?;
    assert_eq!(
        records_after_second
            .iter()
            .filter(|r| r["aborted_before_send"].as_bool() == Some(true))
            .count(),
        1,
        "通道持续拒收时不得每轮重复写补偿记录"
    );
    assert_eq!(
        uploads.load(Ordering::SeqCst),
        uploads_after_first,
        "无新见证记录时不得重复上传"
    );

    // 4. 第二轮：通道恢复 → 同一幂等键必须被真实重试并最终只投递一次。
    let accept_attempts = Arc::clone(&attempts);
    let accepted = coord
        .tick_and_reconcile(
            &mut kernel,
            &mut sync,
            &hub,
            &hub,
            NOW_MS + 20,
            move |_cap, _idem, _args, _epoch| {
                accept_attempts.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .err();
    assert!(accepted.is_none());
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        3,
        "通道恢复后必须重试此前被拒绝的外发项"
    );
    let records = delivery_records(&kernel)?;
    assert!(
        records
            .iter()
            .any(|r| r["aborted_before_send"].as_bool() == Some(false)
                && r["idempotency_key"].as_str() == Some("idem-outbox-fix-round1")),
        "投递成功后必须写已投递见证记录: {records:?}"
    );

    // 5. 第三轮：同键不得再次投递（跨轮幂等）。
    let extra = Arc::new(AtomicUsize::new(0));
    let extra_clone = Arc::clone(&extra);
    let third = coord
        .tick_and_reconcile(
            &mut kernel,
            &mut sync,
            &hub,
            &hub,
            NOW_MS + 30,
            move |_cap, _idem, _args, _epoch| {
                extra_clone.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .err();
    assert!(third.is_none());
    assert_eq!(
        extra.load(Ordering::SeqCst),
        0,
        "已投递的幂等键严禁跨轮重复投递"
    );

    let _ = BTreeMap::<String, String>::new();
    Ok(())
}
