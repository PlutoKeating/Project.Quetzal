#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Fix Round 2 / Item 2：合盖时钟跳变后的内核姿态必须在**任何** Hub/对等网络 I/O 之前
//! 与协调器状态一起降级为 `PartitionLocal`，否则 Critical #1 的远程 Worker 围栏会在数秒内
//! 继续读到陈旧的 `Witnessed` 纪元。

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing};
use quetzalcoatl_fabric::{
    FencedLeaseCoordinator, LeaseCoordinatorConfig, SimulatedMonotonicClock,
};
use quetzalcoatl_kernel::{BlindKernel, HeartScheduler, LeasePosture, SleepPhase};
use quetzalcoatl_sandbox::{SandboxConfig, SandboxManager};
use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, HlcTimestamp};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;
type BoxError = Box<dyn Error + Send + Sync>;
type Kernel = BlindKernel<RusqliteWalStore>;

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

fn build_kernel(home: &Path, posture: LeasePosture) -> Result<Kernel, BoxError> {
    let agent_id = AgentId::new_v4();
    let root = AccountRootKey::generate()?;
    let device = DeviceIdentity::generate(DeviceId::new_v4())?;
    let store = RusqliteWalStore::open(&home.join("spine.sqlite"))?;
    let hlc = HlcTimestamp::from_parts(1_795_400_000_000, 0, device.device_id().hlc_node_tag());
    let mut ring = EpochKeyRing::new_genesis(agent_id, &root, device.public_record())?;
    ring.insert_epoch_key(Epoch::new(1), EpochKey::generate()?);
    let spine = SpineEngine::new(agent_id, device, ring, hlc, store)?;
    let sandbox = SandboxManager::new(SandboxConfig::new(home));
    Ok(BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(1, 0.15, SleepPhase::Awake),
        posture,
    ))
}

#[test]
fn lid_close_jump_demotes_kernel_posture_in_phase_zero_before_any_network_io() -> TestResult {
    let tmp = TempDirGuard::new("qz_lid_close_phase0")?;
    let home = tmp.path().join("node");
    fs::create_dir_all(&home)?;
    let mut kernel = build_kernel(
        &home,
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(5),
        },
    )?;

    let clock = SimulatedMonotonicClock::new(0);
    let mut coord = FencedLeaseCoordinator::new(
        clock.clone(),
        LeaseCoordinatorConfig {
            ttl_ms: 30_000,
            safety_margin_ms: 2_000,
            offline_grace_ms: 5_000,
        },
    );
    let local_device = kernel.spine().local_device().device_id();
    coord.observe_remote_epoch(5, Some(local_device), &mut kernel);
    assert!(matches!(
        kernel.lease_posture(),
        LeasePosture::Witnessed { witness_epoch } if witness_epoch.get() == 5
    ));

    // 模拟笔记本合盖 2 小时：本地单调时钟跳变。
    clock.advance_ms(2 * 60 * 60 * 1_000);

    // Fix Round 2 契约：阶段 0 必须同时降级协调器与内核姿态，且不触发任何网络 I/O。
    let expired = coord.begin_network_tick(&mut kernel);
    assert!(expired, "合盖超期必须在阶段 0 立即判定为过期");
    assert_eq!(
        kernel.lease_posture(),
        LeasePosture::PartitionLocal,
        "阶段 0 必须在内核上同步降级为 PartitionLocal（远程 Worker 围栏不得读到陈旧 Witnessed）"
    );
    assert!(
        matches!(
            coord.state(),
            quetzalcoatl_fabric::RouterLeaseState::Standby { .. }
        ),
        "协调器必须同步回落 Standby"
    );
    assert!(coord.clock_jump_demotions() >= 1);

    Ok(())
}
