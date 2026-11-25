#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Fix Round 1 / Important #5（前半）：在**完全没有 Hub**（`relay: None`）的情况下，
//! 仅经 `iroh` 直连 QUIC 的 P2P 分阶段 Packfile 同步路径必须真实可用：
//! `collect_peer_sync_plan` → `exchange_with_peer`（零内核锁网络）→ `apply_peer_sync`（短锁合入）。

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing, PackCompartment,
};
use quetzalcoatl_fabric::{
    FabricNode, FabricNodeConfig, FabricRpcHandler, FabricRpcRequest, FabricRpcResponse,
    PeerSyncOutcome, SpineSyncActor,
};
use quetzalcoatl_kernel::{BlindKernel, HeartScheduler, LeasePosture, SleepPhase};
use quetzalcoatl_sandbox::{SandboxConfig, SandboxManager};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, HlcTimestamp};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;
type BoxError = Box<dyn Error + Send + Sync>;
type Kernel = Arc<Mutex<BlindKernel<RusqliteWalStore>>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, BoxError> {
        let parent = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
        let uid = Uuid::new_v4().simple().to_string();
        let path = parent.join(format!("{prefix}_{}", &uid[..12]));
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

fn build_kernel(
    home: &Path,
    agent_id: AgentId,
    device: &DeviceIdentity,
    ring: &EpochKeyRing,
) -> Result<Kernel, BoxError> {
    let store = RusqliteWalStore::open(&home.join("spine.sqlite"))?;
    let hlc = HlcTimestamp::from_parts(NOW_MS, 0, device.device_id().hlc_node_tag());
    let spine = SpineEngine::new(agent_id, device.clone(), ring.clone(), hlc, store)?;
    let sandbox = SandboxManager::new(SandboxConfig::new(home));
    Ok(Arc::new(Mutex::new(BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(1, 0.15, SleepPhase::Awake),
        LeasePosture::PartitionLocal,
    ))))
}

/// 远端节点只负责把收到的 Packfile 合入脊柱（模拟守护进程 handler 的 PushPackfiles 分支）。
struct IngestHandler {
    kernel: Kernel,
}

