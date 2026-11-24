#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityDescriptor, CapabilityInvocation, CapabilityOrigin, CapabilitySet,
    CleanRoomVerifierDag, EndogenousDrives, EvolvedSkillSpec, ExecutionSurface,
    ExternalWriteDisposition, FALL_ASLEEP_THRESHOLD, HeartScheduler, HostInhibitors, LeasePosture,
    MovementOutcome, NATURAL_WAKE_THRESHOLD, PrincipalRole, RunMode, RunStatus, ScopeChain,
    SinkClass, SleepPhase, VerifierNode, WakeSignalResult, compute_workspace_tree_blake3,
};
use quetzalcoatl_sandbox::{SandboxCommand, SandboxConfig, SandboxManager};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, ErrorCode, HlcTimestamp};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
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

fn build_test_kernel(
    tmp: &TempDirGuard,
    posture: LeasePosture,
) -> Result<BlindKernel<RusqliteWalStore>, Box<dyn Error>> {
    let qz_home = tmp.path().join("qz_home");
    let fake_user_home = tmp.path().join("user_home");
    fs::create_dir_all(&qz_home)?;
    fs::create_dir_all(&fake_user_home)?;

    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::from_bytes([0x5au8; 32]);
    let dev = DeviceIdentity::from_seeds(DeviceId::new_v4(), [0x12u8; 32], [0x34u8; 32])?;
    let epoch_ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev.public_record())?;
    let store = RusqliteWalStore::open(&qz_home.join("spine/spine.sqlite"))?;
    let spine = SpineEngine::new(
        agent_id,
        dev,
        epoch_ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, 1),
        store,
    )?;

    let mut sbx_cfg = SandboxConfig::new(&qz_home);
    sbx_cfg.user_home = Some(fake_user_home);
    let sandbox = SandboxManager::new(sbx_cfg);
    let heart = HeartScheduler::new(0xfeed_face_cafe_babe, 0.20, SleepPhase::Awake);

    let mut kernel = BlindKernel::new(spine, sandbox, heart, posture);
    for desc in [
        CapabilityDescriptor {
            capability_id: String::from("fs.local_read"),
            interface_id: String::from("core.fs"),
            sink_class: SinkClass::LocalRead,
            surface: ExecutionSurface::PureMetadata,
            idempotent: true,
            origin: CapabilityOrigin::HostRegistered,
        },
        CapabilityDescriptor {
            capability_id: String::from("sandbox.self_evolve"),
            interface_id: String::from("core.sandbox"),
            sink_class: SinkClass::SandboxSelfEvolution,
            surface: ExecutionSurface::SandboxFileWrite,
            idempotent: false,
            origin: CapabilityOrigin::HostRegistered,
        },
        CapabilityDescriptor {
            capability_id: String::from("sandbox.shell_exec"),
            interface_id: String::from("core.sandbox"),
            sink_class: SinkClass::CodeRepositoryMutation,
            surface: ExecutionSurface::SandboxShell,
            idempotent: false,
            origin: CapabilityOrigin::HostRegistered,
        },
        CapabilityDescriptor {
            capability_id: String::from("repo.apply_patch"),
            interface_id: String::from("core.repo"),
            sink_class: SinkClass::CodeRepositoryMutation,
            surface: ExecutionSurface::SandboxFileWrite,
            idempotent: false,
            origin: CapabilityOrigin::HostRegistered,
        },
        CapabilityDescriptor {
            capability_id: String::from("thread.voice_reply"),
            interface_id: String::from("core.thread"),
            sink_class: SinkClass::RoutineResponse,
            surface: ExecutionSurface::ThreadVoice,
            idempotent: true,
            origin: CapabilityOrigin::HostRegistered,
        },
        CapabilityDescriptor {
            capability_id: String::from("world.public_dispatch"),
            interface_id: String::from("world.messaging"),
            sink_class: SinkClass::HighRiskExternalWrite,
            surface: ExecutionSurface::ExternalChannel,
            idempotent: false,
            origin: CapabilityOrigin::HostRegistered,
        },
        CapabilityDescriptor {
            capability_id: String::from("guardian.local_siren"),
            interface_id: String::from("domain.eldercare"),
            sink_class: SinkClass::EmergencyLocalAlert,
            surface: ExecutionSurface::PureMetadata,
            idempotent: false,
            origin: CapabilityOrigin::HostRegistered,
        },
    ] {
        kernel.register_capability(desc)?;
    }

    Ok(kernel)
}

