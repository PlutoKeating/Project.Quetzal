#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

mod common;

use std::error::Error;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use quetzalcoatl_daemon::{
    DaemonConfig, DelegateRunRequest, IpcClient, IpcRequest, IpcResponse, QuetzalcoatlDaemon,
};
use quetzalcoatl_harness::GatewayUpstreamEndpoints;
use quetzalcoatl_kernel::CleanRoomVerifierDag;
use quetzalcoatl_sandbox::SandboxCommand;
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore};
use rusqlite::Connection;

type TestResult = Result<(), Box<dyn Error>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let path = common::temp_root(prefix)?;
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

#[cfg(unix)]
fn write_executable_script(path: &Path, body: &str) -> Result<(), Box<dyn Error>> {
    fs::write(path, body)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("无法定位工作区根目录")?;
    Ok(root.to_path_buf())
}

struct MockUpstreamServer {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    captured_bodies: Arc<Mutex<Vec<String>>>,
    join: Option<thread::JoinHandle<()>>,
}

impl MockUpstreamServer {
    fn start() -> Result<Self, Box<dyn Error>> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
        let addr = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_bg = Arc::clone(&stop);
        let captured_bodies = Arc::new(Mutex::new(Vec::new()));
        let captured_bg = Arc::clone(&captured_bodies);

        let join = thread::spawn(move || {
            while !stop_bg.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                        let mut buf = Vec::new();
                        let mut chunk = [0u8; 4096];
                        let mut content_len = 0usize;
                        let mut header_end_opt = None;
                        loop {
                            match stream.read(&mut chunk) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => {
                                    buf.extend_from_slice(&chunk[..n]);
                                    if header_end_opt.is_none()
                                        && let Some(pos) =
                                            buf.windows(4).position(|w| w == b"\r\n\r\n")
                                    {
                                        header_end_opt = Some(pos);
                                        if let Ok(head) = std::str::from_utf8(&buf[..pos]) {
                                            for line in head.split("\r\n") {
                                                if let Some((k, v)) = line.split_once(':')
                                                    && k.trim()
                                                        .eq_ignore_ascii_case("content-length")
                                                    && let Ok(cl) = v.trim().parse::<usize>()
                                                {
                                                    content_len = cl;
                                                }
                                            }
                                        }
                                    }
                                    if let Some(pos) = header_end_opt
                                        && buf.len() >= pos + 4 + content_len
                                    {
                                        break;
                                    }
                                }
                            }
                        }
                        if let Some(pos) = header_end_opt {
                            let body_str = String::from_utf8_lossy(&buf[pos + 4..]).into_owned();
                            if let Ok(mut guard) = captured_bg.lock() {
                                guard.push(body_str);
                            }
                        }
                        let resp_json = r#"{"id":"msg_e2e_1","type":"message","role":"assistant","content":[{"type":"text","text":"同伴回答已生成 <ewave_check conflict=\"none\" ids=\"\"/>"}]}"#.as_bytes();
                        let resp_head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            resp_json.len()
                        );
                        let _ = stream.write_all(resp_head.as_bytes());
                        let _ = stream.write_all(resp_json);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            addr,
            stop,
            captured_bodies,
            join: Some(join),
        })
    }

    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

impl Drop for MockUpstreamServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

