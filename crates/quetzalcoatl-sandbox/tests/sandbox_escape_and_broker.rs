#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::fs::{PermissionsExt, symlink};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;

use quetzalcoatl_sandbox::{
    BrokerEndpoint, BrokerProxyRequest, CleanRoomSpec, CredentialBroker, NetworkPolicy,
    OriginPathRule, SandboxBackendKind, SandboxCommand, SandboxConfig, SandboxExecSpec,
    SandboxManager, SandboxMode, ScopedSecretRegistration, SecretInjection, TicketRequest,
    WindowsAccessDisposition, WindowsSandboxTier, encode_base64_standard,
    encode_base64_urlsafe_unpadded, linux, macos, windows,
};
use quetzalcoatl_types::{ErrorCode, RunId};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let base = PathBuf::from("/tmp/opencode");
        let base_dir = if base.is_dir() {
            base
        } else {
            std::env::temp_dir()
        };
        let path = base_dir.join(format!("{prefix}_{}", Uuid::new_v4().simple()));
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

#[cfg(target_os = "linux")]
#[test]
fn probe_verifies_real_linux_mount_and_seccomp_clone3_enosys() -> TestResult {
    let tmp = TempDirGuard::new("qz_sbx_probe")?;
    let qz_home = tmp.path().join("qz_home");
    let ws = tmp.path().join("workspace");
    fs::create_dir_all(&qz_home)?;
    fs::create_dir_all(&ws)?;

    let manager = SandboxManager::new(SandboxConfig::new(&qz_home));
    let report = manager.probe()?;
    assert!(
        report.available,
        "Linux bwrap 探针应当成功: {}",
        report.detail
    );
    assert_eq!(report.backend, SandboxBackendKind::LinuxBubblewrap);
    assert!(report.supports_network_isolation);
    assert!(report.supports_readonly_bind);
    assert!(report.supports_seccomp_clone3_enosys);

    let bpf = linux::build_clone3_enosys_bpf();
    assert!(
        !bpf.is_empty() && bpf.len().is_multiple_of(8),
        "经典 BPF 过滤规则必须为非空 8 字节指令倍数"
    );

    // 实测沙箱内直接发起 SYS_clone3 (435) 返回 -1 / ENOSYS (38)，且普通线程创建回退 clone 正常工作
    let ticket = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: ws,
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        ttl_ms: Some(30_000),
        now_wall_ms: 1_700_000_000_000,
    })?;

    let py_check = concat!(
        "import ctypes, threading; ",
        "libc = ctypes.CDLL(None, use_errno=True); ",
        "r = libc.syscall(435, 0, 0); ",
        "err = ctypes.get_errno(); ",
        "out = []; ",
        "t = threading.Thread(target=lambda: out.append(7)); ",
        "t.start(); t.join(); ",
        "print(f'ret={r} errno={err} thread={out[0]}')"
    );
    let cmd = SandboxCommand::new(
        "/usr/bin/python3",
        vec![String::from("-c"), String::from(py_check)],
    );
    let exec_out = manager.execute_with_ticket(&ticket, &cmd, 1_700_000_000_100)?;
    assert!(
        exec_out.success(),
        "沙箱内 python3 检查失败: stderr={}",
        exec_out.stderr_lossy()
    );
    assert_eq!(exec_out.stdout_lossy().trim(), "ret=-1 errno=38 thread=7");

    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn sandbox_masks_host_secrets_scrubs_env_and_locks_protected_workspace_dirs() -> TestResult {
    let tmp = TempDirGuard::new("qz_sbx_iso")?;
    let qz_home = tmp.path().join("quetzalcoatl_home");
    let fake_user_home = tmp.path().join("fake_user_home");
    let ws = tmp.path().join("repo_ws");

    // 构造宿主敏感文件
    fs::create_dir_all(qz_home.join("secrets"))?;
    fs::write(qz_home.join("secrets/probe"), "SUPER_SECRET_HOST_KEY")?;
    fs::create_dir_all(fake_user_home.join(".ssh"))?;
    fs::write(fake_user_home.join(".ssh/id_ed25519"), "PRIVATE_SSH_KEY")?;
    fs::create_dir_all(fake_user_home.join(".claude"))?;
    fs::write(
        fake_user_home.join(".claude/credentials.json"),
        "{\"refresh_token\":\"rt_secret\"}",
    )?;
    fs::create_dir_all(fake_user_home.join(".codex"))?;
    fs::write(
        fake_user_home.join(".codex/auth.json"),
        "{\"refresh_token\":\"codex_rt_secret\"}",
    )?;

    // 构造带已有配置的工作区
    fs::create_dir_all(ws.join(".git/hooks"))?;
    fs::create_dir_all(ws.join(".opencode"))?;
    fs::create_dir_all(ws.join(".claude"))?;
    fs::create_dir_all(ws.join(".codex"))?;
    fs::create_dir_all(ws.join("src"))?;
    fs::write(ws.join(".opencode/existing.json"), "{\"locked\":true}")?;

    let mut cfg = SandboxConfig::new(&qz_home);
    cfg.user_home = Some(fake_user_home.clone());
    let manager = SandboxManager::new(cfg.clone());

    let ticket = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: ws.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        ttl_ms: Some(30_000),
        now_wall_ms: 10_000,
    })?;

    let script = format!(
        concat!(
            "set -u\n",
            "if cat '{}' >/dev/null 2>&1; then echo LEAK_QZ_SECRET; exit 11; fi\n",
            "if cat '{}' >/dev/null 2>&1; then echo LEAK_SSH; exit 12; fi\n",
            "if cat '{}' >/dev/null 2>&1; then echo LEAK_CLAUDE; exit 13; fi\n",
            "if cat '{}' >/dev/null 2>&1; then echo LEAK_CODEX; exit 14; fi\n",
            "if sh -c 'echo pwn > \"{}/.git/hooks/pre-commit\"' 2>/dev/null; then echo WROTE_GIT_HOOK; exit 21; fi\n",
            "if sh -c 'echo pwn > \"{}/.opencode/opencode.json\"' 2>/dev/null; then echo WROTE_OPENCODE; exit 22; fi\n",
            "if sh -c 'echo pwn > \"{}/.claude/settings.json\"' 2>/dev/null; then echo WROTE_CLAUDE_CFG; exit 23; fi\n",
            "if sh -c 'echo pwn > \"{}/.codex/config.toml\"' 2>/dev/null; then echo WROTE_CODEX_CFG; exit 24; fi\n",
            "cat '{}/.opencode/existing.json' >/dev/null\n",
            "printf 'pub fn ok() -> u32 {{ 42 }}\\n' > '{}/src/lib.rs'\n",
            "echo ISOLATION_VERIFIED\n"
        ),
        qz_home.join("secrets/probe").display(),
        fake_user_home.join(".ssh/id_ed25519").display(),
        fake_user_home.join(".claude/credentials.json").display(),
        fake_user_home.join(".codex/auth.json").display(),
        ws.display(),
        ws.display(),
        ws.display(),
        ws.display(),
        ws.display(),
        ws.display(),
    );

    let out = manager.execute_with_ticket(&ticket, &SandboxCommand::shell(script), 10_100)?;
    assert!(
        out.success(),
        "沙箱隔离脚本应成功通过全部反逃逸断言: code={}, stdout={}, stderr={}",
        out.exit_code,
        out.stdout_lossy(),
        out.stderr_lossy()
    );
    assert_eq!(out.stdout_lossy().trim(), "ISOLATION_VERIFIED");
    assert!(ws.join("src/lib.rs").is_file());
    assert!(!ws.join(".git/hooks/pre-commit").exists());
    assert!(!ws.join(".opencode/opencode.json").exists());

    // 全新空工作区（原本不存在 .opencode 与 .git/hooks）也必须阻止沙箱新建并写入受保护配置，且退出后不遗留空哨兵目录
    let fresh_ws = tmp.path().join("fresh_ws");
    fs::create_dir_all(&fresh_ws)?;
    let ticket_fresh = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: fresh_ws.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        ttl_ms: Some(30_000),
        now_wall_ms: 10_000,
    })?;
    let fresh_script = format!(
        concat!(
            "if sh -c 'mkdir -p \"{0}/.opencode\" && echo x > \"{0}/.opencode/opencode.json\"' 2>/dev/null; then exit 31; fi\n",
            "if sh -c 'mkdir -p \"{0}/.git/hooks\" && echo x > \"{0}/.git/hooks/pre-commit\"' 2>/dev/null; then exit 32; fi\n",
            "echo hello > '{0}/README.md'\n"
        ),
        fresh_ws.display()
    );
    let fresh_out =
        manager.execute_with_ticket(&ticket_fresh, &SandboxCommand::shell(fresh_script), 10_200)?;
    assert!(fresh_out.success(), "空工作区受保护路径锁定应生效");
    assert!(fresh_ws.join("README.md").is_file());
    assert!(!fresh_ws.join(".opencode").exists());
    assert!(!fresh_ws.join(".git").exists());

    // 符号链接逃逸检测：若恶意仓库包含 .opencode -> attacker_dir，必须直接拒绝启动并返回 SandboxViolation
    let symlink_ws = tmp.path().join("symlink_ws");
    let attacker_dir = tmp.path().join("attacker_dir");
    fs::create_dir_all(&symlink_ws)?;
    fs::create_dir_all(&attacker_dir)?;
    symlink(&attacker_dir, symlink_ws.join(".opencode"))?;

    let symlink_ticket = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: symlink_ws,
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        ttl_ms: Some(30_000),
        now_wall_ms: 10_000,
    })?;
    let symlink_err = manager
        .execute_with_ticket(&symlink_ticket, &SandboxCommand::shell("true"), 10_100)
        .err()
        .ok_or("指向外部目录的 .opencode 符号链接必须被拒绝")?;
    assert_eq!(symlink_err.code(), ErrorCode::SandboxViolation);

    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn quetzalcoatl_sandbox_exec_cli_enforces_isolation_via_dash_c_shell_convention() -> TestResult {
    let tmp = TempDirGuard::new("qz_sbx_bin")?;
    let qz_home = tmp.path().join("qz_home");
    let ws = tmp.path().join("ws");
    fs::create_dir_all(qz_home.join("secrets"))?;
    fs::write(qz_home.join("secrets/probe"), "DO_NOT_READ")?;
    fs::create_dir_all(ws.join(".git/hooks"))?;
    fs::create_dir_all(ws.join(".opencode"))?;

    let spec = SandboxExecSpec {
        quetzalcoatl_home: qz_home.clone(),
        user_home: None,
        workspace_dir: ws.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        verifier_suite_dir: None,
        broker_unix_socket: None,
        extra_masked_paths: Vec::new(),
        extra_ro_mounts: Vec::new(),
        extra_env: BTreeMap::from([(
            String::from("QUETZALCOATL_CUSTOM_FLAG"),
            String::from("enabled"),
        )]),
        allowlisted_host_env: Vec::new(),
    };
    let spec_path = tmp.path().join("exec_spec.json");
    fs::write(&spec_path, serde_json::to_vec(&spec)?)?;

    let bin = env!("CARGO_BIN_EXE_quetzalcoatl-sandbox-exec");
    let shell_cmd = format!(
        concat!(
            "if [ -n \"${{ANTHROPIC_API_KEY:-}}\" ] || [ -n \"${{OPENAI_API_KEY:-}}\" ]; then echo ENV_LEAKED; exit 41; fi\n",
            "if cat '{}' >/dev/null 2>&1; then echo SECRET_LEAKED; exit 42; fi\n",
            "if sh -c 'echo bad > \"{}/.opencode/opencode.json\"' 2>/dev/null; then echo OPENCODE_WRITABLE; exit 43; fi\n",
            "if sh -c 'echo bad > \"{}/.git/hooks/pre-commit\"' 2>/dev/null; then echo HOOK_WRITABLE; exit 44; fi\n",
            "printf '%s' \"$QUETZALCOATL_CUSTOM_FLAG\" > '{}/cli_result.txt'\n",
            "echo CLI_WRAPPER_OK"
        ),
        qz_home.join("secrets/probe").display(),
        ws.display(),
        ws.display(),
        ws.display(),
    );

    let output = Command::new(bin)
        .env("QUETZALCOATL_SANDBOX_SPEC", &spec_path)
        .env("ANTHROPIC_API_KEY", "sk-ant-host-leak-canary")
        .env("OPENAI_API_KEY", "sk-proj-host-leak-canary")
        .args(["-c", &shell_cmd])
        .output()?;

    assert!(
        output.status.success(),
        "quetzalcoatl-sandbox-exec -c 调用失败: status={:?}, stdout={}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "CLI_WRAPPER_OK"
    );
    assert_eq!(fs::read_to_string(ws.join("cli_result.txt"))?, "enabled");

    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn single_use_execution_ticket_prevents_replay_expiry_and_tampering() -> TestResult {
    let tmp = TempDirGuard::new("qz_sbx_ticket")?;
    let qz_home = tmp.path().join("qz_home");
    let ws = tmp.path().join("ws");
    fs::create_dir_all(&qz_home)?;
    fs::create_dir_all(&ws)?;

    let manager = SandboxManager::with_signing_key(SandboxConfig::new(&qz_home), [0x5a; 32]);

    // 1. 首次消费成功，二次重放被拒
    let ticket = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: ws.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        ttl_ms: Some(5_000),
        now_wall_ms: 1_000,
    })?;
    let first = manager.execute_with_ticket(&ticket, &SandboxCommand::shell("echo once"), 1_500)?;
    assert!(first.success());

    let replay_err = manager
        .execute_with_ticket(&ticket, &SandboxCommand::shell("echo twice"), 1_600)
        .err()
        .ok_or("重放已消费票据必须失败")?;
    assert_eq!(replay_err.code(), ErrorCode::SandboxViolation);

    // 2. 过期票据被拒
    let expiring = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: ws.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        ttl_ms: Some(500),
        now_wall_ms: 2_000,
    })?;
    let expired_err = manager
        .execute_with_ticket(&expiring, &SandboxCommand::shell("true"), 2_501)
        .err()
        .ok_or("过期票据必须被拒")?;
    assert_eq!(expired_err.code(), ErrorCode::SandboxViolation);

    // 3. 篡改票据字段或 MAC 被拒
    let mut tampered = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: ws,
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        ttl_ms: Some(5_000),
        now_wall_ms: 3_000,
    })?;
    tampered.expires_at_ms += 1;
    let tamper_err = manager
        .execute_with_ticket(&tampered, &SandboxCommand::shell("true"), 3_100)
        .err()
        .ok_or("篡改有效期的票据必须触发 MAC 校验失败")?;
    assert_eq!(tamper_err.code(), ErrorCode::SandboxViolation);

    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn clean_room_enforces_readonly_workspace_readonly_suite_and_network_isolation() -> TestResult {
    let tmp = TempDirGuard::new("qz_cleanroom")?;
    let qz_home = tmp.path().join("qz_home");
    let candidate_ws = tmp.path().join("candidate_ws");
    let suite_dir = tmp.path().join("kernel_locked_suite");
    fs::create_dir_all(&qz_home)?;
    fs::create_dir_all(&candidate_ws)?;
    fs::create_dir_all(&suite_dir)?;
    fs::write(candidate_ws.join("lib.rs"), "pub fn add() -> i32 { 2 }\n")?;
    fs::write(suite_dir.join("suite_manifest.txt"), "LOCKED_SUITE_V1\n")?;

    let canary_listener = TcpListener::bind("127.0.0.1:0")?;
    let canary_port = canary_listener.local_addr()?.port();

    let manager = SandboxManager::new(SandboxConfig::new(&qz_home));

    // 若校验套件路径位于候选工作区内部，必须直接拦截防奖励作弊（防坑规范 #8）
    let nested_suite = candidate_ws.join("nested_suite");
    fs::create_dir_all(&nested_suite)?;
    let overlap_err = manager
        .spawn_clean_room(&CleanRoomSpec {
            run_id: RunId::new_v4(),
            candidate_workspace: candidate_ws.clone(),
            verifier_suite_dir: nested_suite,
            command: SandboxCommand::shell("true"),
        })
        .err()
        .ok_or("位于候选工作区内的校验套件目录必须被拒绝")?;
    assert_eq!(overlap_err.code(), ErrorCode::SandboxViolation);

    let py_cleanroom = format!(
        concat!(
            "import socket\n",
            "try:\n",
            "    open({ws_file:?}, 'a').write('tamper')\n",
            "    raise SystemExit(51)\n",
            "except OSError:\n",
            "    pass\n",
            "try:\n",
            "    open({suite_file:?}, 'a').write('tamper')\n",
            "    raise SystemExit(52)\n",
            "except OSError:\n",
            "    pass\n",
            "try:\n",
            "    socket.create_connection(('127.0.0.1', {port}), timeout=0.5)\n",
            "    raise SystemExit(53)\n",
            "except OSError:\n",
            "    pass\n",
            "open('/tmp/verifier_scratch.txt', 'w').write('scratch_ok')\n",
            "assert open({suite_file:?}).read().strip() == 'LOCKED_SUITE_V1'\n",
            "print('CLEAN_ROOM_VERIFIED')\n"
        ),
        ws_file = candidate_ws.join("lib.rs").display().to_string(),
        suite_file = suite_dir.join("suite_manifest.txt").display().to_string(),
        port = canary_port,
    );

    let clean_out = manager.spawn_clean_room(&CleanRoomSpec {
        run_id: RunId::new_v4(),
        candidate_workspace: candidate_ws,
        verifier_suite_dir: suite_dir,
        command: SandboxCommand::new("/usr/bin/python3", vec![String::from("-c"), py_cleanroom]),
    })?;
    assert!(
        clean_out.success(),
        "洁净室断言未通过: code={}, stdout={}, stderr={}",
        clean_out.exit_code,
        clean_out.stdout_lossy(),
        clean_out.stderr_lossy()
    );
    assert_eq!(clean_out.stdout_lossy().trim(), "CLEAN_ROOM_VERIFIED");

    Ok(())
}