#[cfg(target_os = "linux")]
#[test]
fn explore_run_synthesizes_and_executes_sandbox_skill_immediately_but_refuses_external_writes()
-> TestResult {
    let tmp = TempDirGuard::new("qz_explore_skill")?;
    let mut kernel = build_test_kernel(
        &tmp,
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    )?;

    let explore_ws = tmp.path().join("explore_cow_ws");
    fs::create_dir_all(explore_ws.join("skills"))?;
    fs::write(
        explore_ws.join("skills/summarize_numbers.py"),
        "import sys\nnums = [int(x) for x in sys.argv[1:]]\nprint(f'COUNT={len(nums)} SUM={sum(nums)}')\n",
    )?;

    let run = kernel.spawn_explore_run(
        "闲置期自主探索算子合成",
        Some(explore_ws.clone()),
        1_795_400_001_000,
    )?;
    assert_eq!(run.mode, RunMode::Explore);
    assert_eq!(run.status, RunStatus::Active);

    let all_bindings = BTreeSet::from([
        String::from("fs.local_read"),
        String::from("sandbox.self_evolve"),
        String::from("world.public_dispatch"),
        String::from("thread.voice_reply"),
        String::from("repo.apply_patch"),
    ]);

    // 1. Explore Run 允许本地只读
    let read_decision = kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        all_bindings.clone(),
        &CapabilityInvocation::new("fs.local_read", r#"{"path":"notes.md"}"#),
        1_795_400_001_100,
    )?;
    assert_eq!(read_decision.granted.resolved_sink, SinkClass::LocalRead);

    // 2. Explore Run 零人工弹窗即时注册沙箱本地自演化技能并在真实 Linux bwrap 沙箱内立即调用执行
    let skill_desc = kernel.synthesize_evolved_skill(
        run.run_id,
        &CapabilitySet::All,
        &ScopeChain::unrestricted(),
        &all_bindings,
        EvolvedSkillSpec {
            skill_id: String::from("skill.summarize_numbers"),
            interface_id: String::from("sandbox.evolved"),
            relative_script_path: PathBuf::from("skills/summarize_numbers.py"),
            interpreter: String::from("/usr/bin/python3"),
            description: String::from("统计输入整数序列个数与总和"),
        },
        1_795_400_001_200,
    )?;
    assert_eq!(skill_desc.skill_id, "skill.summarize_numbers");

    let exec_out = kernel.execute_evolved_skill(
        run.run_id,
        "skill.summarize_numbers",
        vec![String::from("10"), String::from("20"), String::from("12")],
        &CapabilitySet::All,
        &ScopeChain::unrestricted(),
        &all_bindings,
        1_795_400_001_300,
    )?;
    assert!(
        exec_out.success(),
        "Explore 新合成沙箱技能执行失败: stderr={}",
        exec_out.stderr_lossy()
    );
    assert_eq!(exec_out.stdout_lossy().trim(), "COUNT=3 SUM=42");

    // 3. Explore Run 企图调用外部写能力（即便在 AuthoredBindings 与 WorkerCeiling 内），必须被硬拒绝 DeliveryRefused！
    let events_before = kernel.spine().store().list_all_events()?.len();
    let refused_err = kernel
        .authorize_capability(
            PrincipalRole::Worker,
            Some(run.run_id),
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            all_bindings,
            &CapabilityInvocation::new("world.public_dispatch", r#"{"msg":"leak from explore"}"#),
            1_795_400_001_400,
        )
        .err()
        .ok_or("Explore Run 外发请求必须被拒绝")?;
    assert_eq!(refused_err.code(), ErrorCode::DeliveryRefused);

    // 断言拒绝动作同步载入 MovementLedger 与 SpineEngine 签名事件链
    let last_movement = kernel
        .ledger()
        .records()
        .last()
        .ok_or("MovementLedger 应记录拒绝条目")?;
    assert_eq!(last_movement.outcome, MovementOutcome::DeliveryRefused);
    assert_eq!(last_movement.capability_id, "world.public_dispatch");

    let all_events = kernel.spine().store().list_all_events()?;
    assert!(
        all_events.len() > events_before,
        "DeliveryRefused 审计记录必须持久化至 SpineEngine"
    );
    let last_spine_payload = &all_events.last().ok_or("缺少脊柱事件")?.0.payload_utf8;
    assert!(last_spine_payload.contains("delivery_refused"));

    Ok(())
}

#[test]
fn router_principal_deprivation_and_multi_hop_scope_chain_attenuation() -> TestResult {
    let tmp = TempDirGuard::new("qz_router_scope")?;
    let mut kernel = build_test_kernel(
        &tmp,
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    )?;

    let ws = tmp.path().join("commit_ws");
    fs::create_dir_all(&ws)?;
    let run = kernel.spawn_commit_run("编码交付任务", Some(ws), 1_795_400_002_000)?;

    let full_bindings = BTreeSet::from([
        String::from("fs.local_read"),
        String::from("thread.voice_reply"),
        String::from("sandbox.shell_exec"),
        String::from("sandbox.self_evolve"),
        String::from("repo.apply_patch"),
        String::from("world.public_dispatch"),
    ]);

    // 1. Router 允许本地读取与单声道 Thread 回复
    let router_reply = kernel.authorize_capability(
        PrincipalRole::Router,
        None,
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        full_bindings.clone(),
        &CapabilityInvocation::new("thread.voice_reply", r#"{"text":"已派发 Worker 处理"}"#),
        1_795_400_002_100,
    )?;
    assert_eq!(
        router_reply.granted.resolved_sink,
        SinkClass::RoutineResponse
    );

    // 2. Router 被架构级硬剥夺 shell / file_write / CodeRepositoryMutation / SandboxSelfEvolution
    for forbidden_for_router in [
        "sandbox.shell_exec",
        "repo.apply_patch",
        "sandbox.self_evolve",
    ] {
        let err = kernel
            .authorize_capability(
                PrincipalRole::Router,
                Some(run.run_id),
                CapabilitySet::All,
                ScopeChain::unrestricted(),
                full_bindings.clone(),
                &CapabilityInvocation::new(forbidden_for_router, "{}"),
                1_795_400_002_200,
            )
            .err()
            .ok_or("Router 必须被硬剥夺编码/终端/写文件能力")?;
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
    }

    // 3. 多跳衰减 ScopeChain 交集验证（Hop 2 企图重新加回 world.public_dispatch 绝不能生效）
    let scope_chain = ScopeChain::unrestricted()
        .attenuate(["fs.local_read", "repo.apply_patch", "world.public_dispatch"])
        .attenuate(["fs.local_read", "repo.apply_patch"])
        .attenuate(["fs.local_read", "repo.apply_patch", "world.public_dispatch"]);

    let worker_patch = kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(run.run_id),
        CapabilitySet::explicit(["fs.local_read", "repo.apply_patch", "world.public_dispatch"]),
        scope_chain.clone(),
        full_bindings.clone(),
        &CapabilityInvocation::new("repo.apply_patch", r#"{"diff":"..."}"#),
        1_795_400_002_300,
    )?;
    assert_eq!(
        worker_patch.granted.resolved_sink,
        SinkClass::CodeRepositoryMutation
    );

    let attenuated_err = kernel
        .authorize_capability(
            PrincipalRole::Worker,
            Some(run.run_id),
            CapabilitySet::All,
            scope_chain,
            full_bindings,
            &CapabilityInvocation::new("world.public_dispatch", r#"{"msg":"escalate"}"#),
            1_795_400_002_400,
        )
        .err()
        .ok_or("被中间跳收窄剥夺的能力绝不可被后续跳恢复")?;
    assert_eq!(attenuated_err.code(), ErrorCode::PermissionDenied);

    Ok(())
}

#[test]
fn partition_local_lease_queues_public_writes_while_permitting_local_dialogue_explore_and_emergency_alert()
-> TestResult {
    let tmp = TempDirGuard::new("qz_partition_lease")?;
    let mut kernel = build_test_kernel(&tmp, LeasePosture::PartitionLocal)?;

    let ws = tmp.path().join("guardian_ws");
    fs::create_dir_all(&ws)?;
    let commit_run = kernel.spawn_commit_run("断网看护与外发控制", Some(ws), 1_795_400_003_000)?;

    let bindings = BTreeSet::from([
        String::from("fs.local_read"),
        String::from("thread.voice_reply"),
        String::from("guardian.local_siren"),
        String::from("world.public_dispatch"),
    ]);

    // 1. PartitionLocal 下允许本地对话与长辈紧急本地告警
    let local_dialogue = kernel.authorize_capability(
        PrincipalRole::Router,
        Some(commit_run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings.clone(),
        &CapabilityInvocation::new("thread.voice_reply", r#"{"text":"离线本地陪伴响应"}"#),
        1_795_400_003_100,
    )?;
    assert_eq!(
        local_dialogue.granted.resolved_sink,
        SinkClass::RoutineResponse
    );

    let siren = kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(commit_run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings.clone(),
        &CapabilityInvocation::new("guardian.local_siren", r#"{"level":"critical_fall"}"#),
        1_795_400_003_200,
    )?;
    assert_eq!(siren.granted.resolved_sink, SinkClass::EmergencyLocalAlert);

    // 2. PartitionLocal 下非幂等公网外发返回 PartitionRestricted 并暂存 Outbox
    let mut pub_call =
        CapabilityInvocation::new("world.public_dispatch", r#"{"body":"notify clinic"}"#);
    pub_call.idempotency_key = Some(String::from("op-notify-001"));
    let part_err = kernel
        .authorize_capability(
            PrincipalRole::Worker,
            Some(commit_run.run_id),
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            bindings.clone(),
            &pub_call,
            1_795_400_003_300,
        )
        .err()
        .ok_or("断网分区租约必须拦截非幂等公网外发")?;
    assert_eq!(part_err.code(), ErrorCode::PartitionRestricted);
    assert_eq!(kernel.ledger().outbox().len(), 1);
    assert_eq!(
        kernel.ledger().outbox()[0].capability_id,
        "world.public_dispatch"
    );

    // 3. 重获 Hub witness_epoch 后对账排空 Outbox，并验证写前幂等锁去重与防篡改
    kernel.set_lease_posture(LeasePosture::Witnessed {
        witness_epoch: Epoch::new(2),
    });
    let drained = kernel.drain_reconciled_outbox(Epoch::new(2))?;
    assert_eq!(drained.len(), 1);
    assert!(kernel.ledger().outbox().is_empty());

    let first_write = kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(commit_run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings.clone(),
        &pub_call,
        1_795_400_003_400,
    )?;
    assert!(matches!(
        first_write.write_ahead,
        Some(ExternalWriteDisposition::PermittedNew { .. })
    ));

    // 相同幂等键 + 相同载荷 -> 幂等去重拦截重复发送
    let dup_write = kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(commit_run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings.clone(),
        &pub_call,
        1_795_400_003_500,
    )?;
    assert!(matches!(
        dup_write.write_ahead,
        Some(ExternalWriteDisposition::DuplicateSuppressed { .. })
    ));

    // 相同幂等键 + 篡改后不同载荷 -> IntegrityViolation
    let mut conflicting_call =
        CapabilityInvocation::new("world.public_dispatch", r#"{"body":"TAMPERED"}"#);
    conflicting_call.idempotency_key = Some(String::from("op-notify-001"));
    let conflict_err = kernel
        .authorize_capability(
            PrincipalRole::Worker,
            Some(commit_run.run_id),
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            bindings,
            &conflicting_call,
            1_795_400_003_600,
        )
        .err()
        .ok_or("同幂等键不同载荷必须触发 IntegrityViolation")?;
    assert_eq!(conflict_err.code(), ErrorCode::IntegrityViolation);

    Ok(())
}

#[test]
fn routine_commit_run_completes_with_zero_verifier_subprocesses_and_blocks_sink_spoofing()
-> TestResult {
    let tmp = TempDirGuard::new("qz_routine_commit")?;
    let mut kernel = build_test_kernel(
        &tmp,
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    )?;

    // 1. 日常问答 / 陪伴 Commit Run：仅触及 LocalRead 与 RoutineResponse -> 0 次洁净室子进程秒结！
    let routine_run = kernel.spawn_commit_run("日常伴学答疑", None, 1_795_400_004_000)?;
    let bindings = BTreeSet::from([
        String::from("fs.local_read"),
        String::from("thread.voice_reply"),
        String::from("repo.apply_patch"),
    ]);

    kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(routine_run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings.clone(),
        &CapabilityInvocation::new("fs.local_read", r#"{"doc":"chapter1.md"}"#),
        1_795_400_004_100,
    )?;
    kernel.authorize_capability(
        PrincipalRole::Router,
        Some(routine_run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings.clone(),
        &CapabilityInvocation::new("thread.voice_reply", r#"{"answer":"苏格拉底追问提示"}"#),
        1_795_400_004_200,
    )?;

    let report =
        kernel.complete_commit_run_without_verifier(routine_run.run_id, 1_795_400_004_300)?;
    assert_eq!(report.verifier_runs, 0);
    assert!(report.verification_mark.is_none());
    assert_eq!(report.final_status, RunStatus::Completed);
    assert_eq!(kernel.total_verifier_runs(), 0);

    // 2. 反模型自述伪造（D-16）：调用 repo.apply_patch 时伪造 model_claimed_sink = RoutineResponse，
    // 内核必须强制按注册表判定为 CodeRepositoryMutation 并拒绝免检结项！
    let ws = tmp.path().join("code_ws");
    fs::create_dir_all(&ws)?;
    let spoof_run =
        kernel.spawn_commit_run("伪装为普通问答的代码修改", Some(ws), 1_795_400_004_400)?;
    let mut spoof_call = CapabilityInvocation::new("repo.apply_patch", r#"{"file":"src/lib.rs"}"#);
    spoof_call.model_claimed_sink = Some(SinkClass::RoutineResponse);

    let decision = kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(spoof_run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings,
        &spoof_call,
        1_795_400_004_500,
    )?;
    assert_eq!(
        decision.granted.resolved_sink,
        SinkClass::CodeRepositoryMutation,
        "内核绝不可相信模型自报的 RoutineResponse 标签"
    );

    let bypass_err = kernel
        .complete_commit_run_without_verifier(spoof_run.run_id, 1_795_400_004_600)
        .err()
        .ok_or("触及代码仓库变更的 Commit Run 严禁跳过洁净室 Verifier")?;
    assert_eq!(bypass_err.code(), ErrorCode::VerificationFailed);

    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn clean_room_verifier_blocks_reward_hacking_vacuous_zero_tests_and_toctou_mutation_then_mints_mark()
-> TestResult {
    let tmp = TempDirGuard::new("qz_cleanroom_dag")?;
    let mut kernel = build_test_kernel(
        &tmp,
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    )?;

    let candidate_ws = tmp.path().join("candidate_repo");
    let locked_suite_dir = tmp.path().join("kernel_locked_suite");
    let vacuous_suite_dir = tmp.path().join("vacuous_suite");
    fs::create_dir_all(candidate_ws.join("tests"))?;
    fs::create_dir_all(&locked_suite_dir)?;
    fs::create_dir_all(&vacuous_suite_dir)?;

    let canary_listener = TcpListener::bind("127.0.0.1:0")?;
    let canary_port = canary_listener.local_addr()?.port();

    // Worker 作弊场景：把候选工作区内的实现写错（减法冒充加法），并把工作区内的测试全部删改为空断言通过！
    fs::write(
        candidate_ws.join("calc.py"),
        "def add(a, b):\n    return a - b\n",
    )?;
    fs::write(
        candidate_ws.join("tests/test_calc.py"),
        "def test_worker_tampered():\n    assert True\n",
    )?;

    // 内核锁定的外部只读校验套件：同时检查断网隔离、只读防篡改与 3 个真实客观断言
    let real_verifier_py = format!(
        concat!(
            "import os, socket, sys\n",
            "ws = os.environ['QUETZALCOATL_CANDIDATE_WORKSPACE']\n",
            "suite = os.environ['QUETZALCOATL_VERIFIER_SUITE_DIR']\n",
            "# 验证洁净室彻底断网\n",
            "try:\n",
            "    socket.create_connection(('127.0.0.1', {port}), timeout=0.3)\n",
            "    sys.exit(91)\n",
            "except OSError:\n",
            "    pass\n",
            "# 验证候选工作区与锁定校验套件在洁净室内严格只读\n",
            "for target in [os.path.join(ws, 'calc.py'), os.path.join(suite, 'run_verify.py')]:\n",
            "    try:\n",
            "        open(target, 'a').write('# mutate')\n",
            "        sys.exit(92)\n",
            "    except OSError:\n",
            "        pass\n",
            "sys.path.insert(0, ws)\n",
            "import calc\n",
            "cases = [(2, 3, 5), (-4, 10, 6), (0, 0, 0)]\n",
            "passed = 0\n",
            "for a, b, expected in cases:\n",
            "    if calc.add(a, b) == expected:\n",
            "        passed += 1\n",
            "failed = len(cases) - passed\n",
            "import json\n",
            "report = json.dumps({{'executed_tests': len(cases), 'passed_tests': passed, 'failed_tests': failed}})\n",
            "print('QZ_VERIFIER_REPORT: ' + report)\n",
            "sys.exit(0 if failed == 0 else 1)\n"
        ),
        port = canary_port,
    );
    fs::write(locked_suite_dir.join("run_verify.py"), &real_verifier_py)?;

    // 空跑套件（0 用例退出码 0，模拟被掏空的测试配置）
    fs::write(
        vacuous_suite_dir.join("empty_verify.sh"),
        "#!/bin/sh\necho 'running 0 tests'\necho 'test result: ok. 0 passed; 0 failed; 0 ignored;'\nexit 0\n",
    )?;

    // 从 Explore 启动并在发现工程任务后正交切换锁定为 Commit Run
    let explore_run = kernel.spawn_explore_run(
        "探索代码库结构",
        Some(candidate_ws.clone()),
        1_795_400_005_000,
    )?;
    let commit_run = kernel.claim_explore_into_commit(
        explore_run.run_id,
        "修复加法实现并通过洁净室验收",
        Some(candidate_ws.clone()),
        1_795_400_005_100,
    )?;
    assert_eq!(commit_run.mode, RunMode::Commit);
    assert!(commit_run.checkpoint_lock.is_some());

    let bindings = BTreeSet::from([String::from("repo.apply_patch")]);
    kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(commit_run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings,
        &CapabilityInvocation::new("repo.apply_patch", r#"{"file":"calc.py"}"#),
        1_795_400_005_200,
    )?;

    let real_dag = CleanRoomVerifierDag::new(vec![
        VerifierNode {
            node_id: String::from("syntax_gate"),
            depends_on: Vec::new(),
            verifier_suite_dir: locked_suite_dir.clone(),
            command: SandboxCommand::new(
                "/usr/bin/python3",
                vec![
                    String::from("-c"),
                    String::from(
                        "import os, py_compile; py_compile.compile(os.path.join(os.environ['QUETZALCOATL_CANDIDATE_WORKSPACE'], 'calc.py'), cfile='/tmp/calc.pyc', doraise=True); print('test result: ok. 1 passed; 0 failed; 0 ignored;')",
                    ),
                ],
            ),
            expected_suite_blake3: None,
        },
        VerifierNode {
            node_id: String::from("functional_suite"),
            depends_on: vec![String::from("syntax_gate")],
            verifier_suite_dir: locked_suite_dir.clone(),
            command: SandboxCommand::new(
                "/usr/bin/python3",
                vec![
                    locked_suite_dir
                        .join("run_verify.py")
                        .to_string_lossy()
                        .into_owned(),
                ],
            ),
            expected_suite_blake3: None,
        },
    ])?;

    // 红队测试 A：Worker 虽然改绿了工作区内的 tests/test_calc.py，但外部洁净室套件立即抓获真实实现错误！
    let hack_err = kernel
        .complete_commit_run(commit_run.run_id, Some(&real_dag), 1_795_400_005_300)
        .err()
        .ok_or("篡改工作区测试不能绕过外部锁定洁净室校验套件")?;
    assert_eq!(hack_err.code(), ErrorCode::VerificationFailed);
    assert!(
        kernel
            .runs()
            .get_run(commit_run.run_id)
            .and_then(|r| r.verification_mark.as_ref())
            .is_none()
    );

    // 红队测试 B：Anti-Vacuity —— 退出码为 0 但实际运行 0 个测试用例，必须硬判失败拒发 Mark！
    let vacuous_dag = CleanRoomVerifierDag::single(
        "vacuous_check",
        vacuous_suite_dir.clone(),
        SandboxCommand::new(
            "/bin/sh",
            vec![
                vacuous_suite_dir
                    .join("empty_verify.sh")
                    .to_string_lossy()
                    .into_owned(),
            ],
        ),
    );
    let vacuous_err = kernel
        .complete_commit_run(commit_run.run_id, Some(&vacuous_dag), 1_795_400_005_400)
        .err()
        .ok_or("0 测试命中（Anti-Vacuity）必须判失败")?;
    assert_eq!(vacuous_err.code(), ErrorCode::VerificationFailed);

    // 修复真实代码实现
    let valid_code = "def add(a, b):\n    return a + b\n";
    fs::write(candidate_ws.join("calc.py"), valid_code)?;
    let expected_tree_digest = compute_workspace_tree_blake3(&candidate_ws)?;

    // 先跑通洁净室 DAG 拿到候选收据
    let receipt =
        kernel.verify_commit_candidate(commit_run.run_id, &real_dag, 1_795_400_005_500)?;
    assert_eq!(receipt.candidate_tree_blake3, expected_tree_digest);
    assert_eq!(receipt.passed_test_count, 4); // syntax_gate (1) + functional_suite (3)
    assert_eq!(receipt.verifier_runs, 2);

    // 红队测试 C：在洁净室校验通过后、签发 VerificationMark 落盘前偷改候选工作区 1 行代码（TOCTOU）！
    fs::write(
        candidate_ws.join("calc.py"),
        "def add(a, b):\n    return a + b + 999\n",
    )?;
    let toctou_err = kernel
        .finalize_commit_with_receipt(&receipt, 1_795_400_005_600)
        .err()
        .ok_or("校验后工作区被篡改必须导致 Mark 签发失效")?;
    assert!(matches!(
        toctou_err.code(),
        ErrorCode::IntegrityViolation | ErrorCode::VerificationFailed
    ));

    // 恢复干净实现，重新完成洁净室校验并正式签发 VerificationMark 闭环
    fs::write(candidate_ws.join("calc.py"), valid_code)?;
    let completion =
        kernel.complete_commit_run(commit_run.run_id, Some(&real_dag), 1_795_400_005_700)?;
    assert_eq!(completion.final_status, RunStatus::Completed);
    assert_eq!(completion.verifier_runs, 2);
    let mark = completion
        .verification_mark
        .ok_or("通过洁净室验收后必须签发 VerificationMark")?;
    mark.verify_integrity()?;
    assert_eq!(mark.run_id, commit_run.run_id);
    assert_eq!(mark.candidate_tree_blake3, expected_tree_digest);
    assert_eq!(
        mark.verifier_suite_blake3,
        compute_workspace_tree_blake3(&locked_suite_dir)?
    );
    assert_eq!(mark.passed_test_count, 4);

    // 验证状态脊柱持久化：从 SpineEngine 重水合可完整还原已完成 Run 与其 VerificationMark
    let mut restored_runs = quetzalcoatl_kernel::RunStateMachine::new();
    let count = restored_runs.rehydrate_from_spine(kernel.spine())?;
    assert!(count >= 1);
    let rehydrated_run = restored_runs
        .get_run(commit_run.run_id)
        .ok_or("重水合后应能读取该 Commit Run")?;
    assert_eq!(rehydrated_run.status, RunStatus::Completed);
    assert_eq!(rehydrated_run.verification_mark.as_ref(), Some(&mark));

    // 完成闭环后允许回归 Explore 态并携带客观现实反馈
    let back_to_explore = kernel.return_commit_to_explore(
        commit_run.run_id,
        "洁净室 4 项断言通过，沉淀边界条件直觉",
        1_795_400_005_800,
    )?;
    assert_eq!(back_to_explore.mode, RunMode::Explore);
    assert_eq!(back_to_explore.status, RunStatus::Active);

    Ok(())
}

#[test]
fn heart_scheduler_two_process_sleep_circadian_inhibitors_emergency_bypass_and_seeded_thinning()
-> TestResult {
    // 1. 精确核对昼夜节律 C 公式：16:00 达峰值 1.0，04:00 达谷值 0.0
    let c_peak = HeartScheduler::circadian_process_c(16.0);
    let c_trough = HeartScheduler::circadian_process_c(4.0);
    assert!((c_peak - 1.0).abs() < 1e-12);
    assert!(c_trough.abs() < 1e-12);

    // 2. 清醒期 S 上升（tau_wake = 16h）+ 任务消耗抬升 -> 深夜 S - C > 0.35 入睡 -> 睡眠期衰减（tau_sleep = 4h）-> 晨间 S - C < -0.15 自然苏醒
    let mut heart = HeartScheduler::new(42, 0.15, SleepPhase::Awake);
    let s0 = heart.sleep_pressure_s();
    // 推进 15 小时（08:00 -> 23:00）
    let phase_23 = heart.advance_hours(15.0, 23.0);
    assert!(heart.sleep_pressure_s() > s0);
    // 叠加高强度任务消耗使困倦度越过 0.35
    let phase_after_exertion = heart.record_task_exertion(0.20, 23.5);
    let _ = phase_23;
    assert!(heart.sleepiness(23.5) > FALL_ASLEEP_THRESHOLD);
    assert_eq!(phase_after_exertion, SleepPhase::Asleep);

    // 深度睡眠期间：普通非紧急唤醒被抑制，但长辈看护紧急告警（bypass_sleep_inhibition = true）立即穿透唤醒！
    let normal_wake = heart.handle_wake_signal(1.0, false);
    assert!(matches!(normal_wake, WakeSignalResult::Suppressed { .. }));

    let mut emergency_clone = heart.clone();
    emergency_clone.set_inhibitors(HostInhibitors {
        paused: false,
        low_battery: true,
        overheating: false,
        budget_exhausted: false,
    });
    let emergency_wake = emergency_clone.handle_wake_signal(1.0, true);
    assert!(matches!(
        emergency_wake,
        WakeSignalResult::Woken {
            emergency_bypass: true,
            ..
        }
    ));
    assert_eq!(emergency_clone.phase(), SleepPhase::Awake);

    // 睡满 9 小时至次日 08:30：睡眠压力按 tau_sleep=4h 指数回落，S - C < -0.15 自然苏醒
    let morning_phase = heart.advance_hours(9.0, 8.5);
    assert!(heart.sleepiness(8.5) < NATURAL_WAKE_THRESHOLD);
    assert_eq!(morning_phase, SleepPhase::Awake);

    // 3. 抑制器（paused / budget_exhausted / overheating）阻断自发唤醒采样
    let mut paused_heart = HeartScheduler::new(99, 0.10, SleepPhase::Awake);
    paused_heart.set_inhibitors(HostInhibitors {
        paused: true,
        low_battery: false,
        overheating: false,
        budget_exhausted: false,
    });
    assert!(
        paused_heart
            .sample_next_wake_delay_hours(14.0, 12.0)
            .is_none()
    );

    // 4. 相同随机种子的非齐次泊松稀疏（Thinning）采样器严格确定性可复现，且高驱力期望唤醒间隔短于低驱力
    let mut h_a = HeartScheduler::new(20261124, 0.15, SleepPhase::Awake);
    let mut h_b = HeartScheduler::new(20261124, 0.15, SleepPhase::Awake);
    let d1 = h_a
        .sample_next_wake_delay_hours(15.0, 24.0)
        .ok_or("清醒活跃态应在窗口内采样出唤醒延迟")?;
    let d2 = h_b
        .sample_next_wake_delay_hours(15.0, 24.0)
        .ok_or("相同种子应采样出相同唤醒延迟")?;
    assert!((d1 - d2).abs() < 1e-15);
    assert!(d1 > 0.0 && d1 <= 24.0);

    let mut high_sum = 0.0;
    let mut low_sum = 0.0;
    for seed in 1..=32u64 {
        let mut hi = HeartScheduler::new(seed * 7919, 0.10, SleepPhase::Awake);
        hi.set_drives(EndogenousDrives {
            curiosity: 1.0,
            expression: 1.0,
            social: 1.0,
            commitments: 1.0,
        });
        let mut lo = HeartScheduler::new(seed * 7919, 0.10, SleepPhase::Awake);
        lo.set_drives(EndogenousDrives {
            curiosity: 0.05,
            expression: 0.05,
            social: 0.05,
            commitments: 0.05,
        });
        high_sum += hi.sample_next_wake_delay_hours(15.0, 48.0).unwrap_or(48.0);
        low_sum += lo.sample_next_wake_delay_hours(15.0, 48.0).unwrap_or(48.0);
    }
    assert!(
        high_sum < low_sum,
        "高内生驱力平均下次唤醒延迟 ({high_sum:.3}h) 必须显著短于低内生驱力 ({low_sum:.3}h)"
    );

    Ok(())
}

#[test]
fn cross_run_evolved_skill_isolation_dag_cycle_guard_and_full_kernel_rehydration() -> TestResult {
    let tmp = TempDirGuard::new("qz_rehydrate_iso")?;
    let mut kernel = build_test_kernel(&tmp, LeasePosture::PartitionLocal)?;

    let ws_a = tmp.path().join("ws_a");
    let ws_b = tmp.path().join("ws_b");
    fs::create_dir_all(ws_a.join("skills"))?;
    fs::create_dir_all(&ws_b)?;
    fs::write(ws_a.join("skills/a_only.sh"), "#!/bin/sh\necho A_ONLY\n")?;

    let run_a = kernel.spawn_explore_run("探索 A", Some(ws_a), 1_795_400_006_000)?;
    let run_b = kernel.spawn_commit_run("承诺 B", Some(ws_b), 1_795_400_006_100)?;

    let bindings = BTreeSet::from([
        String::from("sandbox.self_evolve"),
        String::from("world.public_dispatch"),
    ]);
    kernel.synthesize_evolved_skill(
        run_a.run_id,
        &CapabilitySet::All,
        &ScopeChain::unrestricted(),
        &bindings,
        EvolvedSkillSpec {
            skill_id: String::from("skill.a_only"),
            interface_id: String::from("sandbox.evolved"),
            relative_script_path: PathBuf::from("skills/a_only.sh"),
            interpreter: String::from("/bin/sh"),
            description: String::from("仅限 Run A 的沙箱脚本"),
        },
        1_795_400_006_200,
    )?;

    // 即使显式塞入 authored_bindings，Run B 也绝不可借用 Run A 的沙箱本地自演化技能
    let mut forged_bindings = bindings.clone();
    forged_bindings.insert(String::from("skill.a_only"));
    let cross_err = kernel
        .authorize_capability(
            PrincipalRole::Worker,
            Some(run_b.run_id),
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            forged_bindings,
            &CapabilityInvocation::new("skill.a_only", "[]"),
            1_795_400_006_300,
        )
        .err()
        .ok_or("跨 Run 调用沙箱自演化技能必须被 GrantEngine 拒绝")?;
    assert_eq!(cross_err.code(), ErrorCode::PermissionDenied);

    // 断网暂存一条 Outbox 后模拟重启/漂移重水合：断言 Outbox、动作账本与 Run 状态严格幂等恢复
    let _ = kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(run_b.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings,
        &CapabilityInvocation::new("world.public_dispatch", r#"{"pending":true}"#),
        1_795_400_006_400,
    );
    assert_eq!(kernel.ledger().outbox().len(), 1);
    let expected_records_len = kernel.ledger().records().len();
    let expected_run_b = kernel
        .runs()
        .get_run(run_b.run_id)
        .cloned()
        .ok_or("缺少 run_b")?;

    let _ = kernel.rehydrate_from_spine()?;
    let _ = kernel.rehydrate_from_spine()?;
    assert_eq!(kernel.ledger().outbox().len(), 1);
    assert_eq!(kernel.ledger().records().len(), expected_records_len);
    assert_eq!(kernel.runs().get_run(run_b.run_id), Some(&expected_run_b));

    // DAG 环检测门禁
    let suite_dir = tmp.path().join("suite");
    fs::create_dir_all(&suite_dir)?;
    let cycle_err = CleanRoomVerifierDag::new(vec![
        VerifierNode {
            node_id: String::from("n1"),
            depends_on: vec![String::from("n2")],
            verifier_suite_dir: suite_dir.clone(),
            command: SandboxCommand::shell("true"),
            expected_suite_blake3: None,
        },
        VerifierNode {
            node_id: String::from("n2"),
            depends_on: vec![String::from("n1")],
            verifier_suite_dir: suite_dir,
            command: SandboxCommand::shell("true"),
            expected_suite_blake3: None,
        },
    ])
    .err()
    .ok_or("有环 DAG 必须被拒绝")?;
    assert_eq!(cycle_err.code(), ErrorCode::VerificationFailed);

    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn regression_round1_finding1_partition_outbox_enforces_clean_room_verifier_and_reconciles_completed_marked_runs()
-> TestResult {
    let tmp = TempDirGuard::new("qz_r1_f1_outbox_verify")?;
    let mut kernel = build_test_kernel(&tmp, LeasePosture::PartitionLocal)?;

    let ws_ok = tmp.path().join("ws_verified");
    let ws_aborted = tmp.path().join("ws_aborted");
    let suite_dir = tmp.path().join("locked_suite");
    fs::create_dir_all(&ws_ok)?;
    fs::create_dir_all(&ws_aborted)?;
    fs::create_dir_all(&suite_dir)?;
    fs::write(ws_ok.join("payload.txt"), "APPROVED_ARTIFACT\n")?;
    fs::write(ws_aborted.join("payload.txt"), "ABORTED_ARTIFACT\n")?;
    fs::write(
        suite_dir.join("verify.sh"),
        "#!/bin/sh\ntest -f \"$QUETZALCOATL_CANDIDATE_WORKSPACE/payload.txt\"\necho 'test result: ok. 2 passed; 0 failed; 0 ignored;'\n",
    )?;

    let dag = CleanRoomVerifierDag::single(
        "offline_clean_room",
        suite_dir.clone(),
        SandboxCommand::new(
            "/bin/sh",
            vec![suite_dir.join("verify.sh").to_string_lossy().into_owned()],
        ),
    );

    let run_ok = kernel.spawn_commit_run("离线高危外发待验任务", Some(ws_ok), 1_795_400_010_000)?;
    let run_aborted =
        kernel.spawn_commit_run("离线高危中途放弃任务", Some(ws_aborted), 1_795_400_010_050)?;

    // 先让 run_ok 进入 VerifiedPendingMark，再在 PartitionLocal 下触发 HighRiskExternalWrite：
    // 必须记录 touched_sinks 并将 VerifiedPendingMark 退回 Active！
    let pre_receipt = kernel.verify_commit_candidate(run_ok.run_id, &dag, 1_795_400_010_100)?;
    assert_eq!(
        kernel.runs().get_run(run_ok.run_id).map(|r| r.status),
        Some(RunStatus::VerifiedPendingMark)
    );

    let bindings = BTreeSet::from([String::from("world.public_dispatch")]);
    let mut call_ok =
        CapabilityInvocation::new("world.public_dispatch", r#"{"target":"partner_a"}"#);
    call_ok.idempotency_key = Some(String::from("idem-r1-ok"));

    let part_err_1 = kernel
        .authorize_capability(
            PrincipalRole::Worker,
            Some(run_ok.run_id),
            CapabilitySet::All,
            ScopeChain::unrestricted(),
            bindings.clone(),
            &call_ok,
            1_795_400_010_200,
        )
        .err()
        .ok_or("断网分区下必须暂存 Outbox 并返回 PartitionRestricted")?;
    assert_eq!(part_err_1.code(), ErrorCode::PartitionRestricted);

    // 1a. 离线入队高危动作后，VerifiedPendingMark 必须已降级回 Active（旧 pre_receipt 失效）且严禁免检结项！
    let after_queue = kernel.runs().get_run(run_ok.run_id).ok_or("缺少 run_ok")?;
    assert_eq!(after_queue.status, RunStatus::Active);
    assert!(after_queue.requires_clean_room_verifier());

    let stale_finalize_err = kernel
        .finalize_commit_with_receipt(&pre_receipt, 1_795_400_010_250)
        .err()
        .ok_or("入队新外部写后旧候选收据必须失效")?;
    assert_eq!(stale_finalize_err.code(), ErrorCode::VerificationFailed);

    let bypass_err = kernel
        .complete_commit_run_without_verifier(run_ok.run_id, 1_795_400_010_300)
        .err()
        .ok_or("存在断网暂存高危动作的 Commit Run 严禁免检直接结项")?;
    assert_eq!(bypass_err.code(), ErrorCode::VerificationFailed);

    // 1b. run_aborted 也在离线时暂存一条高危动作，随后被中止 Aborted
    let mut call_aborted =
        CapabilityInvocation::new("world.public_dispatch", r#"{"target":"partner_abort"}"#);
    call_aborted.idempotency_key = Some(String::from("idem-r1-abort"));
    let _ = kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(run_aborted.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings,
        &call_aborted,
        1_795_400_010_350,
    );
    let aborted_rec = kernel.abort_run(run_aborted.run_id, "用户取消任务", 1_795_400_010_400)?;
    assert_eq!(aborted_rec.status, RunStatus::Aborted);

    // 1c. 离线状态下，run_ok 通过断网洁净室 DAG 完成验收并签发 VerificationMark 进入 Completed
    let completion = kernel.complete_commit_run(run_ok.run_id, Some(&dag), 1_795_400_010_500)?;
    assert_eq!(completion.final_status, RunStatus::Completed);
    assert!(completion.verification_mark.is_some());

    // 1d. 恢复联网 Witnessed 纪元后排空 Outbox 并逐条对账签发写前幂等锁：
    //     已通过洁净室签发 Mark 的 Completed Run 允许签发幂等令牌（重复提交自动幂等去重）；
    //     已 Aborted 的 Run 条目必须被硬拒绝！
    let witness_ep = Epoch::new(5);
    kernel.set_lease_posture(LeasePosture::Witnessed {
        witness_epoch: witness_ep,
    });
    let drained = kernel.drain_reconciled_outbox(witness_ep)?;
    assert_eq!(drained.len(), 2);

    let first_disp =
        kernel.commit_reconciled_outbox_item(&drained[0], witness_ep, 1_795_400_010_600)?;
    assert!(matches!(
        first_disp,
        ExternalWriteDisposition::PermittedNew { .. }
    ));
    let dup_disp =
        kernel.commit_reconciled_outbox_item(&drained[0], witness_ep, 1_795_400_010_650)?;
    assert!(matches!(
        dup_disp,
        ExternalWriteDisposition::DuplicateSuppressed { .. }
    ));

    let aborted_err = kernel
        .commit_reconciled_outbox_item(&drained[1], witness_ep, 1_795_400_010_700)
        .err()
        .ok_or("已中止 Aborted Run 的暂存外发项必须被拒绝")?;
    assert_eq!(aborted_err.code(), ErrorCode::VerificationFailed);

    Ok(())
}

#[test]
fn regression_round1_finding2_no_unpersisted_hlc_drift_and_rehydrate_resets_evolved_registry_and_checks_schema()
-> TestResult {
    let tmp = TempDirGuard::new("qz_r1_f2_hlc_rehydrate")?;
    let mut kernel = build_test_kernel(
        &tmp,
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    )?;

    let ws = tmp.path().join("ws_drift");
    fs::create_dir_all(ws.join("skills"))?;
    fs::write(
        ws.join("skills/ephemeral.sh"),
        "#!/bin/sh\necho EPHEMERAL\n",
    )?;

    let run = kernel.spawn_commit_run(
        "检查 HLC 无漂移与重水合清理",
        Some(ws.clone()),
        1_795_400_020_000,
    )?;
    let bindings = BTreeSet::from([String::from("fs.local_read")]);

    // 第一次调用 fs.local_read 会将 LocalRead 插入 touched_sinks 并持久化 RunRecord
    kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings.clone(),
        &CapabilityInvocation::new("fs.local_read", r#"{"n":1}"#),
        1_795_400_020_100,
    )?;

    // 第二次重复调用同一汇点（sink_inserted == false）：内存中的 RunRecord.updated_hlc 严禁产生未落盘漂移！
    kernel.authorize_capability(
        PrincipalRole::Worker,
        Some(run.run_id),
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        bindings,
        &CapabilityInvocation::new("fs.local_read", r#"{"n":2}"#),
        1_795_400_020_200,
    )?;

    let in_mem_before = kernel
        .runs()
        .get_run(run.run_id)
        .cloned()
        .ok_or("缺少内存 RunRecord")?;
    let mat_runs = kernel.spine().store().list_runs()?;
    let mat_run = mat_runs
        .iter()
        .find(|r| r.run_id == run.run_id)
        .ok_or("缺少 SQLite 物化 Run")?;
    assert_eq!(
        in_mem_before.updated_hlc, mat_run.updated_hlc,
        "内存 RunRecord.updated_hlc 必须与 SQLite 物化表严格一致，禁止未落盘内存自增"
    );

    // 向脊柱追加一条异构 schema 的伪事件，并向注册表注入一条未持久化的陈旧自演化技能；
    // 执行 rehydrate_from_spine 后：伪 schema 事件必须被忽略，未持久化的陈旧自演化技能必须被清空，而宿主固定能力保留！
    let foreign_schema_json = serde_json::json!({
        "schema": "other.subsystem.v99",
        "event": {
            "kind": "skill_synthesized",
            "skill": {
                "skill_id": "skill.foreign_injected",
                "run_id": run.run_id,
                "relative_script_path": "skills/ephemeral.sh",
                "interpreter": "/bin/sh",
                "description": "foreign schema",
                "script_blake3": "0000000000000000000000000000000000000000000000000000000000000000"
            }
        }
    })
    .to_string();
    kernel.spine_mut().append_event(
        quetzalcoatl_crypto::PackCompartment::Core,
        &foreign_schema_json,
        1_795_400_020_300,
    )?;

    // 向内存注册表直接插入一条未落盘的陈旧自演化技能，并向脊柱写入一条异构 schema 的伪事件：
    // 执行 rehydrate_from_spine 后，未落盘自演化技能必须被清空、异构 schema 事件必须被忽略、宿主固定能力完整保留！
    kernel.registry_mut().register_evolved_skill(
        run.run_id,
        &ws,
        EvolvedSkillSpec {
            skill_id: String::from("skill.unpersisted_stale"),
            interface_id: String::from("sandbox.evolved"),
            relative_script_path: PathBuf::from("skills/ephemeral.sh"),
            interpreter: String::from("/bin/sh"),
            description: String::from("未持久化至脊柱的内存残留技能"),
        },
    )?;
    assert!(
        kernel
            .registry()
            .get_capability("skill.unpersisted_stale")
            .is_some()
    );

    let _ = kernel.rehydrate_from_spine()?;
    assert!(
        kernel
            .registry()
            .get_capability("skill.unpersisted_stale")
            .is_none(),
        "rehydrate_from_spine 必须先清空内存中旧的 SandboxEvolved 条目再从脊柱回放"
    );
    assert!(
        kernel
            .registry()
            .get_capability("skill.foreign_injected")
            .is_none(),
        "rehydrate_from_spine 必须严格校验 schema == quetzalcoatl.kernel.v1"
    );
    assert!(
        kernel.registry().get_capability("fs.local_read").is_some(),
        "rehydrate_from_spine 必须完整保留宿主注册能力"
    );
    assert_eq!(kernel.runs().get_run(run.run_id), Some(&in_mem_before));

    Ok(())
}

#[test]
fn regression_round1_finding3_register_evolved_skill_blocks_cross_run_clobber_while_allowing_same_run_refinement()
-> TestResult {
    let tmp = TempDirGuard::new("qz_r1_f3_skill_clobber")?;
    let mut kernel = build_test_kernel(
        &tmp,
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    )?;

    let ws_a = tmp.path().join("ws_run_a");
    let ws_b = tmp.path().join("ws_run_b");
    fs::create_dir_all(ws_a.join("skills"))?;
    fs::create_dir_all(ws_b.join("skills"))?;
    fs::write(
        ws_a.join("skills/shared_name.sh"),
        "#!/bin/sh\necho RUN_A_V1\n",
    )?;
    fs::write(
        ws_b.join("skills/shared_name.sh"),
        "#!/bin/sh\necho RUN_B_HIJACK\n",
    )?;

    let run_a = kernel.spawn_explore_run("探索 Run A", Some(ws_a.clone()), 1_795_400_030_000)?;
    let run_b = kernel.spawn_explore_run("探索 Run B", Some(ws_b), 1_795_400_030_100)?;
    let bindings = BTreeSet::from([String::from("sandbox.self_evolve")]);

    let v1 = kernel.synthesize_evolved_skill(
        run_a.run_id,
        &CapabilitySet::All,
        &ScopeChain::unrestricted(),
        &bindings,
        EvolvedSkillSpec {
            skill_id: String::from("skill.shared_name"),
            interface_id: String::from("sandbox.evolved"),
            relative_script_path: PathBuf::from("skills/shared_name.sh"),
            interpreter: String::from("/bin/sh"),
            description: String::from("Run A 初版技能"),
        },
        1_795_400_030_200,
    )?;
    assert_eq!(v1.run_id, run_a.run_id);

    // Run B 企图注册同名 skill.shared_name 覆盖窃取 Run A 的技能槽位 -> 必须被拒绝 PermissionDenied！
    let clobber_err = kernel
        .synthesize_evolved_skill(
            run_b.run_id,
            &CapabilitySet::All,
            &ScopeChain::unrestricted(),
            &bindings,
            EvolvedSkillSpec {
                skill_id: String::from("skill.shared_name"),
                interface_id: String::from("sandbox.evolved"),
                relative_script_path: PathBuf::from("skills/shared_name.sh"),
                interpreter: String::from("/bin/sh"),
                description: String::from("Run B 恶意同名覆盖"),
            },
            1_795_400_030_300,
        )
        .err()
        .ok_or("禁止不同 Run 覆盖同名自演化技能")?;
    assert_eq!(clobber_err.code(), ErrorCode::PermissionDenied);

    // 确认注册表中仍归属 Run A 未被篡改
    let preserved = kernel
        .registry()
        .get_evolved_skill("skill.shared_name")
        .ok_or("Run A 技能不应丢失")?;
    assert_eq!(preserved.run_id, run_a.run_id);
    assert_eq!(preserved.script_blake3, v1.script_blake3);

    // 同一 Run A 迭代修改自身脚本后允许原地重合成更新哈希！
    fs::write(
        ws_a.join("skills/shared_name.sh"),
        "#!/bin/sh\necho RUN_A_V2\n",
    )?;
    let v2 = kernel.synthesize_evolved_skill(
        run_a.run_id,
        &CapabilitySet::All,
        &ScopeChain::unrestricted(),
        &bindings,
        EvolvedSkillSpec {
            skill_id: String::from("skill.shared_name"),
            interface_id: String::from("sandbox.evolved"),
            relative_script_path: PathBuf::from("skills/shared_name.sh"),
            interpreter: String::from("/bin/sh"),
            description: String::from("Run A 迭代升级版技能"),
        },
        1_795_400_030_400,
    )?;
    assert_eq!(v2.run_id, run_a.run_id);
    assert_ne!(v2.script_blake3, v1.script_blake3);

    Ok(())
}