fn raw_daemon_http(
    addr: SocketAddr,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<u16, Box<dyn Error>> {
    let mut stream = TcpStream::connect(addr)?;
    let mut wire = Vec::new();
    wire.extend_from_slice(b"POST /v1/rpc HTTP/1.1\r\n");
    wire.extend_from_slice(b"Connection: close\r\n");
    for (k, v) in headers {
        wire.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
    }
    wire.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
    wire.extend_from_slice(body);
    stream.write_all(&wire)?;

    let mut out = Vec::new();
    stream.read_to_end(&mut out)?;
    let status_str = std::str::from_utf8(&out)?;
    let code: u16 = status_str
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .ok_or("缺少 HTTP 状态码")?
        .parse()?;
    Ok(code)
}

#[test]
fn daemon_exclusive_spine_lock_and_dns_rebinding_host_origin_403_and_token_401_guards() -> TestResult
{
    let tmp = TempDirGuard::new("qz_daemon_security")?;
    let qz_home = tmp.path().join("home");

    let mut daemon1 = QuetzalcoatlDaemon::start(DaemonConfig::new(qz_home.clone()))?;
    let info = daemon1.runtime_info().clone();
    let ipc_token = daemon1.ipc_token().to_owned();

    // 防坑规范 #13：同一 QUETZALCOATL_HOME 下绝对禁止启动第二个守护进程争抢 spine.sqlite！
    let second_res = QuetzalcoatlDaemon::start(DaemonConfig::new(qz_home.clone()));
    assert!(
        second_res.is_err(),
        "第二个 quetzalcoatld 实例必须被 spine/daemon.lock 独占锁拦截"
    );

    #[cfg(unix)]
    {
        let sock_path = info
            .unix_socket_path
            .as_ref()
            .ok_or("POSIX 平台必须暴露 run/daemon.sock")?;
        let sock_mode = fs::metadata(sock_path)?.permissions().mode() & 0o777;
        assert_eq!(sock_mode, 0o600, "daemon.sock 权限必须严格为 0600");
    }

    let rpc_body = br#"{"method":"status"}"#;

    // 1. DNS 重绑定伪造 Host 头 -> 403 Forbidden
    let st_evil_host = raw_daemon_http(
        info.ipc_http_addr,
        &[
            ("Host", "evil.attacker.example:8080"),
            ("x-qz-ipc-token", &ipc_token),
        ],
        rpc_body,
    )?;
    assert_eq!(st_evil_host, 403, "非回环 Host 头必须返回 403");

    let st_nip_host = raw_daemon_http(
        info.ipc_http_addr,
        &[("Host", "127.0.0.1.nip.io"), ("x-qz-ipc-token", &ipc_token)],
        rpc_body,
    )?;
    assert_eq!(st_nip_host, 403, "127.0.0.1.nip.io 重绑定域名必须返回 403");

    // 2. 跨源网页 Origin 头 -> 403 Forbidden
    let local_host_hdr = info.ipc_http_addr.to_string();
    let st_bad_origin = raw_daemon_http(
        info.ipc_http_addr,
        &[
            ("Host", &local_host_hdr),
            ("Origin", "https://malicious.site"),
            ("x-qz-ipc-token", &ipc_token),
        ],
        rpc_body,
    )?;
    assert_eq!(st_bad_origin, 403, "跨源 Origin 请求必须返回 403");

    // 3. 合法 Host + 合法回环 Origin，但缺失或错误令牌 -> 401 Unauthorized
    let local_origin = format!("http://{}", info.ipc_http_addr);
    let st_no_token = raw_daemon_http(
        info.ipc_http_addr,
        &[("Host", &local_host_hdr), ("Origin", &local_origin)],
        rpc_body,
    )?;
    assert_eq!(st_no_token, 401, "缺失本地 IPC 令牌必须返回 401");

    let st_ok = raw_daemon_http(
        info.ipc_http_addr,
        &[
            ("Host", &local_host_hdr),
            ("Origin", &local_origin),
            ("x-qz-ipc-token", &ipc_token),
            ("Content-Type", "application/json"),
        ],
        rpc_body,
    )?;
    assert_eq!(st_ok, 200);

    daemon1.shutdown()?;
    Ok(())
}

#[test]
fn full_single_node_e2e_router_worker_worktree_clean_room_verifier_explore_and_qz_cli() -> TestResult
{
    let tmp = TempDirGuard::new("qz_e2e_single_node")?;
    let qz_home = tmp.path().join("home");
    let mock_upstream = MockUpstreamServer::start()?;

    // 准备假 Coding Agent 可执行进程：
    // 1. 验证当前目录是独立 Git worktree（.git 为 gitdir 文件而非主仓库目录）
    // 2. 通过 QUETZALCOATL_GATEWAY_URL + x-qz-token 真实调用回环 LLM 网关验证良知组装流
    // 3. 修改工作区代码并输出标准 JSON-RPC 事件流
    let fake_worker_bin = tmp.path().join("fake_worker_agent.sh");
    #[cfg(unix)]
    write_executable_script(
        &fake_worker_bin,
        r#"#!/bin/sh
set -e
if [ ! -f ".git" ]; then
  echo "expected isolated git worktree (.git file)" >&2
  exit 91
fi
if [ -z "$SHELL" ]; then
  echo "expected SHELL wrapper env" >&2
  exit 92
fi
if [ ! -f "$QUETZALCOATL_SANDBOX_SPEC" ]; then
  echo "expected QUETZALCOATL_SANDBOX_SPEC file" >&2
  exit 93
fi
printf 'pub fn compute_sum(a: u32, b: u32) -> u32 { a + b }\n' > src/lib.rs
echo '{"jsonrpc":"2.0","method":"session/update","params":{"type":"turn_started","turn_id":"turn_w1"}}'
echo '{"jsonrpc":"2.0","method":"session/update","params":{"type":"tool_call","call_id":"call_1","tool_name":"edit","arguments":{"path":"src/lib.rs"}}}'
echo '{"jsonrpc":"2.0","method":"session/update","params":{"type":"turn_completed","turn_id":"turn_w1","final_text":"Implemented compute_sum in isolated worktree. <ewave_check conflict=\"none\" ids=\"\"/>"}}'
"#,
    )?;

    // 准备待修改的真实目标 Git 代码仓库与独立只读洁净室校验套件
    let project_repo = tmp.path().join("sample_project");
    fs::create_dir_all(project_repo.join("src"))?;
    fs::write(
        project_repo.join("src/lib.rs"),
        "pub fn compute_sum(_a: u32, _b: u32) -> u32 { 0 }\n",
    )?;
    assert!(
        Command::new("git")
            .current_dir(&project_repo)
            .args(["init", "-q"])
            .status()?
            .success()
    );
    let _ = Command::new("git")
        .current_dir(&project_repo)
        .args(["config", "user.email", "dev@quetzalcoatl.test"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&project_repo)
        .args(["config", "user.name", "Dev"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&project_repo)
        .args(["add", "."])
        .status()?;
    assert!(
        Command::new("git")
            .current_dir(&project_repo)
            .args(["commit", "-q", "-m", "init broken sum"])
            .status()?
            .success()
    );

    let verifier_suite = tmp.path().join("locked_verifier_suite");
    fs::create_dir_all(&verifier_suite)?;
    let verify_script = verifier_suite.join("verify.sh");
    #[cfg(unix)]
    write_executable_script(
        &verify_script,
        r#"#!/bin/sh
set -e
grep -q 'a + b' "$QUETZALCOATL_CANDIDATE_WORKSPACE/src/lib.rs"
echo 'QZ_VERIFIER_REPORT: {"executed_tests": 4, "passed_tests": 4, "failed_tests": 0}'
"#,
    )?;

    let vacuous_suite = tmp.path().join("vacuous_verifier_suite");
    fs::create_dir_all(&vacuous_suite)?;
    let vacuous_script = vacuous_suite.join("vacuous.sh");
    #[cfg(unix)]
    write_executable_script(
        &vacuous_script,
        "#!/bin/sh\necho 'QZ_VERIFIER_REPORT: {\"executed_tests\": 0, \"passed_tests\": 0, \"failed_tests\": 0}'\n",
    )?;

    // 准备合成 V1 SQLite 会话数据库夹具用于 `qz import-v1`
    let root = repo_root()?;
    let v1_soul_dir = root.join("crates/quetzalcoatl-spine/tests/fixtures/v1_soul_v14");
    let v1_sql = fs::read_to_string(
        root.join("crates/quetzalcoatl-spine/tests/fixtures/v1_quetzal_sample.sql"),
    )?;
    let v1_db_path = tmp.path().join("legacy_v1.db");
    {
        let conn = Connection::open(&v1_db_path)?;
        conn.execute_batch(&v1_sql)?;
    }

    let qz_bin = PathBuf::from(env!("CARGO_BIN_EXE_qz"));
    let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_quetzalcoatld"));

    // 1. 使用真实 `qz up` 拉起后台 `quetzalcoatld` 并等待健康就绪
    let up_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .env("QUETZALCOATL_DAEMON_BIN", &daemon_bin)
        .env("QUETZALCOATL_UPSTREAM_BASE_URL", mock_upstream.base_url())
        .env("QUETZALCOATL_UPSTREAM_BEARER_TOKEN", "test-upstream-token")
        .env("QUETZALCOATL_WORKER_BINARY", &fake_worker_bin)
        .args(["up"])
        .output()?;
    assert!(
        up_out.status.success(),
        "qz up 失败: stdout={}, stderr={}",
        String::from_utf8_lossy(&up_out.stdout),
        String::from_utf8_lossy(&up_out.stderr)
    );

    // 2. `qz status --json` 与 `qz agents --json` 薄客户端 IPC 模式检查
    let status_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .args(["status", "--json"])
        .output()?;
    assert!(status_out.status.success());
    let status_json: serde_json::Value = serde_json::from_slice(&status_out.stdout)?;
    assert!(status_json["pid"].as_u64().unwrap_or(0) > 0);

    let agents_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .args(["agents", "--json"])
        .output()?;
    assert!(agents_out.status.success());
    let agents_json: serde_json::Value = serde_json::from_slice(&agents_out.stdout)?;
    assert!(
        agents_json["elapsed_micros"].as_u64().unwrap_or(99_999) < 10_000,
        "qz agents 必须在 <10ms 内返回"
    );

    // 3. 在线薄客户端模式执行 `qz import-v1`（零 SQLITE_BUSY！）
    let import_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .args([
            "import-v1",
            "--soul-dir",
            &v1_soul_dir.to_string_lossy(),
            "--db",
            &v1_db_path.to_string_lossy(),
        ])
        .output()?;
    assert!(
        import_out.status.success(),
        "在线 qz import-v1 失败: {}",
        String::from_utf8_lossy(&import_out.stderr)
    );

    // 4. 自家对话入口不存在：`qz chat` 不是合法子命令，守护进程也没有对话接口，
    //    因此守护进程自身从不向上游模型发请求。
    let chat_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .args(["chat", "你好"])
        .output()?;
    assert!(
        !chat_out.status.success(),
        "qz chat 已拆除，必须以非零码退出"
    );
    {
        let bodies = mock_upstream.captured_bodies.lock().map_err(|_| "lock")?;
        assert!(
            bodies.is_empty(),
            "守护进程自身不得调用模型，上游不应收到任何请求"
        );
    }

    // 5a. 代码工程任务反例：0 用例空跑（Anti-Vacuity）校验器被洁净室拦截，主仓库保持原样！
    let ipc = IpcClient::connect_from_home(&qz_home)?.ok_or("应连接到在线 quetzalcoatld")?;
    let vacuous_dag = CleanRoomVerifierDag::single(
        "vacuous-check",
        vacuous_suite.clone(),
        SandboxCommand::new(
            "/bin/sh",
            vec![vacuous_script.to_string_lossy().into_owned()],
        ),
    );
    let vacuous_res = ipc.call(&IpcRequest::DelegateRun(DelegateRunRequest {
        task: String::from("尝试空跑测试混过验收"),
        peer_id: None,
        workspace_dir: project_repo.clone(),
        verifier_dag: Some(vacuous_dag),
        router_attempted_forbidden_tools: vec![String::from("shell"), String::from("edit")],
        hold_for_approval: false,
    }))?;
    assert!(
        matches!(vacuous_res, IpcResponse::Error { .. }),
        "0 用例空跑必须被洁净室 Verifier 拒绝签发 Mark"
    );
    assert_eq!(
        fs::read_to_string(project_repo.join("src/lib.rs"))?,
        "pub fn compute_sum(_a: u32, _b: u32) -> u32 { 0 }\n",
        "未通过洁净室验收时主仓库文件严禁被改动"
    );

    // 5b. 代码工程任务正例：Router 被剥夺 shell/edit -> 自动派发独立 Git Worktree Worker -> 洁净室验收通过签发 VerificationMark
    let code_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .args([
            "delegate",
            "实现 compute_sum 加法逻辑",
            "--workspace",
            &project_repo.to_string_lossy(),
            "--verifier-suite",
            &verifier_suite.to_string_lossy(),
            "--verifier-cmd",
            &format!("/bin/sh {}", verify_script.display()),
            "--json",
        ])
        .output()?;
    assert!(
        code_out.status.success(),
        "工程任务 qz delegate 失败: stderr={}",
        String::from_utf8_lossy(&code_out.stderr)
    );
    let code_resp: serde_json::Value = serde_json::from_slice(&code_out.stdout)?;
    assert!(code_resp["final_text"].is_string());
    assert_eq!(code_resp["verifier_runs"], 1);
    assert_eq!(
        code_resp["verification_mark"]["executed_test_count"], 4,
        "必须签发含真实用例计数的 VerificationMark"
    );
    assert_eq!(code_resp["verification_mark"]["passed_test_count"], 4);
    assert_eq!(
        fs::read_to_string(project_repo.join("src/lib.rs"))?,
        "pub fn compute_sum(a: u32, b: u32) -> u32 { a + b }\n",
        "洁净室验收通过后工作树变更应落盘至目标仓库"
    );

    // 同时核对 Router 若尝试调用 shell/edit 被确定性剥夺拦截
    let router_guard_res = ipc.call(&IpcRequest::DelegateRun(DelegateRunRequest {
        task: String::from("再次验证 Router 剥夺记录"),
        peer_id: None,
        workspace_dir: project_repo.clone(),
        verifier_dag: Some(CleanRoomVerifierDag::single(
            "unit-suite",
            verifier_suite,
            SandboxCommand::new(
                "/bin/sh",
                vec![verify_script.to_string_lossy().into_owned()],
            ),
        )),
        router_attempted_forbidden_tools: vec![String::from("shell"), String::from("edit")],
        hold_for_approval: false,
    }))?;
    match router_guard_res {
        IpcResponse::DelegateRun(resp) => {
            assert!(
                resp.router_denied_capabilities
                    .contains(&String::from("shell"))
            );
            assert!(
                resp.router_denied_capabilities
                    .contains(&String::from("edit"))
            );
            assert!(resp.verification_mark.is_some());
        }
        other => return Err(format!("预期返回 DelegateRun 响应，实际收到: {other:?}").into()),
    }

    // 6. 闲置期生物钟唤醒 `Explore Run`：沙箱内即时合成并运行本地技能成功，外发写动作被硬拒
    let explore_res = ipc.call(&IpcRequest::ExploreTick {
        synthesize_skill_id: Some(String::from("skill.local_digest")),
        synthesize_script_body: Some(String::from("#!/bin/sh\necho 'evolved-skill-ok'\n")),
        attempt_external_send: true,
    })?;
    match explore_res {
        IpcResponse::ExploreTick(rep) => {
            assert!(rep.woke_explore);
            assert_eq!(
                rep.synthesized_skill_id.as_deref(),
                Some("skill.local_digest")
            );
            assert!(
                rep.skill_stdout
                    .as_deref()
                    .unwrap_or("")
                    .contains("evolved-skill-ok")
            );
            assert!(
                rep.external_write_refused,
                "Explore Run 必须硬剥夺一切外部通道写权限"
            );
        }
        other => return Err(format!("预期返回 ExploreTick，实际收到: {other:?}").into()),
    }

    // 7. 在线执行 `qz export`（经本地 IPC 无锁冲突导出）
    let online_zip = tmp.path().join("online_export.zip");
    let export_online_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .args(["export", &online_zip.to_string_lossy()])
        .output()?;
    assert!(
        export_online_out.status.success(),
        "在线 qz export 失败: {}",
        String::from_utf8_lossy(&export_online_out.stderr)
    );
    assert!(online_zip.is_file());

    // 8. `qz down` 优雅关闭守护进程
    let down_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .args(["down"])
        .output()?;
    assert!(
        down_out.status.success(),
        "qz down 失败: {}",
        String::from_utf8_lossy(&down_out.stderr)
    );

    // 9. 守护进程下线后，`qz export` 直接安全读取 $QUETZALCOATL_HOME 导出，且核验 spine.sqlite 哈希链与签名完整性
    let offline_zip = tmp.path().join("offline_export.zip");
    let export_offline_out = Command::new(&qz_bin)
        .env("QUETZALCOATL_HOME", &qz_home)
        .args(["export", &offline_zip.to_string_lossy()])
        .output()?;
    assert!(
        export_offline_out.status.success(),
        "离线 qz export 失败: {}",
        String::from_utf8_lossy(&export_offline_out.stderr)
    );
    {
        let zf = File::open(&offline_zip)?;
        let mut archive = zip::ZipArchive::new(zf)?;
        assert!(archive.by_name("SOUL.md").is_ok());
        let mut manifest_entry = archive.by_name(".quetzalcoatl-spine/manifest.json")?;
        let mut manifest_raw = Vec::new();
        manifest_entry.read_to_end(&mut manifest_raw)?;
        let _sealed_env: quetzalcoatl_crypto::SealedManifestEnvelope =
            serde_json::from_slice(&manifest_raw)?;
    }

    // 数据库与签名链终验：单写者 seq 严格连续、prev_blake3 闭环、Ed25519 签名 100% 有效！
    let wal_store = RusqliteWalStore::open(&qz_home.join("spine/spine.sqlite"))?;
    let pubkeys = wal_store.list_device_pubkeys()?;
    assert!(!pubkeys.is_empty());
    for (dev_id, pk) in pubkeys {
        let dev_events = wal_store.list_device_events(dev_id)?;
        assert!(!dev_events.is_empty());
        let mut expected_prev = quetzalcoatl_types::ArtifactId::ZERO;
        for (expected_seq, ev) in (1u64..).zip(dev_events) {
            assert_eq!(ev.header.seq, expected_seq);
            assert_eq!(ev.header.prev_blake3, expected_prev);
            ev.verify(&pk)?;
            expected_prev = ev.event_blake3;
        }
    }

    let _ = GatewayUpstreamEndpoints::default();
    Ok(())
}

#[test]
fn regression_r1_finding1_6_and_8_worker_runs_inside_os_sandbox_without_daemon_access_mcp_and_routine_error_propagation()
-> TestResult {
    let tmp = TempDirGuard::new("qz_r1_sandbox_worker_e2e")?;
    let qz_home = tmp.path().join("qz_home");

    // 1. Finding 1b: 当配置了不存在的 sandbox_exec_override 时，必须硬失败 SandboxViolation，绝不可静默回退 /bin/sh！
    let project_repo = tmp.path().join("repo");
    fs::create_dir_all(project_repo.join("src"))?;
    fs::write(project_repo.join("src/lib.rs"), "pub fn v() -> u32 { 0 }\n")?;
    assert!(
        Command::new("git")
            .current_dir(&project_repo)
            .args(["init", "-q"])
            .status()?
            .success()
    );
    let _ = Command::new("git")
        .current_dir(&project_repo)
        .args(["config", "user.email", "r1@quetzalcoatl.test"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&project_repo)
        .args(["config", "user.name", "R1"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&project_repo)
        .args(["add", "."])
        .status()?;
    assert!(
        Command::new("git")
            .current_dir(&project_repo)
            .args(["commit", "-q", "-m", "init"])
            .status()?
            .success()
    );

    let bad_sandbox_home = tmp.path().join("bad_sbx_home");
    let mut bad_cfg = DaemonConfig::new(bad_sandbox_home);
    // 本用例校验的是沙箱缺失时的 fail-closed，而不是模型配置；
    // 显式给一个凭据，避免结果取决于运行机器上是否存在 ~/.claude / ~/.codex。
    bad_cfg.upstream_bearer_token = Some(String::from("test-upstream-token"));
    bad_cfg.sandbox_exec_override = Some(tmp.path().join("nonexistent-quetzalcoatl-sandbox-exec"));
    bad_cfg.worker_binary_override = Some(PathBuf::from("/bin/true"));
    let mut bad_daemon = QuetzalcoatlDaemon::start(bad_cfg)?;
    let bad_client =
        IpcClient::from_runtime_info(bad_daemon.runtime_info(), bad_daemon.ipc_token().to_owned());
    let fail_closed_res = bad_client.call(&IpcRequest::DelegateRun(DelegateRunRequest {
        task: String::from("must fail closed without /bin/sh fallback"),
        peer_id: None,
        workspace_dir: project_repo.clone(),
        verifier_dag: None,
        router_attempted_forbidden_tools: Vec::new(),
        hold_for_approval: false,
    }))?;
    match fail_closed_res {
        IpcResponse::Error { code, .. } => {
            assert_eq!(
                code, "SANDBOX_VIOLATION",
                "缺失沙箱包装器时必须 fail-closed 返回 SANDBOX_VIOLATION"
            );
        }
        other => {
            return Err(
                format!("缺失沙箱包装器时严禁静默回退 /bin/sh，实际返回: {other:?}").into(),
            );
        }
    }
    bad_daemon.shutdown()?;

    // 2. Finding 1a/1c/1d + Finding 6:
    // Worker 必须在真实 OS 沙箱 (bwrap) 内执行：
    // - 读取 $QUETZALCOATL_HOME/identity/sovereign_state.json 与 daemon.token 必须失败（被空 tmpfs 遮蔽）！
    // - 读取剥离后的 CLAUDE_CONFIG_DIR / CODEX_HOME 存根目录必须成功（不被 bwrap --tmpfs /tmp 抹掉）！
    // - QUETZALCOATL_MCP_URL 必须已挂载并绑定；沙箱里没有任何通往守护进程本地 IPC 的令牌。
    let mock_upstream = MockUpstreamServer::start()?;
    let sandbox_exec_bin = PathBuf::from(env!("CARGO_BIN_EXE_qz"))
        .parent()
        .ok_or("bin parent")?
        .join("quetzalcoatl-sandbox-exec");

    let verifier_suite = tmp.path().join("suite");
    fs::create_dir_all(&verifier_suite)?;
    let verify_sh = verifier_suite.join("verify.sh");
    #[cfg(unix)]
    write_executable_script(
        &verify_sh,
        "#!/bin/sh\ngrep -q 'sandbox_confined' \"$QUETZALCOATL_CANDIDATE_WORKSPACE/src/lib.rs\"\necho 'QZ_VERIFIER_REPORT: {\"executed_tests\": 2, \"passed_tests\": 2, \"failed_tests\": 0}'\n",
    )?;

    let probing_worker = tmp.path().join("probing_worker.sh");
    #[cfg(unix)]
    write_executable_script(
        &probing_worker,
        &format!(
            r#"#!/bin/sh
set -e
# (A) 断言当前运行在真实无容器沙箱内，$QUETZALCOATL_HOME 被遮蔽不可读！
if [ -f "{qz_home}/identity/sovereign_state.json" ] || [ -f "{qz_home}/identity/keys.json" ]; then
  echo "CRITICAL LEAK: Worker read the identity or key files!" >&2
  exit 71
fi
if [ -f "{qz_home}/run/daemon.token" ]; then
  echo "CRITICAL LEAK: Worker read master daemon.token!" >&2
  exit 72
fi
# (B) 断言 CLAUDE_CONFIG_DIR 与 CODEX_HOME 存根目录在 bwrap 内真实存在且可读！
if [ ! -d "$CLAUDE_CONFIG_DIR" ] || [ ! -d "$CODEX_HOME" ]; then
  echo "MISSING OAuth stub dirs inside sandbox: CLAUDE=$CLAUDE_CONFIG_DIR CODEX=$CODEX_HOME" >&2
  exit 73
fi
# (C) 断言会话级 MCP URL 已分配且在沙箱内可调用！
if [ -z "$QUETZALCOATL_MCP_URL" ]; then
  echo "MISSING QUETZALCOATL_MCP_URL" >&2
  exit 74
fi
MCP_OUT=$(/usr/bin/curl -s -f -X POST "$QUETZALCOATL_MCP_URL" -H "Content-Type: application/json" -d '{{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{{}}}}')
echo "$MCP_OUT" | grep -q 'ewave.recall' || exit 75

# (D) 沙箱里没有守护进程的令牌与地址：模型执行的脚本够不着本地 IPC。
if [ -n "$QUETZALCOATL_IPC_TOKEN" ] || [ -n "$QUETZALCOATL_DAEMON_URL" ]; then
  echo "CRITICAL: daemon IPC handle leaked into the Worker sandbox" >&2
  exit 76
fi
printf 'pub fn v() -> u32 {{ 99 }} // sandbox_confined\n' > src/lib.rs
echo '{{"type":"text","part":{{"type":"text","text":"Worker confined inside OS sandbox <ewave_check conflict=\"none\" ids=\"\"/>"}}}}'
echo '{{"type":"step_finish","part":{{"reason":"stop"}}}}'
"#,
            qz_home = qz_home.display()
        ),
    )?;

    let mut cfg = DaemonConfig::new(qz_home.clone());
    cfg.upstream_endpoints.anthropic_base_url = mock_upstream.base_url();
    cfg.upstream_endpoints.openai_base_url = mock_upstream.base_url();
    cfg.upstream_endpoints.codex_chatgpt_base_url = mock_upstream.base_url();
    cfg.upstream_endpoints.gemini_base_url = mock_upstream.base_url();
    cfg.upstream_bearer_token = Some(String::from("test-upstream-token"));
    cfg.worker_binary_override = Some(probing_worker);
    if sandbox_exec_bin.is_file() {
        cfg.sandbox_exec_override = Some(sandbox_exec_bin);
    }

    let mut daemon = QuetzalcoatlDaemon::start(cfg)?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());

    let code_res = client.call(&IpcRequest::DelegateRun(DelegateRunRequest {
        task: String::from("run confined worker probe"),
        peer_id: None,
        workspace_dir: project_repo.clone(),
        verifier_dag: Some(CleanRoomVerifierDag::single(
            "sbx-suite",
            verifier_suite,
            SandboxCommand::new("/bin/sh", vec![verify_sh.to_string_lossy().into_owned()]),
        )),
        router_attempted_forbidden_tools: Vec::new(),
        hold_for_approval: true,
    }))?;
    let approval_id = match code_res {
        IpcResponse::DelegateRun(resp) => {
            assert!(
                resp.final_text
                    .contains("Worker confined inside OS sandbox")
            );
            assert!(resp.verification_mark.is_some());
            resp.approval_id
                .ok_or("用户自己的仓库：验收通过后先等拍板")?
        }
        other => {
            return Err(format!("沙箱内 Worker 执行应成功，实际返回: {other:?}").into());
        }
    };
    assert!(
        !fs::read_to_string(project_repo.join("src/lib.rs"))?.contains("sandbox_confined"),
        "没拍板之前，用户的目录一个字节都没动"
    );
    match client.call(&IpcRequest::Approvals)? {
        IpcResponse::Approvals(items) => {
            assert_eq!(items.len(), 1);
            assert!(
                items[0].files.iter().any(|f| f == "src/lib.rs"),
                "{items:?}"
            );
        }
        other => return Err(format!("预期返回拍板队列，实际: {other:?}").into()),
    }
    match client.call(&IpcRequest::ApprovalDecide {
        id: approval_id,
        approve: true,
    })? {
        IpcResponse::ApprovalDecide(outcome) => {
            assert!(outcome.approved);
            assert!(outcome.applied_files.iter().any(|f| f == "src/lib.rs"));
        }
        other => return Err(format!("预期返回拍板结果，实际: {other:?}").into()),
    }
    assert!(
        fs::read_to_string(project_repo.join("src/lib.rs"))?.contains("sandbox_confined"),
        "Worker 在真实 bwrap 沙箱内完成修改、通过洁净室校验、经你同意后合进来"
    );

    daemon.shutdown()?;

    Ok(())
}

#[test]
fn regression_r2_daemon_scratch_root_rejects_preplanted_symlink_and_enforces_0700() -> TestResult {
    let tmp = TempDirGuard::new("qz_r2_scratch_symlink")?;
    let qz_home = tmp.path().join("qz_home");
    let mut daemon = QuetzalcoatlDaemon::start(DaemonConfig::new(qz_home))?;
    let agent_id = daemon.runtime_info().agent_id;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());

    #[cfg(unix)]
    if Path::new("/var/tmp").is_dir() {
        let scratch_path = PathBuf::from(format!("/var/tmp/quetzalcoatl-scratch-{agent_id}"));
        let _ = fs::remove_dir_all(&scratch_path);
        let _ = fs::remove_file(&scratch_path);

        let attacker_target = tmp.path().join("attacker_controlled");
        fs::create_dir_all(&attacker_target)?;
        std::os::unix::fs::symlink(&attacker_target, &scratch_path)?;

        let poisoned_res = client.call(&IpcRequest::ExploreTick {
            synthesize_skill_id: None,
            synthesize_script_body: None,
            attempt_external_send: false,
        })?;
        let _ = fs::remove_file(&scratch_path);
        match poisoned_res {
            IpcResponse::Error { code, .. } => {
                assert_eq!(
                    code, "SANDBOX_VIOLATION",
                    "/var/tmp 临时沙箱目录被预植符号链接时必须返回 SANDBOX_VIOLATION"
                );
            }
            other => {
                return Err(
                    format!("预植符号链接 scratch_root 必须被拒绝，实际返回: {other:?}").into(),
                );
            }
        }

        let clean_res = client.call(&IpcRequest::ExploreTick {
            synthesize_skill_id: None,
            synthesize_script_body: None,
            attempt_external_send: false,
        })?;
        assert!(matches!(clean_res, IpcResponse::ExploreTick(_)));
        let scratch_meta = fs::symlink_metadata(&scratch_path)?;
        assert!(!scratch_meta.file_type().is_symlink());
        assert_eq!(
            scratch_meta.permissions().mode() & 0o077,
            0,
            "/var/tmp scratch_root 权限必须严格为 0700（零组/其他用户权限）"
        );
    }

    daemon.shutdown()?;
    Ok(())
}