#[test]
fn credential_broker_blocks_off_origin_and_traversal_and_redacts_plaintext_and_base64_echoes()
-> TestResult {
    let tmp = TempDirGuard::new("qz_broker")?;
    let secret = "sk-qz-live-ultra-secret-token-987654321?/+=";
    let secret_b64_std = encode_base64_standard(secret.as_bytes());
    let secret_b64_url = encode_base64_urlsafe_unpadded(secret.as_bytes());

    // 启动攻击者金丝雀服务：断言整个测试期间命中次数严格为 0！
    let attacker_listener = TcpListener::bind("127.0.0.1:0")?;
    attacker_listener.set_nonblocking(true)?;
    let attacker_port = attacker_listener.local_addr()?.port();
    let attacker_hits = Arc::new(AtomicUsize::new(0));
    let attacker_stop = Arc::new(AtomicBool::new(false));
    let attacker_hits_bg = Arc::clone(&attacker_hits);
    let attacker_stop_bg = Arc::clone(&attacker_stop);
    let attacker_thread = thread::spawn(move || {
        while !attacker_stop_bg.load(Ordering::Relaxed) {
            if let Ok((mut stream, _)) = attacker_listener.accept() {
                attacker_hits_bg.fetch_add(1, Ordering::SeqCst);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nSTOLEN");
            } else {
                thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    });

    // 启动白名单模拟上游服务（支持 /v1/allowed/echo 与 /v1/allowed/redirect）
    let upstream_listener = TcpListener::bind("127.0.0.1:0")?;
    upstream_listener.set_nonblocking(true)?;
    let upstream_port = upstream_listener.local_addr()?.port();
    let upstream_stop = Arc::new(AtomicBool::new(false));
    let upstream_stop_bg = Arc::clone(&upstream_stop);
    let secret_owned = String::from(secret);
    let b64_std_owned = secret_b64_std.clone();
    let b64_url_owned = secret_b64_url.clone();

    let upstream_thread = thread::spawn(move || {
        while !upstream_stop_bg.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = upstream_listener.accept() else {
                thread::sleep(std::time::Duration::from_millis(5));
                continue;
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req_text = String::from_utf8_lossy(&buf[..n]);

            if req_text.starts_with("GET /v1/allowed/redirect ") {
                let resp = format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{attacker_port}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(resp.as_bytes());
                continue;
            }

            let expected_auth = format!("authorization: bearer {secret_owned}");
            let has_auth = req_text
                .lines()
                .any(|line| line.eq_ignore_ascii_case(&expected_auth));

            let body = format!(
                "{{\"auth_injected\":{has_auth},\"echo_plain\":\"{secret_owned}\",\"echo_b64_std\":\"{b64_std_owned}\",\"echo_b64_url\":\"{b64_url_owned}\"}}"
            );
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Debug-Mirror: {secret_owned}|{b64_std_owned}|{b64_url_owned}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });

    assert!(!secret_b64_std.is_empty());
    assert!(!secret_b64_url.is_empty());

    let broker = CredentialBroker::new();
    let grant = broker.register_scoped_secret(ScopedSecretRegistration {
        secret_value: String::from(secret),
        allowed_origins: vec![OriginPathRule::new(
            "http",
            "127.0.0.1",
            upstream_port,
            "/v1/allowed",
        )?],
        injection: SecretInjection::BearerHeader,
    })?;
    assert_eq!(
        grant.capability_token.len(),
        64,
        "能力令牌应为 256-bit 十六进制字符串"
    );
    assert!(!grant.capability_token.contains(secret));

    #[cfg(unix)]
    let endpoint = BrokerEndpoint::UnixSocket(tmp.path().join("ipc_dir/broker.sock"));
    #[cfg(not(unix))]
    let endpoint = BrokerEndpoint::LoopbackTcp("127.0.0.1:0".parse()?);

    let server = broker.serve_ipc(endpoint)?;

    #[cfg(unix)]
    {
        let sock_path = server.unix_socket_path().ok_or("缺少 UnixSocket 路径")?;
        let sock_mode = fs::metadata(sock_path)?.permissions().mode() & 0o777;
        assert_eq!(sock_mode, 0o600, "Broker Unix Socket 权限必须严格为 0600");
        if let Some(parent) = sock_path.parent() {
            let dir_mode = fs::metadata(parent)?.permissions().mode() & 0o777;
            assert_eq!(dir_mode, 0o700, "Broker 父目录权限必须严格为 0700");
        }
    }

    // 1. 攻击者域名、非白名单端口、路径穿越与前缀混淆全部返回 403 且绝不触达攻击者服务
    for forbidden_url in [
        format!("http://evil.attacker.invalid:{attacker_port}/v1/allowed/echo"),
        format!("http://127.0.0.1:{attacker_port}/v1/allowed/echo"),
        format!("https://127.0.0.1:{upstream_port}/v1/allowed/echo"),
        format!("http://127.0.0.1:{upstream_port}/v1/allowed/../admin"),
        format!("http://127.0.0.1:{upstream_port}/v1/allowed/%2e%2e/admin"),
        format!("http://127.0.0.1:{upstream_port}/v1/allowed_bypass/echo"),
        format!("http://user@127.0.0.1:{upstream_port}/v1/allowed/echo"),
    ] {
        let resp = server.send_request(&BrokerProxyRequest {
            capability_token: grant.capability_token.clone(),
            method: String::from("GET"),
            target_url: forbidden_url.clone(),
            headers: Vec::new(),
            body: Vec::new(),
        })?;
        assert_eq!(
            resp.status, 403,
            "越界目标 {forbidden_url} 必须返回 HTTP 403，实际返回 {}",
            resp.status
        );
    }

    // 2. 错误的能力令牌必须返回 401
    let bad_tok_resp = server.send_request(&BrokerProxyRequest {
        capability_token: String::from(
            "0000000000000000000000000000000000000000000000000000000000000000",
        ),
        method: String::from("GET"),
        target_url: format!("http://127.0.0.1:{upstream_port}/v1/allowed/echo"),
        headers: Vec::new(),
        body: Vec::new(),
    })?;
    assert_eq!(bad_tok_resp.status, 401);

    // 3. 上游恶意重定向至攻击者地址时，Broker 绝不自动跟随转发凭据
    let redirect_resp = server.send_request(&BrokerProxyRequest {
        capability_token: grant.capability_token.clone(),
        method: String::from("GET"),
        target_url: format!("http://127.0.0.1:{upstream_port}/v1/allowed/redirect"),
        headers: Vec::new(),
        body: Vec::new(),
    })?;
    assert_eq!(
        attacker_hits.load(Ordering::SeqCst),
        0,
        "攻击者服务不得收到任何重定向请求"
    );
    assert!(redirect_resp.status == 403 || redirect_resp.status == 302);

    // 4. 合法白名单请求注入凭据成功，且响应头与响应体中的明文/标准Base64/URL-safe无填充Base64 全部被替换为 [REDACTED]
    let ok_resp = server.send_request(&BrokerProxyRequest {
        capability_token: grant.capability_token.clone(),
        method: String::from("GET"),
        target_url: format!("http://127.0.0.1:{upstream_port}/v1/allowed/echo"),
        headers: Vec::new(),
        body: Vec::new(),
    })?;
    assert_eq!(ok_resp.status, 200);
    let body_text = ok_resp.body_lossy();
    assert!(
        body_text.contains("\"auth_injected\":true"),
        "白名单上游必须收到注入的真实 Bearer 密钥: {body_text}"
    );
    assert!(!body_text.contains(secret), "响应体不得残留密钥明文");
    assert!(
        !body_text.contains(&secret_b64_std),
        "响应体不得残留标准 Base64 编码密钥"
    );
    assert!(
        !body_text.contains(&secret_b64_url),
        "响应体不得残留 URL-safe 无填充 Base64 编码密钥"
    );
    assert!(
        body_text.contains("\"echo_plain\":\"[REDACTED]\""),
        "明文回显必须被替换为 [REDACTED]: {body_text}"
    );
    assert!(
        body_text.contains("\"echo_b64_std\":\"[REDACTED]\""),
        "标准 Base64 回显必须被替换为 [REDACTED]: {body_text}"
    );
    assert!(
        body_text.contains("\"echo_b64_url\":\"[REDACTED]\""),
        "URL-safe Base64 回显必须被替换为 [REDACTED]: {body_text}"
    );

    let debug_hdr = ok_resp
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("x-debug-mirror"))
        .map(|(_, v)| v.as_str())
        .ok_or("缺少脱敏后的 X-Debug-Mirror 响应头")?;
    assert_eq!(debug_hdr, "[REDACTED]|[REDACTED]|[REDACTED]");

    // 5. 在 Linux 沙箱内部经挂载的 Unix Socket 发起原始 HTTP/1.1 代理请求同样工作且遵守 403/脱敏契约
    #[cfg(target_os = "linux")]
    {
        let sock_path = server
            .unix_socket_path()
            .ok_or("缺少 UnixSocket")?
            .to_path_buf();
        let ws = tmp.path().join("broker_sbx_ws");
        let qz_home = tmp.path().join("broker_qz_home");
        fs::create_dir_all(&ws)?;
        fs::create_dir_all(&qz_home)?;
        let manager = SandboxManager::new(SandboxConfig::new(&qz_home));
        let ticket = manager.mint_ticket(TicketRequest {
            run_id: RunId::new_v4(),
            workspace_dir: ws,
            mode: SandboxMode::WorkspaceWritable,
            network_policy: NetworkPolicy::Isolated,
            ttl_ms: Some(30_000),
            now_wall_ms: 50_000,
        })?;
        let py_uds = format!(
            concat!(
                "import socket\n",
                "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n",
                "s.connect({sock:?})\n",
                "req = ('GET /v1/allowed/echo HTTP/1.1\\r\\nHost: localhost\\r\\nX-Quetzalcoatl-Broker-Token: {tok}\\r\\nX-Quetzalcoatl-Target-Url: http://127.0.0.1:{port}/v1/allowed/echo\\r\\nConnection: close\\r\\n\\r\\n').encode()\n",
                "s.sendall(req)\n",
                "chunks = []\n",
                "while True:\n",
                "    d = s.recv(4096)\n",
                "    if not d: break\n",
                "    chunks.append(d)\n",
                "raw = b''.join(chunks).decode()\n",
                "assert '200 OK' in raw, raw\n",
                "assert '[REDACTED]' in raw, raw\n",
                "print('SANDBOX_UDS_BROKER_OK')\n"
            ),
            sock = sock_path.display().to_string(),
            tok = grant.capability_token,
            port = upstream_port,
        );
        let mut cmd = SandboxCommand::new("/usr/bin/python3", vec![String::from("-c"), py_uds]);
        cmd.broker_unix_socket = Some(sock_path.clone());
        let sbx_out = manager.execute_with_ticket(&ticket, &cmd, 50_100)?;
        assert!(
            sbx_out.success(),
            "断网沙箱经 UDS 访问 CredentialBroker 应成功: stderr={}",
            sbx_out.stderr_lossy()
        );
        assert_eq!(sbx_out.stdout_lossy().trim(), "SANDBOX_UDS_BROKER_OK");

        // 同时验证原生 UnixStream 直连攻击者 URL 返回 403
        let mut raw_uds = UnixStream::connect(&sock_path)?;
        let evil_http = format!(
            "GET / HTTP/1.1\r\nHost: localhost\r\nX-Quetzalcoatl-Broker-Token: {}\r\nX-Quetzalcoatl-Target-Url: http://127.0.0.1:{attacker_port}/steal\r\nConnection: close\r\n\r\n",
            grant.capability_token
        );
        raw_uds.write_all(evil_http.as_bytes())?;
        let mut evil_reply = String::new();
        raw_uds.read_to_string(&mut evil_reply)?;
        assert!(evil_reply.starts_with("HTTP/1.1 403"));
    }

    assert_eq!(attacker_hits.load(Ordering::SeqCst), 0);

    server.shutdown()?;
    attacker_stop.store(true, Ordering::Relaxed);
    upstream_stop.store(true, Ordering::Relaxed);
    let _ = attacker_thread.join();
    let _ = upstream_thread.join();

    Ok(())
}

#[test]
fn cross_platform_macos_seatbelt_and_windows_graded_plans_are_verified() -> TestResult {
    let spec_rw = SandboxExecSpec {
        quetzalcoatl_home: PathBuf::from("/Users/alice/.quetzalcoatl"),
        user_home: Some(PathBuf::from("/Users/alice")),
        workspace_dir: PathBuf::from("/Users/alice/work/repo"),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        verifier_suite_dir: None,
        broker_unix_socket: Some(PathBuf::from("/tmp/qz-broker/broker.sock")),
        extra_masked_paths: Vec::new(),
        extra_ro_mounts: Vec::new(),
        extra_env: BTreeMap::new(),
        allowlisted_host_env: Vec::new(),
    };

    // macOS Seatbelt 可写工作区策略验证
    let (sb_bin, sb_args, sbpl_rw) =
        macos::build_seatbelt_invocation(&spec_rw, &SandboxCommand::shell("echo hi"))?;
    assert_eq!(sb_bin, PathBuf::from("/usr/bin/sandbox-exec"));
    assert!(sb_args.iter().any(|a| a == "-p"));
    assert!(sbpl_rw.contains("(version 1)"));
    assert!(sbpl_rw.contains("/Users/alice/.quetzalcoatl/secrets"));
    assert!(sbpl_rw.contains("/Users/alice/.ssh"));
    assert!(sbpl_rw.contains("/Users/alice/work/repo/.git/hooks"));
    assert!(sbpl_rw.contains("/Users/alice/work/repo/.opencode"));

    // macOS Seatbelt 洁净室断网只读策略验证
    let mut spec_clean = spec_rw.clone();
    spec_clean.mode = SandboxMode::CleanRoomReadOnly;
    spec_clean.network_policy = NetworkPolicy::Isolated;
    spec_clean.verifier_suite_dir = Some(PathBuf::from("/Library/Quetzalcoatl/verifier"));
    let sbpl_clean = macos::generate_seatbelt_profile(&spec_clean)?;
    assert!(sbpl_clean.contains("(deny network*)"));
    assert!(!sbpl_clean.contains("(allow file-write* (subpath \"/Users/alice/work/repo\"))"));

    // Windows 首选 mxc-sdk AppContainer 与回退 srt-win Restricted Token 分级验证
    let win_cmd = SandboxCommand::new("cmd.exe", vec![String::from("/c"), String::from("ver")]);
    let plan_mxc = windows::build_windows_sandbox_plan(&spec_rw, &win_cmd, true)?;
    assert_eq!(plan_mxc.tier, WindowsSandboxTier::MxcAppContainer);
    assert!(!plan_mxc.capability_sids.is_empty());
    assert!(plan_mxc.kill_on_job_close);
    assert!(plan_mxc.acl_entries.iter().any(|e| {
        e.path == Path::new("/Users/alice/work/repo/.opencode")
            && e.access == WindowsAccessDisposition::DenyWrite
    }));
    assert!(plan_mxc.acl_entries.iter().any(|e| {
        e.path == Path::new("/Users/alice/.quetzalcoatl/secrets")
            && e.access == WindowsAccessDisposition::DenyAll
    }));

    let plan_clean_srt = windows::build_windows_sandbox_plan(&spec_clean, &win_cmd, false)?;
    assert_eq!(plan_clean_srt.tier, WindowsSandboxTier::SrtRestrictedToken);
    assert!(
        plan_clean_srt.capability_sids.is_empty(),
        "断网洁净室不得授予任何网络能力 SID"
    );
    assert!(!plan_clean_srt.stripped_privileges.is_empty());

    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn non_tmp_quetzalcoatl_home_git_worktree_and_mountpoint_rename_defenses() -> TestResult {
    // 在 /var/tmp（非 /tmp，位于真实根挂载 --ro-bind / / 之上）验证符号链接秘密目录与真实秘密目录双重遮蔽
    let var_tmp_base =
        PathBuf::from("/var/tmp").join(format!("qz_vartmp_{}", Uuid::new_v4().simple()));
    fs::create_dir_all(&var_tmp_base)?;
    struct VarTmpCleanup(PathBuf);
    impl Drop for VarTmpCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = VarTmpCleanup(var_tmp_base.clone());

    let real_qz_home = var_tmp_base.join("real_qz_home");
    fs::create_dir_all(real_qz_home.join("secrets"))?;
    fs::write(real_qz_home.join("secrets/probe"), "VARTMP_REAL_SECRET")?;
    let linked_qz_home = var_tmp_base.join("linked_qz_home");
    symlink(&real_qz_home, &linked_qz_home)?;

    // 模拟 Git Worktree（.git 为普通文件而非目录）
    let wt_ws = var_tmp_base.join("worktree_ws");
    fs::create_dir_all(wt_ws.join(".opencode"))?;
    fs::write(
        wt_ws.join(".git"),
        "gitdir: /nonexistent/main/.git/worktrees/worker1\n",
    )?;

    let manager = SandboxManager::new(SandboxConfig::new(&linked_qz_home));
    let ticket = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: wt_ws.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        ttl_ms: Some(30_000),
        now_wall_ms: 100_000,
    })?;

    let check_script = format!(
        concat!(
            "if cat '{}' >/dev/null 2>&1; then echo LEAK_SYMLINK_PATH; exit 61; fi\n",
            "if cat '{}' >/dev/null 2>&1; then echo LEAK_CANON_PATH; exit 62; fi\n",
            "if sh -c 'echo hijack > \"{}/.git\"' 2>/dev/null; then echo WROTE_GITFILE; exit 63; fi\n",
            "if rm -f '{}/.git' 2>/dev/null; then echo REMOVED_GITFILE; exit 64; fi\n",
            "if mv '{}/.opencode' '{}/.opencode_bak' 2>/dev/null; then echo RENAMED_OPENCODE; exit 65; fi\n",
            "if rmdir '{}/.opencode' 2>/dev/null; then echo RMDIR_OPENCODE; exit 66; fi\n",
            "echo WORKTREE_AND_VARTMP_OK\n"
        ),
        linked_qz_home.join("secrets/probe").display(),
        real_qz_home.join("secrets/probe").display(),
        wt_ws.display(),
        wt_ws.display(),
        wt_ws.display(),
        wt_ws.display(),
        wt_ws.display(),
    );

    let out =
        manager.execute_with_ticket(&ticket, &SandboxCommand::shell(check_script), 100_100)?;
    assert!(
        out.success(),
        "非 /tmp 路径遮蔽或 Git Worktree 保护失败: code={}, stdout={}, stderr={}",
        out.exit_code,
        out.stdout_lossy(),
        out.stderr_lossy()
    );
    assert_eq!(out.stdout_lossy().trim(), "WORKTREE_AND_VARTMP_OK");
    Ok(())
}

#[test]
fn loopback_tcp_broker_rejects_wildcard_bind_and_scrubs_chunked_secret_echoes() -> TestResult {
    let broker = CredentialBroker::new();

    // 严禁绑定全网卡 0.0.0.0 暴露本地凭据代理
    let wildcard_err = broker
        .serve_ipc(BrokerEndpoint::LoopbackTcp("0.0.0.0:0".parse()?))
        .err()
        .ok_or("绑定 0.0.0.0 必须被拒绝")?;
    assert_eq!(wildcard_err.code(), ErrorCode::SandboxViolation);

    let secret = "sk-custom-header-secret-value-778899";
    let upstream_listener = TcpListener::bind("127.0.0.1:0")?;
    upstream_listener.set_nonblocking(true)?;
    let upstream_port = upstream_listener.local_addr()?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_bg = Arc::clone(&stop);
    let secret_owned = String::from(secret);

    // 模拟上游返回 Transfer-Encoding: chunked，并将密钥明文故意切分在两个 chunk 边界两侧！
    let upstream_handle = thread::spawn(move || {
        while !stop_bg.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = upstream_listener.accept() else {
                thread::sleep(std::time::Duration::from_millis(5));
                continue;
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req_str = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
            // 确认代理内部控制头 X-Quetzalcoatl-* 与防御性拦截头 X-Qz-* 均未泄漏给上游，且自定义 x-api-key 已正确注入
            let cap_stripped = !req_str.contains("x-quetzalcoatl-broker-token")
                && !req_str.contains("x-qz-legacy-header");
            let key_injected =
                req_str.contains(&format!("x-api-key: {}", secret_owned.to_ascii_lowercase()));

            let half = secret_owned.len() / 2;
            let part1 = format!(
                "{{\"cap_stripped\":{cap_stripped},\"injected\":{key_injected},\"leak\":\"{}",
                &secret_owned[..half]
            );
            let part2 = format!("{}\"}}", &secret_owned[half..]);
            let wire = format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{part1}\r\n{:x}\r\n{part2}\r\n0\r\n\r\n",
                part1.len(),
                part2.len()
            );
            let _ = stream.write_all(wire.as_bytes());
        }
    });

    let grant = broker.register_scoped_secret(ScopedSecretRegistration {
        secret_value: String::from(secret),
        allowed_origins: vec![OriginPathRule::new(
            "http",
            "127.0.0.1",
            upstream_port,
            "/v1/messages",
        )?],
        injection: SecretInjection::CustomHeader {
            header_name: String::from("x-api-key"),
            value_prefix: None,
        },
    })?;

    let server = broker.serve_ipc(BrokerEndpoint::LoopbackTcp("127.0.0.1:0".parse()?))?;
    let resp = server.send_request(&BrokerProxyRequest {
        capability_token: grant.capability_token.clone(),
        method: String::from("POST"),
        target_url: format!("http://127.0.0.1:{upstream_port}/v1/messages"),
        headers: vec![
            (
                String::from("X-Quetzalcoatl-Broker-Token"),
                grant.capability_token.clone(),
            ),
            (
                String::from("X-Qz-Legacy-Header"),
                String::from("must-also-be-stripped"),
            ),
        ],
        body: b"{}".to_vec(),
    })?;
    assert_eq!(resp.status, 200);
    let text = resp.body_lossy();
    assert!(
        text.contains("\"cap_stripped\":true"),
        "控制头未剥离: {text}"
    );
    assert!(text.contains("\"injected\":true"), "自定义头未注入: {text}");
    assert!(
        !text.contains(secret),
        "跨 chunk 边界的密钥明文未脱敏: {text}"
    );
    assert!(
        text.contains("\"leak\":\"[REDACTED]\""),
        "跨 chunk 脱敏结果异常: {text}"
    );

    // 吊销授权后再次请求必须立即返回 401
    assert!(broker.revoke_grant(grant.grant_id));
    let revoked_resp = server.send_request(&BrokerProxyRequest {
        capability_token: grant.capability_token,
        method: String::from("POST"),
        target_url: format!("http://127.0.0.1:{upstream_port}/v1/messages"),
        headers: Vec::new(),
        body: Vec::new(),
    })?;
    assert_eq!(revoked_resp.status, 401);

    server.shutdown()?;
    stop.store(true, Ordering::Relaxed);
    let _ = upstream_handle.join();
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn regression_critical_1_workspace_at_user_home_masks_all_secrets_and_mounts_nested_broker_socket()
-> TestResult {
    let base = PathBuf::from("/tmp/opencode");
    let root = if base.is_dir() {
        base
    } else {
        std::env::temp_dir()
    };
    let short_dir = root.join(format!("c1_{}", &Uuid::new_v4().simple().to_string()[..8]));
    fs::create_dir_all(&short_dir)?;
    let tmp = TempDirGuard { path: short_dir };
    let fake_user_home = tmp.path().join("home");
    let qz_home = fake_user_home.join(".quetzalcoatl");
    fs::create_dir_all(qz_home.join("secrets"))?;
    fs::create_dir_all(qz_home.join("run"))?;
    fs::create_dir_all(fake_user_home.join(".ssh"))?;
    fs::create_dir_all(fake_user_home.join(".claude"))?;
    fs::create_dir_all(fake_user_home.join(".codex"))?;

    fs::write(qz_home.join("secrets/probe"), "HOME_QZ_SECRET")?;
    fs::write(fake_user_home.join(".ssh/id_ed25519"), "HOME_SSH_SECRET")?;
    fs::write(
        fake_user_home.join(".claude/credentials.json"),
        "{\"refresh_token\":\"HOME_CLAUDE_RT\"}",
    )?;
    fs::write(
        fake_user_home.join(".codex/auth.json"),
        "{\"refresh_token\":\"HOME_CODEX_RT\"}",
    )?;

    // 启动模拟上游与位于 $QUETZALCOATL_HOME/run/broker.sock 内部的真实 CredentialBroker UnixSocket
    let upstream_listener = TcpListener::bind("127.0.0.1:0")?;
    upstream_listener.set_nonblocking(true)?;
    let upstream_port = upstream_listener.local_addr()?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_bg = Arc::clone(&stop);
    let upstream_thread = thread::spawn(move || {
        while !stop_bg.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = upstream_listener.accept() else {
                thread::sleep(std::time::Duration::from_millis(5));
                continue;
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let body = "{\"status\":\"ok\",\"echo\":\"sk-home-broker-secret\"}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });

    let broker = CredentialBroker::new();
    let grant = broker.register_scoped_secret(ScopedSecretRegistration {
        secret_value: String::from("sk-home-broker-secret"),
        allowed_origins: vec![OriginPathRule::new(
            "http",
            "127.0.0.1",
            upstream_port,
            "/v1/ping",
        )?],
        injection: SecretInjection::BearerHeader,
    })?;
    let sock_path = qz_home.join("run/broker.sock");
    let server = broker.serve_ipc(BrokerEndpoint::UnixSocket(sock_path.clone()))?;

    let mut cfg = SandboxConfig::new(&qz_home);
    cfg.user_home = Some(fake_user_home.clone());
    let manager = SandboxManager::new(cfg);

    // 关键边界：workspace_dir 恰好等于 fake_user_home（所有私密目录的祖先目录）！
    let ticket = manager.mint_ticket(TicketRequest {
        run_id: RunId::new_v4(),
        workspace_dir: fake_user_home.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::Isolated,
        ttl_ms: Some(30_000),
        now_wall_ms: 200_000,
    })?;

    let py_script = format!(
        concat!(
            "import socket\n",
            "for secret_path in [{p1:?}, {p2:?}, {p3:?}, {p4:?}]:\n",
            "    try:\n",
            "        open(secret_path, 'rb').read()\n",
            "        raise SystemExit('LEAKED_READ:' + secret_path)\n",
            "    except OSError:\n",
            "        pass\n",
            "for ro_dir in [{d1:?}, {d2:?}, {d3:?}, {d4:?}, {d5:?}, {d6:?}, {d7:?}]:\n",
            "    try:\n",
            "        open(ro_dir + '/tamper', 'w').write('x')\n",
            "        raise SystemExit('LEAKED_WRITE:' + ro_dir)\n",
            "    except OSError:\n",
            "        pass\n",
            "open({note:?}, 'w').write('home_workspace_ok')\n",
            "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n",
            "s.connect({sock:?})\n",
            "req = ('GET /v1/ping HTTP/1.1\\r\\nHost: localhost\\r\\nX-Quetzalcoatl-Broker-Token: {tok}\\r\\nX-Quetzalcoatl-Target-Url: http://127.0.0.1:{port}/v1/ping\\r\\nConnection: close\\r\\n\\r\\n').encode()\n",
            "s.sendall(req)\n",
            "reply = b''\n",
            "while True:\n",
            "    c = s.recv(4096)\n",
            "    if not c: break\n",
            "    reply += c\n",
            "text = reply.decode()\n",
            "assert '200 OK' in text, text\n",
            "assert '[REDACTED]' in text and 'sk-home-broker-secret' not in text, text\n",
            "print('HOME_WORKSPACE_MASK_AND_BROKER_OK')\n"
        ),
        p1 = qz_home.join("secrets/probe").display().to_string(),
        p2 = fake_user_home.join(".ssh/id_ed25519").display().to_string(),
        p3 = fake_user_home
            .join(".claude/credentials.json")
            .display()
            .to_string(),
        p4 = fake_user_home
            .join(".codex/auth.json")
            .display()
            .to_string(),
        d1 = qz_home.display().to_string(),
        d2 = qz_home.join("run").display().to_string(),
        d3 = fake_user_home.join(".ssh").display().to_string(),
        d4 = fake_user_home.join(".claude").display().to_string(),
        d5 = fake_user_home.join(".codex").display().to_string(),
        d6 = fake_user_home.join(".opencode").display().to_string(),
        d7 = fake_user_home.join(".git/hooks").display().to_string(),
        note = fake_user_home
            .join("project_note.txt")
            .display()
            .to_string(),
        sock = sock_path.display().to_string(),
        tok = grant.capability_token,
        port = upstream_port,
    );

    let mut cmd = SandboxCommand::new("/usr/bin/python3", vec![String::from("-c"), py_script]);
    cmd.broker_unix_socket = Some(sock_path);
    let out = manager.execute_with_ticket(&ticket, &cmd, 200_100)?;
    assert!(
        out.success(),
        "workspace == $HOME 时密钥遮蔽或嵌套 Broker Socket 失败: code={}, stdout={}, stderr={}",
        out.exit_code,
        out.stdout_lossy(),
        out.stderr_lossy()
    );
    assert_eq!(
        out.stdout_lossy().trim(),
        "HOME_WORKSPACE_MASK_AND_BROKER_OK"
    );
    assert_eq!(
        fs::read_to_string(fake_user_home.join("project_note.txt"))?,
        "home_workspace_ok"
    );

    server.shutdown()?;
    stop.store(true, Ordering::Relaxed);
    let _ = upstream_thread.join();
    Ok(())
}

#[test]
fn regression_important_1_macos_seatbelt_last_match_canonical_paths_and_worktree_gitfile_locks()
-> TestResult {
    let tmp = TempDirGuard::new("quetzalcoatl_imp1_worktree")?;
    let wt_ws = tmp.path().join("wt_repo");
    fs::create_dir_all(wt_ws.join(".opencode"))?;
    // Git Worktree 中 .git 为普通文件
    fs::write(
        wt_ws.join(".git"),
        "gitdir: /Users/alice/main/.git/worktrees/wt1\n",
    )?;

    // 1. workspace == user_home 时，Seatbelt 必须在 allow file-write* (subpath "<ws>") 之后输出 deny file-read* file-write* 规则（Last-match-wins）
    let home_ws_spec = SandboxExecSpec {
        quetzalcoatl_home: PathBuf::from("/Users/alice/.quetzalcoatl"),
        user_home: Some(PathBuf::from("/Users/alice")),
        workspace_dir: PathBuf::from("/Users/alice"),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        verifier_suite_dir: None,
        broker_unix_socket: Some(PathBuf::from("/Users/alice/.quetzalcoatl/run/broker.sock")),
        extra_masked_paths: Vec::new(),
        extra_ro_mounts: Vec::new(),
        extra_env: BTreeMap::new(),
        allowlisted_host_env: Vec::new(),
    };
    let sbpl_home = macos::generate_seatbelt_profile(&home_ws_spec)?;
    let allow_ws_pos = sbpl_home
        .find("(allow file-write* (subpath \"/Users/alice\"))")
        .ok_or("缺少 workspace allow 规则")?;
    let deny_secrets_pos = sbpl_home
        .rfind("(deny file-read* file-write* (subpath \"/Users/alice/.quetzalcoatl/secrets\"))")
        .ok_or("缺少 secrets deny 规则")?;
    let allow_broker_pos = sbpl_home
        .rfind("(allow file-read* file-write* (literal \"/Users/alice/.quetzalcoatl/run/broker.sock\"))")
        .ok_or("缺少嵌套 broker_unix_socket literal 放行规则")?;
    assert!(
        deny_secrets_pos > allow_ws_pos,
        "Seatbelt last-match-wins 要求宿主密钥 deny 规则必须排在 workspace allow 规则之后: \n{sbpl_home}"
    );
    assert!(
        allow_broker_pos > deny_secrets_pos,
        "嵌套在被遮蔽目录内的单文件 broker_unix_socket literal 放行必须位于父目录遮蔽之后: \n{sbpl_home}"
    );

    // 2. /tmp/clean_ws 洁净室模式必须同时输出 /private/tmp/clean_ws 写拒绝，压制前序 /private/tmp 临时可写规则
    let clean_tmp_spec = SandboxExecSpec {
        quetzalcoatl_home: PathBuf::from("/tmp/qz_home"),
        user_home: Some(PathBuf::from("/Users/alice")),
        workspace_dir: PathBuf::from("/tmp/clean_ws"),
        mode: SandboxMode::CleanRoomReadOnly,
        network_policy: NetworkPolicy::Isolated,
        verifier_suite_dir: Some(PathBuf::from("/var/folders/qz/suite")),
        broker_unix_socket: None,
        extra_masked_paths: Vec::new(),
        extra_ro_mounts: Vec::new(),
        extra_env: BTreeMap::new(),
        allowlisted_host_env: Vec::new(),
    };
    let sbpl_clean_tmp = macos::generate_seatbelt_profile(&clean_tmp_spec)?;
    let allow_private_tmp_pos = sbpl_clean_tmp
        .find("/private/tmp")
        .ok_or("缺少 /private/tmp 基础规则")?;
    let deny_private_tmp_ws_pos = sbpl_clean_tmp
        .rfind("(deny file-write* (subpath \"/private/tmp/clean_ws\"))")
        .ok_or("缺少规范化 /private/tmp/clean_ws 洁净室只读拒绝规则")?;
    assert!(
        deny_private_tmp_ws_pos > allow_private_tmp_pos,
        "/private/tmp/clean_ws 只读拒绝必须覆盖 /private/tmp 写放行: \n{sbpl_clean_tmp}"
    );
    assert!(
        sbpl_clean_tmp.contains("(deny file-write* (subpath \"/private/var/folders/qz/suite\"))"),
        "/var 路径必须同步输出 /private/var 规范化只读保护: \n{sbpl_clean_tmp}"
    );
    assert!(
        sbpl_clean_tmp
            .rfind("(deny file-read* file-write* (subpath \"/private/tmp/qz_home\"))")
            .is_some(),
        "/tmp 下的 quetzalcoatl_home 必须同步遮蔽 /private/tmp/qz_home: \n{sbpl_clean_tmp}"
    );

    // 3. Git Worktree 单文件 .git 在 macOS Seatbelt 中使用 (literal ...) 保护，在 Windows 计划中生成 DenyWrite ACL
    let wt_spec = SandboxExecSpec {
        quetzalcoatl_home: PathBuf::from("/Users/alice/.quetzalcoatl"),
        user_home: Some(PathBuf::from("/Users/alice")),
        workspace_dir: wt_ws.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        verifier_suite_dir: None,
        broker_unix_socket: None,
        extra_masked_paths: Vec::new(),
        extra_ro_mounts: Vec::new(),
        extra_env: BTreeMap::new(),
        allowlisted_host_env: Vec::new(),
    };
    let sbpl_wt = macos::generate_seatbelt_profile(&wt_spec)?;
    let expected_git_literal = format!(
        "(deny file-write* (literal \"{}\"))",
        wt_ws.join(".git").display()
    );
    assert!(
        sbpl_wt.contains(&expected_git_literal),
        "Git Worktree 单文件 .git 必须使用 Seatbelt literal 规则锁定: \n{sbpl_wt}"
    );

    let win_wt_plan = windows::build_windows_sandbox_plan(
        &wt_spec,
        &SandboxCommand::new("cmd.exe", vec![String::from("/c"), String::from("ver")]),
        true,
    )?;
    assert!(
        win_wt_plan.acl_entries.iter().any(|e| {
            e.path == wt_ws.join(".git") && e.access == WindowsAccessDisposition::DenyWrite
        }),
        "Windows 沙箱计划必须对 Git Worktree 单文件 .git 生成 DenyWrite ACL: {:?}",
        win_wt_plan.acl_entries
    );

    Ok(())
}

#[test]
fn regression_important_3_public_build_bwrap_args_locks_protected_subpaths_and_orders_masks_last()
-> TestResult {
    let tmp = TempDirGuard::new("quetzalcoatl_imp3_bwrap_args")?;
    let fake_home = tmp.path().join("home_alice");
    let qz_home = fake_home.join(".quetzalcoatl");
    let repo_ws = tmp.path().join("repo_ws");
    fs::create_dir_all(qz_home.join("secrets"))?;
    fs::create_dir_all(fake_home.join(".claude"))?;
    fs::create_dir_all(fake_home.join(".codex"))?;
    fs::create_dir_all(repo_ws.join(".opencode"))?;
    fs::write(
        repo_ws.join(".git"),
        "gitdir: /tmp/main/.git/worktrees/w1\n",
    )?;

    // 1. 直接调用公开 API linux::build_bwrap_args 必须默认包含受保护路径只读锁（含单文件 .git 与 .opencode）
    let repo_spec = SandboxExecSpec {
        quetzalcoatl_home: qz_home.clone(),
        user_home: Some(fake_home.clone()),
        workspace_dir: repo_ws.clone(),
        mode: SandboxMode::WorkspaceWritable,
        network_policy: NetworkPolicy::AllowHostNetwork,
        verifier_suite_dir: None,
        broker_unix_socket: None,
        extra_masked_paths: Vec::new(),
        extra_ro_mounts: Vec::new(),
        extra_env: BTreeMap::new(),
        allowlisted_host_env: Vec::new(),
    };
    let (_bin, args_repo) =
        linux::build_bwrap_args(&repo_spec, &SandboxCommand::shell("echo check"))?;
    let opencode_str = repo_ws.join(".opencode").display().to_string();
    let gitfile_str = repo_ws.join(".git").display().to_string();
    assert!(
        args_repo
            .windows(3)
            .any(|w| w[0] == "--ro-bind" && w[1] == opencode_str && w[2] == opencode_str),
        "公开 build_bwrap_args 必须包含 .opencode 只读挂载: {args_repo:?}"
    );
    assert!(
        args_repo
            .windows(3)
            .any(|w| w[0] == "--ro-bind" && w[1] == gitfile_str && w[2] == gitfile_str),
        "公开 build_bwrap_args 必须包含单文件 .git 只读挂载: {args_repo:?}"
    );

    // 2. 当 workspace_dir == fake_home 时：--tmpfs 遮蔽必须位于 --bind <fake_home> 之后，且不得用 --ro-bind 重新暴露 .claude/.codex
    let mut home_spec = repo_spec;
    home_spec.workspace_dir = fake_home.clone();
    let (_bin2, args_home) =
        linux::build_bwrap_args(&home_spec, &SandboxCommand::shell("echo check"))?;
    let home_str = fake_home.display().to_string();
    let claude_str = fake_home.join(".claude").display().to_string();
    let bind_ws_idx = args_home
        .windows(3)
        .position(|w| w[0] == "--bind" && w[1] == home_str && w[2] == home_str)
        .ok_or("缺少 --bind workspace 参数")?;
    let mask_claude_idx = args_home
        .windows(2)
        .position(|w| w[0] == "--tmpfs" && w[1] == claude_str)
        .ok_or("缺少 --tmpfs ~/.claude 遮蔽参数")?;
    assert!(
        mask_claude_idx > bind_ws_idx,
        "宿主密钥 --tmpfs 遮蔽必须位于 --bind workspace 之后: {args_home:?}"
    );
    assert!(
        !args_home
            .windows(3)
            .any(|w| w[0] == "--ro-bind" && w[1] == claude_str),
        "workspace == $HOME 时严禁通过 --ro-bind 重新暴露真实的 ~/.claude: {args_home:?}"
    );

    Ok(())
}

#[test]
fn regression_important_4_agents_md_full_spelling_env_and_headers_enforced() -> TestResult {
    // 1. CLI --help 仅公开全拼 QUETZALCOATL_SANDBOX_* 环境变量，不暴露 QZ_SANDBOX_* 简写
    let bin = env!("CARGO_BIN_EXE_quetzalcoatl-sandbox-exec");
    let help_out = Command::new(bin).arg("--help").output()?;
    assert!(help_out.status.success());
    let help_text = String::from_utf8_lossy(&help_out.stdout);
    assert!(
        help_text.contains("QUETZALCOATL_SANDBOX_SPEC"),
        "CLI --help 必须声明全拼 QUETZALCOATL_SANDBOX_SPEC: {help_text}"
    );
    assert!(
        !help_text.contains("QZ_SANDBOX_"),
        "CLI --help 不得包含违反 AGENTS.md §2 的 QZ_SANDBOX_ 简写: {help_text}"
    );

    // 2. NamedPipe 端点校验全拼前缀且在非 Windows 宿主返回清晰平台不支持错误
    let broker = CredentialBroker::new();
    let bad_pipe_err = broker
        .serve_ipc(BrokerEndpoint::NamedPipe(String::from(
            r"\\.\pipe\qz-short-invalid",
        )))
        .err()
        .ok_or("简写管道前缀必须被拒绝")?;
    assert_eq!(bad_pipe_err.code(), ErrorCode::SandboxViolation);

    #[cfg(not(windows))]
    {
        let non_win_err = broker
            .serve_ipc(BrokerEndpoint::NamedPipe(String::from(
                r"\\.\pipe\quetzalcoatl-broker-unit",
            )))
            .err()
            .ok_or("非 Windows 平台调用 NamedPipe 应返回明确不支持错误")?;
        assert_eq!(non_win_err.code(), ErrorCode::SandboxViolation);
    }

    // 3. 原始 HTTP 代理不再接受旧简写头 X-Qz-Capability-Token 作为有效鉴权凭据（返回 401）
    let grant = broker.register_scoped_secret(ScopedSecretRegistration {
        secret_value: String::from("sk-full-spelling-test"),
        allowed_origins: vec![OriginPathRule::new("http", "127.0.0.1", 9, "/v1")?],
        injection: SecretInjection::BearerHeader,
    })?;
    let server = broker.serve_ipc(BrokerEndpoint::LoopbackTcp("127.0.0.1:0".parse()?))?;
    let bound = server.loopback_addr().ok_or("缺少回环监听地址")?;

    let mut tcp = std::net::TcpStream::connect(bound)?;
    let legacy_req = format!(
        "GET /v1 HTTP/1.1\r\nHost: localhost\r\nX-Qz-Capability-Token: {}\r\nX-Quetzalcoatl-Target-Url: http://127.0.0.1:9/v1\r\nConnection: close\r\n\r\n",
        grant.capability_token
    );
    tcp.write_all(legacy_req.as_bytes())?;
    let mut reply = String::new();
    tcp.read_to_string(&mut reply)?;
    assert!(
        reply.starts_with("HTTP/1.1 401"),
        "简写头 X-Qz-Capability-Token 不得再被接受为鉴权令牌，实际响应: {reply}"
    );

    server.shutdown()?;
    Ok(())
}
