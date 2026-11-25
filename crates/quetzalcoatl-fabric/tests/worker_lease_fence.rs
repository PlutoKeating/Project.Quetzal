#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Fix Round 1 / Critical #1：跨机远程 Worker 任务必须先过 `witness_epoch` 两态围栏，
//! 断网 `PartitionLocal` 或纪元不一致时必须在触碰任何脊柱状态、Run 记录与沙箱之前拒绝。

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing};
use quetzalcoatl_fabric::{RemoteWorkerTaskSpec, execute_remote_worker_task_locally};
use quetzalcoatl_kernel::{BlindKernel, HeartScheduler, LeasePosture, SleepPhase};
use quetzalcoatl_sandbox::{SandboxConfig, SandboxManager};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{
    AgentId, DeviceId, Epoch, ErrorCode, HlcTimestamp, QuetzalcoatlError, RunId,
};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;
type BoxError = Box<dyn Error + Send + Sync>;
type Kernel = BlindKernel<RusqliteWalStore>;

struct SpineSnapshot {
    events: usize,
    runs: usize,
    packs: usize,
}

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error + Send + Sync>> {
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

fn now_ms() -> u64 {
    1_795_400_000_000
}

fn build_kernel(home: &Path, posture: LeasePosture) -> Result<Kernel, BoxError> {
    let agent_id = AgentId::new_v4();
    let root = AccountRootKey::generate()?;
    let device = DeviceIdentity::generate(DeviceId::new_v4())?;
    let store = RusqliteWalStore::open(&home.join("spine.sqlite"))?;
    let hlc = HlcTimestamp::from_parts(now_ms(), 0, device.device_id().hlc_node_tag());
    let mut ring = EpochKeyRing::new_genesis(agent_id, &root, device.public_record())?;
    ring.insert_epoch_key(Epoch::new(1), EpochKey::generate()?);
    let spine = SpineEngine::new(agent_id, device, ring, hlc, store)?;
    let sandbox = SandboxManager::new(SandboxConfig::new(home));
    let kernel = BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(1, 0.15, SleepPhase::Awake),
        posture,
    );
    Ok(kernel)
}

fn sample_task() -> RemoteWorkerTaskSpec {
    RemoteWorkerTaskSpec {
        run_id: RunId::new_v4(),
        title: String::from("fenced remote worker"),
        required_tags: Vec::new(),
        worker_shell_script: String::from("echo should-never-run"),
        workspace_files: BTreeMap::new(),
        verifier_suite_files: BTreeMap::new(),
        verifier_shell_cmd: None,
    }
}

fn spine_state(kernel: &Kernel) -> Result<SpineSnapshot, BoxError> {
    Ok(SpineSnapshot {
        events: kernel.spine().store().list_all_events()?.len(),
        runs: kernel.runs().list_runs().len(),
        packs: kernel.spine().store().list_packfiles()?.len(),
    })
}

#[test]
fn remote_worker_task_rejected_by_partition_local_and_stale_epoch_without_spine_or_sandbox_side_effects()
-> TestResult {
    let tmp = TempDirGuard::new("qz_worker_fence")?;
    let home = tmp.path().join("node");
    fs::create_dir_all(&home)?;

    // 1. PartitionLocal：任何远程任务（哪怕携带"正确"纪元）都必须在触碰脊柱/沙箱前被拒。
    let mut kernel = build_kernel(home.as_path(), LeasePosture::PartitionLocal)?;
    let before = spine_state(&kernel)?;
    let partition_err =
        execute_remote_worker_task_locally(&mut kernel, &sample_task(), Epoch::new(1), now_ms())
            .err()
            .ok_or("PartitionLocal 下远程 Worker 任务必须被拒绝")?;
    match partition_err {
        QuetzalcoatlError::PartitionRestricted { .. } => {}
        other => return Err(format!("期望 PartitionRestricted，实际 {other:?}").into()),
    }
    let after_partition = spine_state(&kernel)?;
    assert_eq!(
        after_partition.events, before.events,
        "围栏拒绝不得追加脊柱事件"
    );
    assert_eq!(after_partition.runs, before.runs, "围栏拒绝不得创建 Run");
    assert_eq!(
        after_partition.packs, before.packs,
        "围栏拒绝不得密封 Packfile"
    );

    // 2. Witnessed(epoch=5) 下携带过期 epoch=4 的任务同样必须被拒。
    kernel.set_lease_posture(LeasePosture::Witnessed {
        witness_epoch: Epoch::new(5),
    });
    let stale_err =
        execute_remote_worker_task_locally(&mut kernel, &sample_task(), Epoch::new(4), now_ms())
            .err()
            .ok_or("陈旧 witness_epoch 的远程 Worker 任务必须被拒绝")?;
    assert_eq!(stale_err.code(), ErrorCode::StaleLeaseEpoch);
    match stale_err {
        QuetzalcoatlError::StaleLeaseEpoch { provided, current } => {
            assert_eq!(provided, 4);
            assert_eq!(current, 5);
        }
        other => return Err(format!("期望 StaleLeaseEpoch 详情，实际 {other:?}").into()),
    }
    let after_stale = spine_state(&kernel)?;
    assert_eq!(after_stale.events, before.events);
    assert_eq!(after_stale.runs, before.runs);
    assert_eq!(after_stale.packs, before.packs);

    Ok(())
}
