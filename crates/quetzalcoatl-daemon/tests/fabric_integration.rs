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
    DaemonConfig, DaemonFabricConfig, IpcClient, IpcRequest, IpcResponse, QuetzalcoatlDaemon,
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

fn repo_root() -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("cannot locate workspace root")?;
    Ok(root.to_path_buf())
}

fn compiled_go_hub_binary() -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
    static HUB_BIN: OnceLock<std::result::Result<PathBuf, String>> = OnceLock::new();
    let cached = HUB_BIN.get_or_init(|| {
        let root = match repo_root() {
            Ok(r) => r,
            Err(e) => return Err(e.to_string()),
        };
        let out_dir = PathBuf::from("/tmp/opencode/qz_go_hub_bin_cache");
        if let Err(e) = fs::create_dir_all(&out_dir) {
            return Err(format!("create hub bin cache dir failed: {e}"));
        }
        let bin_path = out_dir.join(format!("quetzalcoatl-hub-daemon-{}", std::process::id()));
        let output = Command::new("go")
            .current_dir(root.join("hub"))
            .env("CGO_ENABLED", "0")
            .args([
                "build",
                "-o",
                &bin_path.to_string_lossy(),
                "./cmd/quetzalcoatl-hub",
            ])
            .output();
        match output {
            Ok(o) if o.status.success() => Ok(bin_path),
            Ok(o) => Err(format!(
                "go build quetzalcoatl-hub failed: {}",
                String::from_utf8_lossy(&o.stderr)
            )),
            Err(e) => Err(format!("spawn go build failed: {e}")),
        }
    });
    match cached {
        Ok(p) => Ok(p.clone()),
        Err(msg) => Err(msg.clone().into()),
    }
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
        let bin = compiled_go_hub_binary()?;
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
