#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Task 2.3 守护进程与 `qz` CLI 的 fabric 接入回归测试：
//! 1. 默认关闭时行为与既有守护进程完全一致（不建节点、不写 `fabric/`、状态明确显示 disabled）；
//! 2. 对接真实 Go `quetzalcoatl-hub` 子进程，验证 `qz login` / `qz pair start|join|approve` / `qz nodes` / `qz status`；
//! 3. 错误 PIN 与非法配对短码必须返回类型化错误码，绝不出现 `Ack: ...` 伪装。

use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity};
use quetzalcoatl_daemon::{
    DaemonConfig, DaemonFabricConfig, GroupRoomRuntime, IpcClient, IpcRequest, IpcResponse,
    QuetzalcoatlDaemon,
};
use quetzalcoatl_fabric::{HubClient, HubClientConfig};
use quetzalcoatl_types::{AgentId, DeviceId};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose, SanType,
};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error + Send + Sync>> {
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

/// 本进程专属的 Hub 二进制缓存名（PID + 启动随机后缀），并行 runner 绝不互相覆盖。
fn hub_bin_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos() as u64);
        format!(
            "quetzalcoatl-hub-{}-{:08x}",
            std::process::id(),
            nanos as u32
        )
    })
}

/// 清理陈旧缓存：仅删除 PID 已不存在的副本来；绝不碰其他进程或用例的文件。
fn prune_stale_hub_binaries(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let self_name = hub_bin_name();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == self_name {
            continue;
        }
        if !name.starts_with("quetzalcoatl-hub") {
            continue;
        }
        // 旧共享路径（quetzalcoatl-hub）与无法解析 PID 的历史文件一律清理。
        let pid_alive = name
            .strip_prefix("quetzalcoatl-hub-")
            .and_then(|rest| rest.split('-').next())
            .and_then(|pid| pid.parse::<u32>().ok())
            .is_some_and(|pid| Path::new(&format!("/proc/{pid}")).exists());
        if !pid_alive {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn repo_root() -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("cannot locate workspace root")?;
    Ok(root.to_path_buf())
}

fn build_hub_binary(bin_path: &Path) -> Result<(), String> {
    let root = repo_root().map_err(|e| e.to_string())?;
    let output = Command::new("go")
        .current_dir(root.join("hub"))
        .env("CGO_ENABLED", "0")
        .args([
            "build",
            "-o",
            &bin_path.to_string_lossy(),
            "./cmd/quetzalcoatl-hub",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "go build quetzalcoatl-hub failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn compiled_go_hub_binary() -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
    static HUB_BIN: OnceLock<std::result::Result<PathBuf, String>> = OnceLock::new();
    let cached = HUB_BIN.get_or_init(|| {
        let out_dir = PathBuf::from("/tmp/opencode/qz_go_hub_bin_cache");
        if let Err(e) = fs::create_dir_all(&out_dir) {
            return Err(format!("create hub bin cache dir failed: {e}"));
        }
        // 进程唯一路径：并行 runner 不会互相覆盖/exec 同一文件，也不会无界累积。
        prune_stale_hub_binaries(&out_dir);
        let bin_path = out_dir.join(hub_bin_name());
        build_hub_binary(&bin_path).map(|()| bin_path)
    });
    let path = match cached {
        Ok(path) => path.clone(),
        Err(msg) => return Err(msg.clone().into()),
    };
    if !path.exists() {
        // 上一次 spawn 后已 unlink 运行中的二进制：按需重建到同一路径。
        build_hub_binary(&path)?;
    }
    Ok(path)
}

/// 为单次 spawn 复制一份唯一可执行文件：并行测试绝不共享同一 inode/路径。
fn spawn_copy_of_hub_binary(master: &Path) -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
    let unique = format!(
        "{}-run-{}",
        master.file_name().and_then(|n| n.to_str()).unwrap_or("hub"),
        Uuid::new_v4()
    );
    let path = master.with_file_name(unique);
    fs::copy(master, &path)?;
    Ok(path)
}

fn reserve_free_tcp_port() -> Result<u16, Box<dyn Error + Send + Sync>> {
    let l = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    Ok(l.local_addr()?.port())
}

fn reserve_free_udp_port() -> Result<u16, Box<dyn Error + Send + Sync>> {
    let s = UdpSocket::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    Ok(s.local_addr()?.port())
}

struct RunningGoHub {
    _tmp: TempDirGuard,
    https_url: String,
    https_port: u16,
    qad_port: u16,
    ca_cert_der: Vec<u8>,
    ca_cert_pem: String,
    child: Child,
}

struct TestPki {
    ca_cert_der: Vec<u8>,
    ca_cert_pem: String,
    server_cert_pem: String,
    server_key_pem: String,
}

fn generate_test_ca_and_hub_cert() -> Result<TestPki, Box<dyn Error + Send + Sync>> {
    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let mut ca_dn = DistinguishedName::new();
    ca_dn.push(DnType::CommonName, "Quetzalcoatl Daemon Test Root CA");
    ca_params.distinguished_name = ca_dn;
    let ca_key = KeyPair::generate()?;
    let ca_cert = ca_params.self_signed(&ca_key)?;
    let ca_issuer = Issuer::from_params(&ca_params, ca_key);

    let mut leaf_params = CertificateParams::default();
    leaf_params.is_ca = IsCa::NoCa;
    leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    leaf_params.subject_alt_names = vec![
        SanType::IpAddress(std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)),
        SanType::DnsName("localhost".try_into()?),
    ];
    let mut leaf_dn = DistinguishedName::new();
    leaf_dn.push(DnType::CommonName, "127.0.0.1");
    leaf_params.distinguished_name = leaf_dn;
    let leaf_key = KeyPair::generate()?;
    let leaf_cert = leaf_params.signed_by(&leaf_key, &ca_issuer)?;

    Ok(TestPki {
        ca_cert_der: ca_cert.der().to_vec(),
        ca_cert_pem: ca_cert.pem(),
        server_cert_pem: leaf_cert.pem(),
        server_key_pem: leaf_key.serialize_pem(),
    })
}

impl RunningGoHub {
    fn spawn() -> Result<Self, Box<dyn Error + Send + Sync>> {
        let master = compiled_go_hub_binary()?;
        let bin = spawn_copy_of_hub_binary(&master)?;
        let tmp = TempDirGuard::new("qz_daemon_fabric_hub")?;
        let data_dir = tmp.path().join("hub_data");
        fs::create_dir_all(&data_dir)?;

        let pki = generate_test_ca_and_hub_cert()?;
        let cert_path = tmp.path().join("server_cert.pem");
        let key_path = tmp.path().join("server_key.pem");
        fs::write(&cert_path, &pki.server_cert_pem)?;
        fs::write(&key_path, &pki.server_key_pem)?;

        let https_port = reserve_free_tcp_port()?;
        let qad_port = reserve_free_udp_port()?;
        let https_addr = format!("127.0.0.1:{https_port}");
        let qad_addr = format!("127.0.0.1:{qad_port}");
        let https_url = format!("https://127.0.0.1:{https_port}");

        let log_path = tmp.path().join("hub.log");
        let log_file = fs::File::create(&log_path)?;
        let log_err = log_file.try_clone()?;

        let mut child = Command::new(&bin)
            .env("QUETZALCOATL_HUB_ADDR", &https_addr)
            .env("QUETZALCOATL_HUB_QAD_ADDR", &qad_addr)
            .env("QUETZALCOATL_HUB_TLS", "1")
            .env("QUETZALCOATL_HUB_TLS_CERT_FILE", &cert_path)
            .env("QUETZALCOATL_HUB_TLS_KEY_FILE", &key_path)
            .env("QUETZALCOATL_HUB_PUBLIC_URL", &https_url)
            .env("QUETZALCOATL_HUB_DATA_DIR", &data_dir)
            .env("QUETZALCOATL_HUB_RP_ID", "localhost")
            .env(
                "QUETZALCOATL_HUB_ALLOWED_ORIGINS",
                format!("https://localhost,{https_url}"),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_err))
            .spawn()?;
        // 二进制已映射进进程：立即 unlink，运行结束时不会留下任何副本。
        let _ = fs::remove_file(&bin);

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut ready = false;
        while Instant::now() < deadline {
            if let Some(exit) = child.try_wait()? {
                let logs = fs::read_to_string(&log_path).unwrap_or_default();
                return Err(format!("quetzalcoatl-hub exited early ({exit}): {logs}").into());
            }
            if TcpStream::connect_timeout(
                &SocketAddr::from((Ipv4Addr::LOCALHOST, https_port)),
                Duration::from_millis(50),
            )
            .is_ok()
            {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        if !ready {
            let _ = child.kill();
            let logs = fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!("quetzalcoatl-hub did not listen in 15s: {logs}").into());
        }

        Ok(Self {
            _tmp: tmp,
            https_url,
            https_port,
            qad_port,
            ca_cert_der: pki.ca_cert_der,
            ca_cert_pem: pki.ca_cert_pem,
            child,
        })
    }
}

impl RunningGoHub {
    fn signal(&self, signal: &str) -> TestResult {
        let pid = self.child.id().to_string();
        let status = Command::new("kill").args([signal, &pid]).status()?;
        if !status.success() {
            return Err(format!("kill {signal} {pid} failed").into());
        }
        Ok(())
    }

    fn pause(&self) -> TestResult {
        self.signal("-STOP")
    }

    fn resume(&self) -> TestResult {
        self.signal("-CONT")
    }
}

impl Drop for RunningGoHub {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn qz_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_qz"))
}

struct QzOutput {
    success: bool,
    args: String,
    stdout: String,
    stderr: String,
}

fn run_qz(qz_home: &Path, args: &[&str]) -> Result<QzOutput, Box<dyn Error + Send + Sync>> {
    let out = Command::new(qz_bin())
        .env("QUETZALCOATL_HOME", qz_home)
        .args(args)
        .output()?;
    Ok(QzOutput {
        success: out.status.success(),
        args: args.join(" "),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn read_sovereign_identity(
    qz_home: &Path,
) -> Result<(AgentId, DeviceIdentity, AccountRootKey), Box<dyn Error + Send + Sync>> {
    let path = qz_home.join("identity/sovereign_state.json");
    let raw = fs::read(&path)?;
    let val: serde_json::Value = serde_json::from_slice(&raw)?;
    let agent_id: AgentId = val["agent_id"]
        .as_str()
        .ok_or("missing agent_id")?
        .parse()?;
    let device_id: DeviceId = val["device_id"]
        .as_str()
        .ok_or("missing device_id")?
        .parse()?;
    let ed_seed = hex32(val["ed25519_seed_hex"].as_str().ok_or("missing seed")?)?;
    let xw_seed = hex32(val["xwing_seed_hex"].as_str().ok_or("missing xwing seed")?)?;
    let root_bytes = hex32(val["root_key_hex"].as_str().ok_or("missing root_key_hex")?)?;
    Ok((
        agent_id,
        DeviceIdentity::from_seeds(device_id, ed_seed, xw_seed)?,
        AccountRootKey::from_bytes(root_bytes),
    ))
}

fn hex32(raw: &str) -> Result<[u8; 32], Box<dyn Error + Send + Sync>> {
    let bytes = raw.trim().as_bytes();
    if bytes.len() != 64 {
        return Err("expected 64 hex chars".into());
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = (bytes[i * 2] as char).to_digit(16).ok_or("invalid hex")?;
        let lo = (bytes[i * 2 + 1] as char)
            .to_digit(16)
            .ok_or("invalid hex")?;
        out[i] = u8::try_from((hi << 4) | lo)?;
    }
    Ok(out)
}

fn register_daemon_agent_on_hub(
    hub: &RunningGoHub,
    agent_id: AgentId,
    device: &DeviceIdentity,
    root_key: &AccountRootKey,
) -> Result<String, Box<dyn Error + Send + Sync>> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let anon = HubClient::new(HubClientConfig {
        base_url: hub.https_url.clone(),
        session_token: None,
        custom_ca_certs_der: vec![hub.ca_cert_der.clone()],
    })?;
    let mut last_err: Option<String> = None;
    let mut session = None;
    for _ in 0..20 {
        match rt.block_on(anon.register_agent_with_eddsa_passkey(agent_id, device, root_key)) {
            Ok(s) => {
                session = Some(s);
                break;
            }
            Err(e) => {
                last_err = Some(e.to_string());
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    let session = session.ok_or_else(|| {
        format!(
            "hub passkey registration never succeeded: {}",
            last_err.unwrap_or_default()
        )
    })?;
    let token = session.session_token.clone();
    let authenticated = anon.with_session_token(session.session_token);
    rt.block_on(authenticated.register_opaque_pin(agent_id, b"842619", root_key))?;
    Ok(token)
}

fn fabric_disabled_config(qz_home: &Path) -> DaemonConfig {
    let mut cfg = DaemonConfig::new(qz_home.to_path_buf());
    cfg.fabric = None;
    cfg
}

#[test]
fn fabric_disabled_by_default_keeps_daemon_behavior_and_home_untouched() -> TestResult {
    // 1. 空环境变量绝不激活 fabric；显式覆盖项按契约解析。
    assert!(DaemonFabricConfig::from_env_pairs(&[]).is_none());
    let enabled = DaemonFabricConfig::from_env_pairs(&[
        (
            String::from("QUETZALCOATL_FABRIC_HUB_URL"),
            String::from("https://hub.example"),
        ),
        (
            String::from("QUETZALCOATL_FABRIC_QAD_PORT"),
            String::from("9999"),
        ),
        (String::from("QUETZALCOATL_FABRIC_MDNS"), String::from("0")),
    ])
    .ok_or("fabric env should enable the section")?;
    assert_eq!(enabled.hub_url, "https://hub.example");
    assert_eq!(enabled.relay_url, "https://hub.example");
    assert_eq!(enabled.qad_port, 9999);
    assert!(!enabled.enable_mdns);
    assert!(enabled.hub_ca_file.is_none());

    let tmp = TempDirGuard::new("qz_fabric_disabled")?;
    let qz_home = tmp.path().join("home");
    let mut daemon = QuetzalcoatlDaemon::start(fabric_disabled_config(&qz_home))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());

    // 2. 状态明确报告 disabled，且既有字段保持不变。
    match client.call(&IpcRequest::Status)? {
        IpcResponse::Status(st) => {
            assert!(st.pid > 0);
            assert_eq!(st.agent_id, daemon.runtime_info().agent_id);
            assert!(!st.fabric.enabled);
            assert_eq!(st.fabric.lease, "disabled");
            assert!(st.fabric.hub_url.is_none());
            assert!(st.fabric.peer_count == 0);
        }
        other => return Err(format!("expected status, got {other:?}").into()),
    }

    // 3. fabric 专属命令全部返回类型化 PERMISSION_DENIED，绝不伪装成功。
    for req in [
        IpcRequest::FabricPairStart,
        IpcRequest::FabricNodes,
        IpcRequest::FabricPairJoin {
            pairing_id: String::from("deadbeef"),
            short_code: String::from("AAAA-BBBB"),
        },
        IpcRequest::FabricPairApprove {
            pairing_id: String::from("deadbeef"),
            short_code: String::from("AAAA-BBBB"),
        },
    ] {
        match client.call(&req)? {
            IpcResponse::Error { code, detail } => {
                assert_eq!(code, "PERMISSION_DENIED", "unexpected code for {req:?}");
                assert!(!detail.starts_with("Ack"));
            }
            other => return Err(format!("expected PERMISSION_DENIED, got {other:?}").into()),
        }
    }

    // 4. 默认关闭时绝不创建 fabric 目录、绝不写会话文件。
    assert!(
        !qz_home.join("fabric").exists(),
        "fabric disabled 时不得创建 $QUETZALCOATL_HOME/fabric"
    );

    // 5. 既有 qz status 仍以 0 退出并报告 disabled。
    let status = run_qz(&qz_home, &["status", "--json"])?;
    assert!(status.success, "qz status 必须保持成功: {}", status.stderr);
    let status_json: serde_json::Value = serde_json::from_str(&status.stdout)?;
    assert_eq!(status_json["fabric"]["enabled"], false);
    assert_eq!(status_json["fabric"]["lease"], "disabled");

    let nodes = run_qz(&qz_home, &["nodes"])?;
    assert!(!nodes.success, "fabric 未启用时 qz nodes 必须非零退出");
    assert!(
        nodes.stderr.contains("PERMISSION_DENIED"),
        "qz nodes 必须给出类型化错误: {}",
        nodes.stderr
    );
    assert!(!nodes.stderr.contains("Ack"));

    daemon.shutdown()?;
    Ok(())
}

#[test]
fn qz_login_pair_nodes_and_status_against_live_go_hub_through_daemon_ipc() -> TestResult {
    let hub = RunningGoHub::spawn()?;
    let tmp = TempDirGuard::new("qz_daemon_fabric_live")?;
    let qz_home = tmp.path().join("home");
    fs::create_dir_all(&qz_home)?;
    let ca_pem_path = tmp.path().join("hub_ca.pem");
    fs::write(&ca_pem_path, &hub.ca_cert_pem)?;
    assert!(hub.https_port > 0);

    // 1. 先用 disabled daemon 生成主权身份，再把同一 Agent/设备/根密钥注册到真实 Go Hub。
    {
        let mut genesis = QuetzalcoatlDaemon::start(fabric_disabled_config(&qz_home))?;
        genesis.shutdown()?;
    }
    let (agent_id, device, root_key) = read_sovereign_identity(&qz_home)?;
    let hub_token = register_daemon_agent_on_hub(&hub, agent_id, &device, &root_key)?;

    // 2. 以显式 fabric 配置重启守护进程（真实 iroh 节点 + 自建 Hub relay/QAD）。
    let mut cfg = DaemonConfig::new(qz_home.clone());
    cfg.fabric = Some(DaemonFabricConfig {
        hub_url: hub.https_url.clone(),
        hub_ca_file: Some(ca_pem_path.clone()),
        relay_url: hub.https_url.clone(),
        qad_port: hub.qad_port,
        enable_mdns: false,
        tick_interval_ms: 500,
    });
    cfg.discovery_search_paths = Some(Vec::new());
    let mut daemon = QuetzalcoatlDaemon::start(cfg)?;
    let runtime_info = daemon.runtime_info().clone();

    // 3a. `qz login --token` 令牌模式直连既有 Hub 会话（同样只落到 0600 会话文件）。
    let token_login = run_qz(
        &qz_home,
        &[
            "login",
            "--hub",
            &hub.https_url,
            "--token",
            &hub_token,
            "--json",
        ],
    )?;
    assert!(
        token_login.success,
        "qz login --token 失败: stdout={} stderr={}",
        token_login.stdout, token_login.stderr
    );
    let token_login_json: serde_json::Value = serde_json::from_str(&token_login.stdout)?;
    assert_eq!(token_login_json["auth_mode"], "token");
    assert_eq!(token_login_json["lease"], "witnessed");
    assert!(!token_login.stdout.contains(&hub_token));

    // 3b. `qz login --pin` 走 OPAQUE 零知识 3DH 并恢复根密钥校验，随后拿到 witness_epoch。
    let login = run_qz(
        &qz_home,
        &[
            "login",
            "--hub",
            &hub.https_url,
            "--ca-file",
            &ca_pem_path.to_string_lossy(),
            "--pin",
            "842619",
            "--json",
        ],
    )?;
    assert!(
        login.success,
        "qz login --pin 失败: stdout={} stderr={}",
        login.stdout, login.stderr
    );
    let login_json: serde_json::Value = serde_json::from_str(&login.stdout)?;
    assert_eq!(login_json["auth_mode"], "opaque_pin");
    assert_eq!(login_json["agent_id"], agent_id.to_string());
    assert_eq!(login_json["device_id"], device.device_id().to_string());
    assert_eq!(login_json["lease"], "witnessed");
    assert!(login_json["witness_epoch"].as_u64().unwrap_or(0) >= 1);
    assert!(!login.stdout.contains("session_token"));

    // 4. `qz status` 的 fabric 段落必须报告 Witnessed。
    let status = run_qz(&qz_home, &["status", "--json"])?;
    assert!(status.success, "{}", status.stderr);
    let status_json: serde_json::Value = serde_json::from_str(&status.stdout)?;
    assert_eq!(status_json["fabric"]["enabled"], true);
    assert_eq!(status_json["fabric"]["logged_in"], true);
    assert_eq!(status_json["fabric"]["lease"], "witnessed");
    assert!(status_json["fabric"]["witness_epoch"].as_u64().unwrap_or(0) >= 1);
    assert_eq!(status_json["fabric"]["hub_url"], hub.https_url);
    assert!(!status.stdout.contains("session_token"));

    let status_text = run_qz(&qz_home, &["status"])?;
    assert!(status_text.success);
    assert!(status_text.stdout.contains("fabric: enabled"));
    assert!(status_text.stdout.contains("Witnessed(epoch="));

    // 5. `qz nodes` 必须列出本机能力标签、路径类型与 Router 持有者。
    let nodes = run_qz(&qz_home, &["nodes", "--json"])?;
    assert!(nodes.success, "{}", nodes.stderr);
    let nodes_json: serde_json::Value = serde_json::from_str(&nodes.stdout)?;
    assert_eq!(nodes_json["enabled"], true);
    assert_eq!(
        nodes_json["local_device_id"],
        device.device_id().to_string()
    );
    assert_eq!(
        nodes_json["router_holder"],
        device.device_id().to_string(),
        "本机应持有 Router 租约"
    );
    assert!(nodes_json["witness_epoch"].as_u64().unwrap_or(0) >= 1);
    let rows = nodes_json["peers"]
        .as_array()
        .ok_or("peers must be array")?;
    let self_row = rows
        .iter()
        .find(|r| r["role"] == "self")
        .ok_or("missing self row")?;
    assert_eq!(self_row["path_kind"], "self");
    let tags: BTreeSet<String> = self_row["capability_tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    assert!(tags.contains("quetzalcoatl"), "tags={tags:?}");
    assert!(self_row["max_workers"].as_u64().unwrap_or(0) >= 1);

    let nodes_text = run_qz(&qz_home, &["nodes"])?;
    assert!(nodes_text.success);
    assert!(nodes_text.stdout.contains("router_holder:"));
    assert!(nodes_text.stdout.contains("[self]"));

    // 6. `qz pair start` 打印短码与 X-Wing HPKE 收件人公钥 bundle。
    let start = run_qz(
        &qz_home,
        &["pair", "start", "--hub", &hub.https_url, "--json"],
    )?;
    assert!(
        start.success,
        "qz pair start 失败: stdout={} stderr={}",
        start.stdout, start.stderr
    );
    let start_json: serde_json::Value = serde_json::from_str(&start.stdout)?;
    let pairing_id = start_json["pairing_id"]
        .as_str()
        .ok_or("pairing_id")?
        .to_owned();
    let short_code = start_json["short_code"]
        .as_str()
        .ok_or("short_code")?
        .to_owned();
    let pair_code = start_json["pair_code"]
        .as_str()
        .ok_or("pair_code")?
        .to_owned();
    assert_eq!(pair_code, format!("{pairing_id}.{short_code}"));
    assert!(short_code.contains('-'));
    assert_eq!(
        start_json["xwing_recipient_public_key_hex"]
            .as_str()
            .map(str::len)
            .unwrap_or(0),
        1216 * 2,
        "X-Wing 收件人公钥必须为 1216 字节"
    );
    let start_text = run_qz(&qz_home, &["pair", "start"])?;
    assert!(start_text.success, "{}", start_text.stderr);
    assert!(start_text.stdout.contains("short_code:"));
    assert!(start_text.stdout.contains("xwing_hpke_recipient_bundle:"));

    // 7. 错误短码必须类型化失败且不污染会话（随后正确短码仍可加入）。
    let mut bad_code_chars: Vec<char> = short_code.chars().collect();
    if let Some(last) = bad_code_chars.last_mut() {
        *last = if *last == 'Z' { 'Y' } else { 'Z' };
    }
    let bad_code = format!("{pairing_id}.{}", bad_code_chars.iter().collect::<String>());
    let bad_join = run_qz(
        &qz_home,
        &["pair", "join", "--hub", &hub.https_url, "--code", &bad_code],
    )?;
    assert!(!bad_join.success, "错误配对短码必须失败");
    assert!(
        bad_join.stderr.contains("CREDENTIAL_REJECTED"),
        "错误短码必须返回 CREDENTIAL_REJECTED: {}",
        bad_join.stderr
    );
    assert!(!bad_join.stderr.contains("Ack"));

    let bad_approve = run_qz(
        &qz_home,
        &[
            "pair",
            "approve",
            "--hub",
            &hub.https_url,
            "--code",
            &bad_code,
        ],
    )?;
    assert!(!bad_approve.success, "错误配对短码审批必须失败");
    assert!(
        bad_approve.stderr.contains("CREDENTIAL_REJECTED"),
        "错误短码审批必须返回 CREDENTIAL_REJECTED: {}",
        bad_approve.stderr
    );

    // 8. `qz pair join` 生成/复用待配对设备身份并完成 Hub 侧加入。
    let join = run_qz(
        &qz_home,
        &[
            "pair",
            "join",
            "--hub",
            &hub.https_url,
            "--code",
            &pair_code,
            "--json",
        ],
    )?;
    assert!(
        join.success,
        "qz pair join 失败: stdout={} stderr={}",
        join.stdout, join.stderr
    );
    let join_json: serde_json::Value = serde_json::from_str(&join.stdout)?;
    let joiner_device = join_json["joiner_device_id"]
        .as_str()
        .ok_or("joiner_device_id")?
        .to_owned();
    assert_ne!(joiner_device, device.device_id().to_string());
    assert!(
        qz_home.join("fabric/pending_joiner.json").is_file(),
        "join 必须安全落盘待配对设备身份"
    );

    // 9. `qz pair approve` 在已授权设备上完成根签名 + Slot 2 X-Wing HPKE 封装。
    let approve = run_qz(
        &qz_home,
        &[
            "pair",
            "approve",
            "--hub",
            &hub.https_url,
            "--code",
            &pair_code,
            "--json",
        ],
    )?;
    assert!(
        approve.success,
        "qz pair approve 失败: stdout={} stderr={}",
        approve.stdout, approve.stderr
    );
    let approve_json: serde_json::Value = serde_json::from_str(&approve.stdout)?;
    assert_eq!(approve_json["pairing_id"], pairing_id);
    assert_eq!(approve_json["joiner_device_id"], joiner_device);
    assert_eq!(
        approve_json["slot2_hpke_enc_hex"]
            .as_str()
            .map(str::len)
            .unwrap_or(0),
        1120 * 2,
        "Slot 2 HPKE enc 必须为 1120 字节"
    );
    assert_eq!(
        approve_json["slot2_ciphertext_hex"]
            .as_str()
            .map(str::len)
            .unwrap_or(0),
        48 * 2,
        "Slot 2 密文必须为 48 字节"
    );
    assert!(
        approve_json["slot2_aad_utf8"]
            .as_str()
            .unwrap_or("")
            .contains("qr_pairing_hpke")
    );

    // 10. 错误 PIN 必须类型化拒绝（放在最后，避免 Hub 侧尝试次数锁定影响上面正常流程）。
    let wrong_pin = run_qz(
        &qz_home,
        &["login", "--hub", &hub.https_url, "--pin", "000000"],
    )?;
    assert!(!wrong_pin.success, "错误 PIN 必须失败");
    assert!(
        wrong_pin.stderr.contains("CREDENTIAL_REJECTED"),
        "错误 PIN 必须返回 CREDENTIAL_REJECTED: {}",
        wrong_pin.stderr
    );
    assert!(!wrong_pin.stderr.contains("Ack"));

    // 11. 会话令牌绝不能出现在任何 CLI 输出中。
    let token = quetzalcoatl_daemon::load_persisted_session(&qz_home)
        .ok_or("登录后必须持久化 Hub 会话")?
        .session_token;
    for outp in [&login.stdout, &status.stdout, &nodes.stdout, &start.stdout] {
        assert!(!outp.contains(&token), "CLI 输出泄漏了 Hub 会话令牌");
    }

    let _ = runtime_info;
    daemon.shutdown()?;

    // 12. 重启续用：不再传任何 --hub，守护进程必须从 `fabric/hub_session.json` 自动恢复并重新取得 witness_epoch。
    let restarted_cfg = DaemonConfig::new(qz_home.clone());
    let restarted_fabric = restarted_cfg
        .fabric
        .clone()
        .ok_or("重启后必须从持久化会话自动启用 fabric")?;
    assert_eq!(restarted_fabric.hub_url, hub.https_url);
    let mut restarted = QuetzalcoatlDaemon::start(restarted_cfg)?;
    let restarted_status = run_qz(&qz_home, &["status", "--json"])?;
    assert!(
        restarted_status.success,
        "重启后 qz status 失败: {}",
        restarted_status.stderr
    );
    let restarted_json: serde_json::Value = serde_json::from_str(&restarted_status.stdout)?;
    assert_eq!(restarted_json["fabric"]["logged_in"], true);
    assert_eq!(restarted_json["fabric"]["lease"], "witnessed");
    assert!(
        restarted_json["fabric"]["witness_epoch"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );
    let restarted_nodes = run_qz(&qz_home, &["nodes", "--json"])?;
    assert!(restarted_nodes.success, "{}", restarted_nodes.stderr);
    restarted.shutdown()?;

    Ok(())
}

fn group_json(output: &QzOutput) -> Result<serde_json::Value, Box<dyn Error + Send + Sync>> {
    if !output.success {
        return Err(format!(
            "qz command failed: `qz {}` stdout={} stderr={}",
            output.args, output.stdout, output.stderr
        )
        .into());
    }
    Ok(serde_json::from_str(&output.stdout)?)
}

fn group_data(
    value: &serde_json::Value,
) -> Result<&serde_json::Value, Box<dyn Error + Send + Sync>> {
    value
        .get("data")
        .ok_or_else(|| "missing IpcResponse data".into())
}

fn group_fabric_config(qz_home: &Path, hub: &RunningGoHub, ca_pem: &Path) -> DaemonConfig {
    let mut cfg = DaemonConfig::new(qz_home.to_path_buf());
    cfg.fabric = Some(DaemonFabricConfig {
        hub_url: hub.https_url.clone(),
        hub_ca_file: Some(ca_pem.to_path_buf()),
        relay_url: hub.https_url.clone(),
        qad_port: hub.qad_port,
        enable_mdns: false,
        tick_interval_ms: 1_000,
    });
    cfg.discovery_search_paths = Some(Vec::new());
    cfg
}

fn login_with_token(qz_home: &Path, hub: &RunningGoHub, ca_pem: &Path, token: &str) -> TestResult {
    let out = run_qz(
        qz_home,
        &[
            "login",
            "--hub",
            &hub.https_url,
            "--ca-file",
            &ca_pem.to_string_lossy(),
            "--token",
            token,
            "--json",
        ],
    )?;
    if !out.success {
        return Err(format!("qz login --token failed: {} {}", out.stdout, out.stderr).into());
    }
    Ok(())
}

#[test]
fn group_hub_cross_boundary_e2e_create_invite_join_send_barriers_revoke() -> TestResult {
    let hub = RunningGoHub::spawn()?;
    let tmp = TempDirGuard::new("qz_group_hub_e2e")?;
    let ca_pem_path = tmp.path().join("hub_ca.pem");
    fs::write(&ca_pem_path, &hub.ca_cert_pem)?;
    let home_a = tmp.path().join("home_a");
    let home_b = tmp.path().join("home_b");
    fs::create_dir_all(&home_a)?;
    fs::create_dir_all(&home_b)?;

    // 1. 两个独立主权 Agent 先离线生成身份，再注册到真实 Go Hub。
    let (agent_a, device_a, root_a) = {
        let mut genesis = QuetzalcoatlDaemon::start(fabric_disabled_config(&home_a))?;
        genesis.shutdown()?;
        read_sovereign_identity(&home_a)?
    };
    let (agent_b, device_b, root_b) = {
        let mut genesis = QuetzalcoatlDaemon::start(fabric_disabled_config(&home_b))?;
        genesis.shutdown()?;
        read_sovereign_identity(&home_b)?
    };
    let token_a = register_daemon_agent_on_hub(&hub, agent_a, &device_a, &root_a)?;
    let token_b = register_daemon_agent_on_hub(&hub, agent_b, &device_b, &root_b)?;

    let mut daemon_a = QuetzalcoatlDaemon::start(group_fabric_config(&home_a, &hub, &ca_pem_path))?;
    let mut daemon_b = QuetzalcoatlDaemon::start(group_fabric_config(&home_b, &hub, &ca_pem_path))?;
    login_with_token(&home_a, &hub, &ca_pem_path, &token_a)?;
    login_with_token(&home_b, &hub, &ca_pem_path, &token_b)?;

    // 2. 建群（跨 Rust → Go：owner 不再被重复添加）。
    let create = run_qz(
        &home_a,
        &[
            "group", "create", "--room", "e2e-room", "--level", "1", "--json",
        ],
    )?;
    let create_json = group_json(&create)?;
    assert_eq!(group_data(&create_json)?["room_id"], "e2e-room");

    // 3. 双阶段邀请：B 出 KeyPackage，A 消费并回 Welcome，B 入群。
    let invite_b = run_qz(
        &home_b,
        &["group", "invite", "--room", "e2e-room", "--json"],
    )?;
    let invite_b_json = group_json(&invite_b)?;
    let key_package = group_data(&invite_b_json)?["key_package_b64"]
        .as_str()
        .ok_or("missing key_package_b64")?
        .to_owned();
    let add_b = run_qz(
        &home_a,
        &[
            "group",
            "invite",
            "--room",
            "e2e-room",
            "--key-package",
            &key_package,
            "--agent",
            &agent_b.to_string(),
            "--steward",
            "--json",
        ],
    )?;
    let add_b_json = group_json(&add_b)?;
    let welcome = group_data(&add_b_json)?["welcome_b64"]
        .as_str()
        .ok_or("missing welcome_b64")?
        .to_owned();
    let ratchet = group_data(&add_b_json)?["ratchet_tree_b64"]
        .as_str()
        .ok_or("missing ratchet_tree_b64")?
        .to_owned();
    let join_b = run_qz(
        &home_b,
        &[
            "group",
            "join",
            "--room",
            "e2e-room",
            "--welcome",
            &welcome,
            "--ratchet-tree",
            &ratchet,
            "--json",
        ],
    )?;
    assert!(group_json(&join_b)?.is_object());

    // 4. 第一次发送：本地纪元 1 > Hub 0，必须标记纯密钥轮换并被接受（seq=1）。
    let send1 = run_qz(
        &home_a,
        &[
            "group",
            "send",
            "--room",
            "e2e-room",
            "--text",
            "hello",
            "--to",
            &agent_a.to_string(),
            "--json",
        ],
    )?;
    let send1_json = group_json(&send1)?;
    // seq 1 是入群时发布的 MLS Commit（`mls_commit`），应用消息从 2 起。
    assert_eq!(group_data(&send1_json)?["server_seq"], 2);

    // 5. 并发发送：跨两个守护进程并发，server_seq 无缺口无重复。
    let mut handles = Vec::new();
    for idx in 0..6 {
        let home = if idx % 2 == 0 {
            home_a.clone()
        } else {
            home_b.clone()
        };
        let self_agent = if idx % 2 == 0 { agent_a } else { agent_b };
        handles.push(std::thread::spawn(move || {
            run_qz(
                &home,
                &[
                    "group",
                    "send",
                    "--room",
                    "e2e-room",
                    "--text",
                    &format!("chatter-{idx}"),
                    "--to",
                    &self_agent.to_string(),
                    "--kind",
                    "chatter",
                    "--json",
                ],
            )
        }));
    }
    let mut seqs = Vec::new();
    for handle in handles {
        let out = handle.join().map_err(|_| "sender thread panicked")??;
        let json = group_json(&out)?;
        let data = group_data(&json)?;
        if let Some(seq) = data["server_seq"].as_u64() {
            seqs.push(seq);
        } else {
            return Err(format!(
                "concurrent send failed: stdout={} stderr={}",
                out.stdout, out.stderr
            )
            .into());
        }
    }
    seqs.sort_unstable();
    assert_eq!(seqs, (3..=8).collect::<Vec<u64>>(), "unique monotonic seqs");

    // 6. 旧水位线遇到 constraint_update：必须 WATERMARK_CONFLICT。
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let hub_client_a = HubClient::new(HubClientConfig {
        base_url: hub.https_url.clone(),
        session_token: Some(token_a.clone()),
        custom_ca_certs_der: vec![hub.ca_cert_der.clone()],
    })?;
    let (_, head, epoch) = rt.block_on(hub_client_a.list_group_commits("e2e-room", 0, 200))?;
    rt.block_on(hub_client_a.append_group_commit(
        "e2e-room",
        agent_a,
        device_a.device_id(),
        epoch,
        head,
        &serde_json::json!([{"kind":"all_agents"}]),
        "Y29uc3RyYWludA==",
        "constraint_update",
        "human",
        false,
    ))?;
    let conflict = run_qz(
        &home_b,
        &[
            "group",
            "send",
            "--room",
            "e2e-room",
            "--text",
            "stale",
            "--to",
            &agent_b.to_string(),
            "--json",
        ],
    )?;
    assert!(
        !conflict.success && conflict.stderr.contains("WATERMARK_CONFLICT"),
        "expected WATERMARK_CONFLICT, got {} {}",
        conflict.stdout,
        conflict.stderr
    );
    // 心跳/同步只应用 MLS 消息，绝不消费未读语义行：sync 后必须仍处于待消费状态。
    let synced = run_qz(&home_b, &["group", "sync", "--room", "e2e-room", "--json"])?;
    let synced_json = group_json(&synced)?;
    assert!(
        !group_data(&synced_json)?["pending_semantic_group_seq"].is_null(),
        "sync must surface the unconsumed constraint instead of swallowing it"
    );
    let still_blocked = run_qz(
        &home_b,
        &[
            "group",
            "send",
            "--room",
            "e2e-room",
            "--text",
            "still-stale",
            "--to",
            &agent_b.to_string(),
            "--json",
        ],
    )?;
    assert!(
        !still_blocked.success && still_blocked.stderr.contains("WATERMARK_CONFLICT"),
        "sync alone must never clear a pending semantic row: {} {}",
        still_blocked.stdout,
        still_blocked.stderr
    );
    // 显式消费后发送恢复。
    let consumed = run_qz(
        &home_b,
        &["group", "consume", "--room", "e2e-room", "--json"],
    )?;
    assert!(group_data(&group_json(&consumed)?)?["pending_semantic_group_seq"].is_null());
    let after_sync = run_qz(
        &home_b,
        &[
            "group",
            "send",
            "--room",
            "e2e-room",
            "--text",
            "after-sync",
            "--to",
            &agent_b.to_string(),
            "--json",
        ],
    )?;
    assert!(group_json(&after_sync)?.is_object());

    // 7. A 真实轮换纪元（邀请 D）；B 未同步前必须 fail closed，sync 追平后恢复。
    let home_d = tmp.path().join("home_d");
    fs::create_dir_all(&home_d)?;
    let (agent_d, device_d, root_d) = {
        let mut genesis = QuetzalcoatlDaemon::start(fabric_disabled_config(&home_d))?;
        genesis.shutdown()?;
        read_sovereign_identity(&home_d)?
    };
    // D 必须在 Hub 注册（成员表对 agents 有外键），但只用于制造一次真实纪元轮换。
    let _token_d = register_daemon_agent_on_hub(&hub, agent_d, &device_d, &root_d)?;
    let mut fresh_d = GroupRoomRuntime::new(
        home_d,
        agent_d,
        device_d.device_id(),
        String::from("77").repeat(32),
    );
    let kp_d = fresh_d
        .invite_key_package("e2e-room")?
        .key_package_b64
        .ok_or("missing key package for D")?;
    let add_d = run_qz(
        &home_a,
        &[
            "group",
            "invite",
            "--room",
            "e2e-room",
            "--key-package",
            &kp_d,
            "--agent",
            &agent_d.to_string(),
            "--json",
        ],
    )?;
    assert!(group_json(&add_d)?.is_object());
    let stale_epoch = run_qz(
        &home_b,
        &[
            "group",
            "send",
            "--room",
            "e2e-room",
            "--text",
            "stale-epoch",
            "--to",
            &agent_b.to_string(),
            "--json",
        ],
    )?;
    assert!(
        !stale_epoch.success && stale_epoch.stderr.contains("WATERMARK_CONFLICT"),
        "member behind the hub epoch must fail closed: {} {}",
        stale_epoch.stdout,
        stale_epoch.stderr
    );
    // sync 应用真实的 MLS Commit 后，同一发送必须恢复。
    let recovered_sync = run_qz(&home_b, &["group", "sync", "--room", "e2e-room", "--json"])?;
    let recovered_json = group_json(&recovered_sync)?;
    assert_eq!(
        group_data(&recovered_json)?["mls_epoch"].as_u64(),
        Some(2),
        "sync must apply the real rotation commit"
    );
    let recovered = run_qz(
        &home_b,
        &[
            "group",
            "send",
            "--room",
            "e2e-room",
            "--text",
            "recovered",
            "--to",
            &agent_b.to_string(),
            "--json",
        ],
    )?;
    assert!(
        recovered.success,
        "sync must recover a member that was behind: {} {}",
        recovered.stdout, recovered.stderr
    );

    // 8. Hub 黑洞时 Status 仍 <500ms（全局状态锁不得跨网络 I/O）。
    hub.pause()?;
    let home_for_send = home_a.clone();
    let agent_for_send = agent_a;
    let blocked_send = std::thread::spawn(move || {
        run_qz(
            &home_for_send,
            &[
                "group",
                "send",
                "--room",
                "e2e-room",
                "--text",
                "blocked",
                "--to",
                &agent_for_send.to_string(),
            ],
        )
    });
    std::thread::sleep(Duration::from_millis(300));
    let status_started = Instant::now();
    let ipc_status = {
        let client =
            IpcClient::from_runtime_info(daemon_a.runtime_info(), daemon_a.ipc_token().to_owned());
        client.call(&IpcRequest::Status)?
    };
    let status_elapsed = status_started.elapsed();
    hub.resume()?;
    let _ = blocked_send.join();
    assert!(
        matches!(ipc_status, IpcResponse::Status(_)),
        "status must stay responsive while group send blocks"
    );
    assert!(
        status_elapsed < Duration::from_millis(500),
        "status blocked for {status_elapsed:?} during group Hub I/O"
    );

    // 9. 吊销协管：MLS 踢人 + 纪元轮换 + Hub 成员行删除 → 被踢成员提交 403。
    let revoke = run_qz(
        &home_a,
        &[
            "group",
            "revoke-steward",
            "--room",
            "e2e-room",
            "--identity",
            &format!("agent:{agent_b}"),
            "--json",
        ],
    )?;
    let revoke_json = group_json(&revoke)?;
    assert_eq!(group_data(&revoke_json)?["dropped_management_rights"], true);
    let kicked = run_qz(
        &home_b,
        &[
            "group",
            "send",
            "--room",
            "e2e-room",
            "--text",
            "still-here?",
            "--to",
            &agent_b.to_string(),
            "--json",
        ],
    )?;
    assert!(
        !kicked.success && kicked.stderr.contains("PERMISSION_DENIED"),
        "kicked member must be denied by Hub: {} {}",
        kicked.stdout,
        kicked.stderr
    );

    // 10. leave：本地 MLS 自移除 + Hub 成员行删除。
    let leave_b = run_qz(&home_b, &["group", "leave", "--room", "e2e-room", "--json"])?;
    assert_eq!(group_data(&group_json(&leave_b)?)?["left"], true);
    let list_b = run_qz(&home_b, &["group", "list", "--json"])?;
    assert_eq!(
        group_data(&group_json(&list_b)?)?
            .as_array()
            .map_or(1, Vec::len),
        0,
        "left room must disappear locally"
    );

    daemon_a.shutdown()?;
    daemon_b.shutdown()?;
    Ok(())
}

#[test]
fn group_mls_commit_distribution_lets_offline_member_catch_up() -> TestResult {
    // 验收：A/B/C 三人，B 离线期间被 A 踢出并轮换纪元；C 离线 → 重连 sync →
    // 应用 mls_commit 追平纪元、能解密新消息，而 B 不能；随后 C 重试发送成功。
    let hub = RunningGoHub::spawn()?;
    let tmp = TempDirGuard::new("qz_group_mls_dist")?;
    let ca_pem_path = tmp.path().join("hub_ca.pem");
    fs::write(&ca_pem_path, &hub.ca_cert_pem)?;

    let mut homes = Vec::new();
    let mut agents = Vec::new();
    let mut devices = Vec::new();
    let mut tokens = Vec::new();
    for tag in ["a", "b", "c"] {
        let home = tmp.path().join(format!("home_{tag}"));
        fs::create_dir_all(&home)?;
        let (agent, device, root) = {
            let mut genesis = QuetzalcoatlDaemon::start(fabric_disabled_config(&home))?;
            genesis.shutdown()?;
            read_sovereign_identity(&home)?
        };
        let token = register_daemon_agent_on_hub(&hub, agent, &device, &root)?;
        homes.push(home);
        agents.push(agent);
        devices.push(device);
        tokens.push(token);
    }
    let (home_a, home_b, home_c) = (homes[0].clone(), homes[1].clone(), homes[2].clone());
    let (agent_a, agent_b, agent_c) = (agents[0], agents[1], agents[2]);

    let mut daemon_a = QuetzalcoatlDaemon::start(group_fabric_config(&home_a, &hub, &ca_pem_path))?;
    let mut daemon_b = QuetzalcoatlDaemon::start(group_fabric_config(&home_b, &hub, &ca_pem_path))?;
    let mut daemon_c = QuetzalcoatlDaemon::start(group_fabric_config(&home_c, &hub, &ca_pem_path))?;
    for (home, token) in [
        (&home_a, &tokens[0]),
        (&home_b, &tokens[1]),
        (&home_c, &tokens[2]),
    ] {
        login_with_token(home, &hub, &ca_pem_path, token)?;
    }

    let create = run_qz(
        &home_a,
        &[
            "group",
            "create",
            "--room",
            "dist-room",
            "--level",
            "1",
            "--json",
        ],
    )?;
    assert_eq!(group_data(&group_json(&create)?)?["room_id"], "dist-room");

    // B 以协管身份入群（后续由 A 吊销并踢出）。
    for (home_invitee, agent) in [(&home_b, agent_b), (&home_c, agent_c)] {
        let invite = run_qz(
            home_invitee,
            &["group", "invite", "--room", "dist-room", "--json"],
        )?;
        let invite_json = group_json(&invite)?;
        let key_package = group_data(&invite_json)?["key_package_b64"]
            .as_str()
            .ok_or("missing key_package_b64")?
            .to_owned();
        let agent_arg = agent.to_string();
        let mut add_args = vec![
            "group",
            "invite",
            "--room",
            "dist-room",
            "--key-package",
            &key_package,
            "--agent",
            &agent_arg,
            "--json",
        ];
        if agent == agent_b {
            add_args.push("--steward");
        }
        let add = run_qz(&home_a, &add_args)?;
        let add_json = group_json(&add)?;
        let welcome = group_data(&add_json)?["welcome_b64"]
            .as_str()
            .ok_or("missing welcome_b64")?
            .to_owned();
        let ratchet = group_data(&add_json)?["ratchet_tree_b64"]
            .as_str()
            .ok_or("missing ratchet_tree_b64")?
            .to_owned();
        let join = run_qz(
            home_invitee,
            &[
                "group",
                "join",
                "--room",
                "dist-room",
                "--welcome",
                &welcome,
                "--ratchet-tree",
                &ratchet,
                "--json",
            ],
        )?;
        assert!(group_json(&join)?.is_object());
    }

    // B、C 双双离线：它们的本机状态冻结在当前纪元。
    daemon_b.shutdown()?;
    daemon_c.shutdown()?;

    let revoke = run_qz(
        &home_a,
        &[
            "group",
            "revoke-steward",
            "--room",
            "dist-room",
            "--identity",
            &format!("agent:{agent_b}"),
            "--json",
        ],
    )?;
    assert_eq!(
        group_data(&group_json(&revoke)?)?["dropped_management_rights"],
        true
    );

    let sent = run_qz(
        &home_a,
        &[
            "group",
            "send",
            "--room",
            "dist-room",
            "--text",
            "after-kick",
            "--to",
            &agent_a.to_string(),
            "--json",
        ],
    )?;
    let sent_json = group_json(&sent)?;
    let posted = group_data(&sent_json)?;
    let ciphertext = posted["ciphertext_b64"]
        .as_str()
        .ok_or("missing ciphertext_b64 from A")?
        .to_owned();
    let kicked_epoch = posted["mls_epoch"].as_u64().ok_or("missing mls_epoch")?;
    assert!(
        kicked_epoch >= 3,
        "kick must rotate the epoch, got {kicked_epoch}"
    );

    // C 重新上线：sync 必须应用 mls_commit 追平纪元。
    let mut daemon_c = QuetzalcoatlDaemon::start(group_fabric_config(&home_c, &hub, &ca_pem_path))?;
    let sync = run_qz(&home_c, &["group", "sync", "--room", "dist-room", "--json"])?;
    let sync_json = group_json(&sync)?;
    assert_eq!(
        group_data(&sync_json)?["mls_epoch"].as_u64(),
        Some(kicked_epoch),
        "sync must apply the distributed MLS commit and reach the author's epoch"
    );
    assert!(
        !group_data(&sync_json)?["members"]
            .as_array()
            .map(|members| members
                .iter()
                .any(|m| m.as_str().is_some_and(|s| s.contains(&agent_b.to_string()))))
            .unwrap_or(false),
        "kicked member must be gone from C's roster after sync"
    );

    // C 能解密 A 的新消息（B 不能，见下）。
    let read = run_qz(
        &home_c,
        &[
            "group",
            "read",
            "--room",
            "dist-room",
            "--ciphertext",
            &ciphertext,
        ],
    )?;
    assert!(read.success, "C must decrypt after sync: {}", read.stderr);
    assert!(
        read.stdout.contains("after-kick"),
        "unexpected plaintext: {}",
        read.stdout
    );

    // 9. 真正的“失败 → 消费 → 重试”：对端先写入语义约束，C 的发送必须冲突；
    //    显式消费未读水位线后同一条发送必须成功（证明冲突恢复可用，而非首次发送成功）。
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let hub_client_a = HubClient::new(HubClientConfig {
        base_url: hub.https_url.clone(),
        session_token: Some(tokens[0].clone()),
        custom_ca_certs_der: vec![hub.ca_cert_der.clone()],
    })?;
    let (_, head_now, epoch_now) =
        rt.block_on(hub_client_a.list_group_commits("dist-room", 0, 200))?;
    rt.block_on(hub_client_a.append_group_commit(
        "dist-room",
        agent_a,
        devices[0].device_id(),
        epoch_now,
        head_now,
        &serde_json::json!([{"kind":"all_agents"}]),
        "Y29uc3RyYWludA==",
        "constraint_update",
        "human",
        false,
    ))?;
    let blocked = run_qz(
        &home_c,
        &[
            "group",
            "send",
            "--room",
            "dist-room",
            "--text",
            "c-blocked",
            "--to",
            &agent_c.to_string(),
            "--json",
        ],
    )?;
    assert!(
        !blocked.success && blocked.stderr.contains("WATERMARK_CONFLICT"),
        "unconsumed constraint must block sending: {} {}",
        blocked.stdout,
        blocked.stderr
    );
    let consumed = run_qz(
        &home_c,
        &["group", "consume", "--room", "dist-room", "--json"],
    )?;
    assert!(
        group_data(&group_json(&consumed)?)?["pending_semantic_group_seq"].is_null(),
        "consume must clear the pending semantic row"
    );
    let retry = run_qz(
        &home_c,
        &[
            "group",
            "send",
            "--room",
            "dist-room",
            "--text",
            "c-catch-up",
            "--to",
            &agent_c.to_string(),
            "--json",
        ],
    )?;
    assert!(
        retry.success,
        "C must send after consuming the pending constraint: {} {}",
        retry.stdout, retry.stderr
    );

    // B 已被踢出：即使重新上线并恢复到旧纪元，也绝解不开新纪元消息。
    daemon_c.shutdown()?;
    let mut daemon_b = QuetzalcoatlDaemon::start(group_fabric_config(&home_b, &hub, &ca_pem_path))?;
    let b_read = run_qz(
        &home_b,
        &[
            "group",
            "read",
            "--room",
            "dist-room",
            "--ciphertext",
            &ciphertext,
        ],
    )?;
    assert!(
        !b_read.success,
        "kicked member must not decrypt post-rotation traffic: {}",
        b_read.stdout
    );
    // 失败必须是类型化错误（纪元/解密失败或已被撤销权限），而不是静默成功。
    assert!(
        b_read.stderr.contains("INTEGRITY_VIOLATION")
            || b_read.stderr.contains("PERMISSION_DENIED"),
        "expected a typed decryption/permission error, got: {}",
        b_read.stderr
    );
    // B 的本机房间仍然存在（只是无法解密新纪元流量），不得被静默删除。
    let list_b = run_qz(&home_b, &["group", "list", "--json"])?;
    let b_rooms = group_json(&list_b)?;
    assert!(
        group_data(&b_rooms)?
            .as_array()
            .is_some_and(|rooms| rooms.iter().any(|room| room["room_id"] == "dist-room")),
        "kicked member must keep its local room entry"
    );
    daemon_b.shutdown()?;
    daemon_a.shutdown()?;
    let _ = devices;
    Ok(())
}

#[test]
fn go_hub_binary_cache_is_bounded_to_one_copy() -> TestResult {
    // 生命周期：构建 1 份主副本 → 每次 spawn 用唯一副本（spawn 后立即 unlink）
    // → 进程内始终只有 1 份；死 PID 与旧共享路径在下次启动被清理。
    let dir = std::env::temp_dir().join(format!("qz-hub-cache-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir)?;
    let prefix = format!("quetzalcoatl-hub-{}-", std::process::id());
    let count = |dir: &Path| -> usize {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
                    .count()
            })
            .unwrap_or(0)
    };

    let master = dir.join(hub_bin_name());
    build_hub_binary(&master)?;
    assert_eq!(count(&dir), 1, "build must leave exactly one master copy");

    let run_copy = spawn_copy_of_hub_binary(&master)?;
    assert_eq!(count(&dir), 2, "spawn uses a private copy");
    let mut child = Command::new(&run_copy)
        .env("QUETZALCOATL_HUB_ADDR", "127.0.0.1:0")
        .env("QUETZALCOATL_HUB_DATA_DIR", dir.join("hub-data"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    fs::remove_file(&run_copy)?;
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(count(&dir), 1, "only the master copy may remain in-process");

    let stale = dir.join("quetzalcoatl-hub-999999-deadbeef");
    fs::write(&stale, b"stale")?;
    let legacy = dir.join("quetzalcoatl-hub");
    fs::write(&legacy, b"legacy")?;
    prune_stale_hub_binaries(&dir);
    assert!(!stale.exists(), "dead-pid copies must be pruned");
    assert!(!legacy.exists(), "legacy shared-path copy must be pruned");
    let _ = fs::remove_file(&master);
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