impl FabricRpcHandler for IngestHandler {
    fn handle_rpc(
        &self,
        _authenticated_peer_device: DeviceId,
        req: FabricRpcRequest,
    ) -> FabricRpcResponse {
        match req {
            FabricRpcRequest::PushPackfiles { packs, .. } => {
                let Ok(mut kernel) = self.kernel.lock() else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("lock poisoned"),
                    };
                };
                match SpineSyncActor::ingest_packfiles_and_rehydrate(
                    &mut kernel,
                    &packs,
                    NOW_MS + 10,
                ) {
                    Ok((ingested, _)) => FabricRpcResponse::PackfilesAck {
                        ingested_events: ingested,
                    },
                    Err(e) => FabricRpcResponse::Error {
                        code: String::from(e.code().as_str()),
                        detail: e.to_string(),
                    },
                }
            }
            FabricRpcRequest::PullPackfiles { known_heads, .. } => {
                let Ok(kernel) = self.kernel.lock() else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("lock poisoned"),
                    };
                };
                let heads: BTreeMap<DeviceId, u64> = known_heads.into_iter().collect();
                let packs = kernel
                    .spine()
                    .store()
                    .list_packfiles()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|p| {
                        let peer_seq = heads.get(&p.aad.device_id).copied().unwrap_or(0);
                        p.aad.last_seq > peer_seq
                    })
                    .collect();
                FabricRpcResponse::PackfilesBatch { packs }
            }
            _ => FabricRpcResponse::Error {
                code: String::from("PERMISSION_DENIED"),
                detail: String::from("unsupported op in peer-only test"),
            },
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn peer_only_staged_sync_works_without_any_hub_relay() -> TestResult {
    let tmp = TempDirGuard::new("qz_peer_only_sync")?;
    let home_a = tmp.path().join("node_a");
    let home_b = tmp.path().join("node_b");
    fs::create_dir_all(&home_a)?;
    fs::create_dir_all(&home_b)?;

    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let device_a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let device_b = DeviceIdentity::generate(DeviceId::new_v4())?;
    let mut ring = EpochKeyRing::new_genesis(agent_id, &root_key, device_a.public_record())?;
    ring.insert_epoch_key(Epoch::new(1), EpochKey::generate()?);
    let _ = ring.add_device(&root_key, device_b.public_record())?;

    let kernel_a = build_kernel(&home_a, agent_id, &device_a, &ring)?;
    let kernel_b = build_kernel(&home_b, agent_id, &device_b, &ring)?;

    let node_a = FabricNode::bind(
        FabricNodeConfig {
            agent_id,
            device: device_a.clone(),
            epoch_ring: ring.clone(),
            bind_ipv4: Some(std::net::SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                0,
            ))),
            enable_mdns: false,
            discover_overlay_interfaces: false,
            relay: None,
            local_capabilities: None,
        },
        None,
    )
    .await?;
    let node_b = FabricNode::bind(
        FabricNodeConfig {
            agent_id,
            device: device_b.clone(),
            epoch_ring: ring,
            bind_ipv4: Some(std::net::SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                0,
            ))),
            enable_mdns: false,
            discover_overlay_interfaces: false,
            relay: None,
            local_capabilities: None,
        },
        Some(Arc::new(IngestHandler {
            kernel: Arc::clone(&kernel_b),
        })),
    )
    .await?;

    // 1. 节点 A 追加并密封一条事件（不含任何 Hub 上传）。
    let marker = "PEER_ONLY_CANARY_4471";
    {
        let mut ka = kernel_a.lock().map_err(|_| "lock ka")?;
        ka.spine_mut().append_event(
            PackCompartment::Core,
            &format!(r#"{{"peer_only_marker":"{marker}"}}"#),
            NOW_MS + 1,
        )?;
        let sealed = ka.spine_mut().seal_checkpoint(None, NOW_MS + 2)?;
        assert_eq!(sealed.len(), 1);
    }
    let events_b_before = {
        let kb = kernel_b.lock().map_err(|_| "lock kb")?;
        kb.spine().store().list_all_events()?.len()
    };

    // 2. 分阶段：计划（短锁）→ 直连网络交换（零内核锁）→ 合入（短锁）。
    let plan = {
        let ka = kernel_a.lock().map_err(|_| "lock ka")?;
        SpineSyncActor::collect_peer_sync_plan(&ka)?
    };
    let peer_addr = node_b.endpoint_addr()?;
    node_a.register_peer_addr(peer_addr.clone());
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        SpineSyncActor::exchange_with_peer(
            &node_a,
            peer_addr,
            agent_id,
            device_a.device_id(),
            &plan,
        ),
    )
    .await
    .map_err(|_| "peer exchange timed out")??;
    assert_eq!(outcome.uploaded_packs, 1);
    let PeerSyncOutcome {
        pulled_packs: _,
        uploaded_packs: _,
    } = outcome.clone();

    // 3. 远端 handler 已真实合入（PushPackfiles 分支）→ 事件数必须增加且含 canary 明文（本地解密）。
    let (events_b_after, has_marker) = {
        let kb = kernel_b.lock().map_err(|_| "lock kb")?;
        let events = kb.spine().store().list_all_events()?;
        let has = events
            .iter()
            .any(|(ev, _)| ev.payload_utf8.contains(marker));
        (events.len(), has)
    };
    assert!(
        events_b_after > events_b_before,
        "无 Hub 的纯 P2P 同步必须让节点 B 收到新事件"
    );
    assert!(has_marker, "节点 B 应以本机纪元密钥解密出远端事件明文");

    // 4. apply_peer_sync 对空结果幂等（零重复合入）。
    let (ingested, _) = {
        let mut kb = kernel_b.lock().map_err(|_| "lock kb")?;
        SpineSyncActor::apply_peer_sync(
            &mut kb,
            &PeerSyncOutcome {
                uploaded_packs: 0,
                pulled_packs: Vec::new(),
            },
            NOW_MS + 20,
        )?
    };
    assert_eq!(ingested, 0);

    node_a.shutdown().await;
    node_b.shutdown().await;
    Ok(())
}
