#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Fix Round 1 守护进程回归：
//! - Important #3：Hub 黑洞不可达时心跳在飞，`Status` 仍须在毫秒级返回（内核锁绝不跨网络 I/O）；
//! - Important #4：`qz pair approve` 后新设备真实加入本地 `EpochKeyRing` 并可握手，`qz pair revoke` 后立即被拒；
//! - Important #5：优雅退出时把 `witness_epoch` 主动移交给在线对等节点。

use std::error::Error;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use iroh::EndpointAddr;
use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, DevicePublicRecord, EpochKey, EpochKeyRing,
};
use quetzalcoatl_daemon::{
    DaemonConfig, DaemonFabricConfig, IpcClient, IpcRequest, IpcResponse, QuetzalcoatlDaemon,
};
use quetzalcoatl_fabric::{
    FabricNode, FabricNodeConfig, FabricRelaySettings, FabricRpcHandler, FabricRpcRequest,
    FabricRpcResponse, HubClient, HubClientConfig,
};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose, SanType,
};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;
type BoxError = Box<dyn Error + Send + Sync>;

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

fn repo_root() -> Result<PathBuf, BoxError> {
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

fn compiled_go_hub_binary() -> Result<PathBuf, BoxError> {
    static HUB_BIN: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    let cached = HUB_BIN.get_or_init(|| {
        let out_dir = PathBuf::from("/tmp/opencode/qz_go_hub_bin_cache");
        fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
        // 进程唯一路径：并行 runner 不会互相覆盖/exec 同一文件，也不会无界累积。
        prune_stale_hub_binaries(&out_dir);
        let bin_path = out_dir.join(hub_bin_name());
        build_hub_binary(&bin_path).map(|()| bin_path)
    });
    let path = match cached {
        Ok(p) => p.clone(),
        Err(msg) => return Err(msg.clone().into()),
    };
    if !path.exists() {
        // 上一次 spawn 后已 unlink 运行中的二进制：按需重建到同一路径。
        build_hub_binary(&path)?;
    }
    Ok(path)
}

/// 为单次 spawn 复制一份唯一可执行文件：并行测试绝不共享同一 inode/路径。
fn spawn_copy_of_hub_binary(master: &Path) -> Result<PathBuf, BoxError> {
    let unique = format!(
        "{}-run-{}",
        master.file_name().and_then(|n| n.to_str()).unwrap_or("hub"),
        Uuid::new_v4()
    );
    let path = master.with_file_name(unique);
    fs::copy(master, &path)?;
    Ok(path)
}

fn reserve_tcp_port() -> Result<u16, BoxError> {
    Ok(
        TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?
            .local_addr()?
            .port(),
    )
}

fn reserve_udp_port() -> Result<u16, BoxError> {
    Ok(UdpSocket::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?
        .local_addr()?
        .port())
}

struct TestPki {
    ca_cert_der: Vec<u8>,
    ca_cert_pem: String,
    server_cert_pem: String,
    server_key_pem: String,
}

fn generate_pki() -> Result<TestPki, BoxError> {
    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let mut ca_dn = DistinguishedName::new();
    ca_dn.push(DnType::CommonName, "Quetzalcoatl Membership Test CA");
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

struct RunningGoHub {
    _tmp: TempDirGuard,
    https_url: String,
    qad_port: u16,
    ca_cert_der: Vec<u8>,
    ca_cert_pem: String,
    child: Child,
}

impl RunningGoHub {
    fn spawn() -> Result<Self, BoxError> {
        let master = compiled_go_hub_binary()?;
        let bin = spawn_copy_of_hub_binary(&master)?;
        let tmp = TempDirGuard::new("qz_daemon_membership_hub")?;
        let data_dir = tmp.path().join("hub_data");
        fs::create_dir_all(&data_dir)?;
        let pki = generate_pki()?;
        let cert_path = tmp.path().join("server_cert.pem");
        let key_path = tmp.path().join("server_key.pem");
        fs::write(&cert_path, &pki.server_cert_pem)?;
        fs::write(&key_path, &pki.server_key_pem)?;

        let https_port = reserve_tcp_port()?;
        let qad_port = reserve_udp_port()?;
        let https_url = format!("https://127.0.0.1:{https_port}");

        let log_path = tmp.path().join("hub.log");
        let log_file = fs::File::create(&log_path)?;
        let log_err = log_file.try_clone()?;
        let mut child = Command::new(&bin)
            .env("QUETZALCOATL_HUB_ADDR", format!("127.0.0.1:{https_port}"))
            .env("QUETZALCOATL_HUB_QAD_ADDR", format!("127.0.0.1:{qad_port}"))
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
        // 二进制已映射进进程：立即 unlink，运行结束后不留副本。
        let _ = fs::remove_file(&bin);

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Some(exit) = child.try_wait()? {
                let logs = fs::read_to_string(&log_path).unwrap_or_default();
                return Err(format!("hub exited early ({exit}): {logs}").into());
            }
            if TcpStream::connect_timeout(
                &SocketAddr::from((Ipv4Addr::LOCALHOST, https_port)),
                Duration::from_millis(50),
            )
            .is_ok()
            {
                return Ok(Self {
                    _tmp: tmp,
                    https_url,
                    qad_port,
                    ca_cert_der: pki.ca_cert_der,
                    ca_cert_pem: pki.ca_cert_pem,
                    child,
                });
            }
            thread::sleep(Duration::from_millis(30));
        }
        let _ = child.kill();
        Err("hub did not listen in 15s".into())
    }
}

impl RunningGoHub {
    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for RunningGoHub {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn hex32(raw: &str) -> Result<[u8; 32], BoxError> {
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

struct SovereignIdentity {
    agent_id: AgentId,
    device: DeviceIdentity,
    root_key: AccountRootKey,
    epoch1_key: [u8; 32],
}

fn read_sovereign_identity(qz_home: &Path) -> Result<SovereignIdentity, BoxError> {
    let raw = fs::read(qz_home.join("identity/sovereign_state.json"))?;
    let val: serde_json::Value = serde_json::from_slice(&raw)?;
    let agent_id: AgentId = val["agent_id"]
        .as_str()
        .ok_or("missing agent_id")?
        .parse()?;
    let device_id: DeviceId = val["device_id"]
        .as_str()
        .ok_or("missing device_id")?
        .parse()?;
    let ed = hex32(val["ed25519_seed_hex"].as_str().ok_or("seed")?)?;
    let xw = hex32(val["xwing_seed_hex"].as_str().ok_or("xwing seed")?)?;
    let root = hex32(val["root_key_hex"].as_str().ok_or("root")?)?;
    let epoch1 = hex32(val["epoch1_key_hex"].as_str().ok_or("epoch1")?)?;
    Ok(SovereignIdentity {
        agent_id,
        device: DeviceIdentity::from_seeds(device_id, ed, xw)?,
        root_key: AccountRootKey::from_bytes(root),
        epoch1_key: epoch1,
    })
}

fn register_agent_on_hub(
    hub: &RunningGoHub,
    agent_id: AgentId,
    device: &DeviceIdentity,
    root_key: &AccountRootKey,
) -> Result<(), BoxError> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let anon = HubClient::new(HubClientConfig {
        base_url: hub.https_url.clone(),
        session_token: None,
        custom_ca_certs_der: vec![hub.ca_cert_der.clone()],
    })?;
    let mut last_err: Option<String> = None;
    for _ in 0..20 {
        match rt.block_on(anon.register_agent_with_eddsa_passkey(agent_id, device, root_key)) {
            Ok(session) => {
                rt.block_on(
                    anon.with_session_token(session.session_token)
                        .register_opaque_pin(agent_id, b"842619", root_key),
                )?;
                return Ok(());
            }
            Err(e) => {
                last_err = Some(e.to_string());
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(format!("hub registration failed: {}", last_err.unwrap_or_default()).into())
}

fn qz(args: &[&str], qz_home: &Path) -> Result<(bool, String, String), BoxError> {
    let out = Command::new(PathBuf::from(env!("CARGO_BIN_EXE_qz")))
        .env("QUETZALCOATL_HOME", qz_home)
        .args(args)
        .output()?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

fn run_json(args: &[&str], qz_home: &Path) -> Result<serde_json::Value, BoxError> {
    let (ok, stdout, stderr) = qz(args, qz_home)?;
    if !ok {
        return Err(format!("qz {args:?} failed: {stderr}").into());
    }
    Ok(serde_json::from_str(&stdout)?)
}

fn bootstrap_identity(qz_home: &Path, hub: &RunningGoHub) -> Result<SovereignIdentity, BoxError> {
    {
        let mut genesis = QuetzalcoatlDaemon::start(disabled_config(qz_home))?;
        genesis.shutdown()?;
    }
    let identity = read_sovereign_identity(qz_home)?;
    register_agent_on_hub(hub, identity.agent_id, &identity.device, &identity.root_key)?;
    Ok(identity)
}

fn disabled_config(qz_home: &Path) -> DaemonConfig {
    let mut cfg = DaemonConfig::new(qz_home.to_path_buf());
    cfg.fabric = None;
    cfg
}

fn fabric_config(qz_home: &Path, hub: &RunningGoHub, ca_pem: &Path) -> DaemonConfig {
    let mut cfg = DaemonConfig::new(qz_home.to_path_buf());
    cfg.fabric = Some(DaemonFabricConfig {
        hub_url: hub.https_url.clone(),
        hub_ca_file: Some(ca_pem.to_path_buf()),
        relay_url: hub.https_url.clone(),
        qad_port: hub.qad_port,
        enable_mdns: false,
        tick_interval_ms: 500,
    });
    cfg.discovery_search_paths = Some(Vec::new());
    cfg
}

fn login_with_pin(qz_home: &Path, hub: &RunningGoHub) -> Result<(), BoxError> {
    let (ok, _out, err) = qz(
        &[
            "login",
            "--hub",
            &hub.https_url,
            "--pin",
            "842619",
            "--json",
        ],
        qz_home,
    )?;
    if !ok {
        return Err(format!("qz login failed: {err}").into());
    }
    Ok(())
}

/// 让 daemon 与 joiner 都可用的同一 Agent 纪元环（含 epoch1 与双方设备）。
fn membership_ring(
    identity: &SovereignIdentity,
    extra_device: &DevicePublicRecord,
) -> Result<EpochKeyRing, BoxError> {
    let mut ring = EpochKeyRing::new_genesis(
        identity.agent_id,
        &identity.root_key,
        identity.device.public_record(),
    )?;
    ring.insert_epoch_key(Epoch::new(1), EpochKey::from_bytes(identity.epoch1_key));
    let _ = ring.add_device(&identity.root_key, extra_device.clone())?;
    Ok(ring)
}

fn read_pending_joiner(qz_home: &Path) -> Result<DeviceIdentity, BoxError> {
    let raw = fs::read(qz_home.join("fabric/pending_joiner.json"))?;
    let val: serde_json::Value = serde_json::from_slice(&raw)?;
    let device_id: DeviceId = val["device_id"].as_str().ok_or("joiner device")?.parse()?;
    let ed = hex32(val["ed25519_seed_hex"].as_str().ok_or("joiner seed")?)?;
    let xw = hex32(val["xwing_seed_hex"].as_str().ok_or("joiner xwing")?)?;
    Ok(DeviceIdentity::from_seeds(device_id, ed, xw)?)
}

fn relay_settings(hub: &RunningGoHub) -> FabricRelaySettings {
    FabricRelaySettings {
        relay_url: hub.https_url.clone(),
        qad_port: hub.qad_port,
        auth_token: None,
        custom_ca_certs_der: vec![hub.ca_cert_der.clone()],
    }
}

fn daemon_endpoint_id_hex(client: &IpcClient) -> Result<String, BoxError> {
    match client.call(&IpcRequest::Status)? {
        IpcResponse::Status(st) => st
            .fabric
            .endpoint_id_hex
            .ok_or_else(|| "status 缺少 fabric endpoint_id_hex".into()),
        other => Err(format!("unexpected status: {other:?}").into()),
    }
}

fn relay_addr(endpoint_hex: &str, hub: &RunningGoHub) -> Result<EndpointAddr, BoxError> {
    let id = iroh::EndpointId::from_str(endpoint_hex)?;
    Ok(EndpointAddr::new(id).with_relay_url(hub.https_url.parse()?))
}

/// 记录优雅退出移交请求的对等节点处理器。
struct HandoffProbe {
    seen: Arc<AtomicBool>,
    counter: Arc<AtomicUsize>,
    local_device: DeviceId,
    accepted_epoch: u64,
}

impl FabricRpcHandler for HandoffProbe {
    fn handle_rpc(
        &self,
        _authenticated_peer_device: DeviceId,
        req: FabricRpcRequest,
    ) -> FabricRpcResponse {
        match req {
            FabricRpcRequest::VoluntaryLeaseHandoff { .. } => {
                self.seen.store(true, Ordering::SeqCst);
                self.counter.fetch_add(1, Ordering::SeqCst);
                FabricRpcResponse::LeaseHandoffAccepted {
                    new_holder_device_id: self.local_device,
                    new_witness_epoch: self.accepted_epoch,
                }
            }
            FabricRpcRequest::Ping { .. } => FabricRpcResponse::Pong {
                responder_device_id: self.local_device,
                capability: None,
            },
            _ => FabricRpcResponse::Error {
                code: String::from("PERMISSION_DENIED"),
                detail: String::from("unsupported op in handoff probe"),
            },
        }
    }
}

#[test]
fn unreachable_hub_keeps_daemon_status_responsive_while_tick_is_in_flight() -> TestResult {
    let tmp = TempDirGuard::new("qz_daemon_fabric_responsive")?;
    let qz_home = tmp.path().join("home");
    fs::create_dir_all(&qz_home)?;

    // 1. 黑洞 Hub：接受 TCP 连接但永不响应 TLS 握手，让 Hub 调用一直挂到 3s 硬超时。
    let blackhole = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    let blackhole_port = blackhole.local_addr()?.port();
    let keep_alive: Arc<std::sync::Mutex<Vec<TcpStream>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let keep_clone = Arc::clone(&keep_alive);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);
    blackhole.set_nonblocking(true)?;
    let accept_thread = thread::spawn(move || {
        while !stop_clone.load(Ordering::Relaxed) {
            match blackhole.accept() {
                Ok((stream, _)) => {
                    if let Ok(mut guard) = keep_clone.lock() {
                        guard.push(stream);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    // 2. 生成身份并伪造一份已登录会话（仅用于驱动心跳，Hub 永远不可达）。
    {
        let mut genesis = QuetzalcoatlDaemon::start(disabled_config(&qz_home))?;
        genesis.shutdown()?;
    }
    let identity = read_sovereign_identity(&qz_home)?;
    let blackhole_url = format!("https://127.0.0.1:{blackhole_port}");
    let session = serde_json::json!({
        "hub_url": blackhole_url,
        "hub_ca_file": null,
        "relay_url": blackhole_url,
        "qad_port": 7842,
        "session_token": "synthetic-token-for-responsiveness-probe",
        "account_id": "synthetic",
        "agent_id": identity.agent_id.to_string(),
        "device_id": identity.device.device_id().to_string(),
    });
    fs::create_dir_all(qz_home.join("fabric"))?;
    fs::write(
        qz_home.join("fabric/hub_session.json"),
        serde_json::to_vec_pretty(&session)?,
    )?;

    let mut cfg = DaemonConfig::new(qz_home.clone());
    cfg.fabric = Some(DaemonFabricConfig {
        hub_url: blackhole_url.clone(),
        hub_ca_file: None,
        relay_url: blackhole_url,
        qad_port: 7842,
        enable_mdns: false,
        tick_interval_ms: 300,
    });
    cfg.discovery_search_paths = Some(Vec::new());
    let mut daemon = QuetzalcoatlDaemon::start(cfg)?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());

    // 3. 至少覆盖两个心跳周期：轮询 Status 并在有心跳在飞时断言毫秒级响应。
    let sample_deadline = Instant::now() + Duration::from_secs(12);
    let mut max_latency = Duration::ZERO;
    let mut samples = 0usize;
    while Instant::now() < sample_deadline {
        let started = Instant::now();
        match client.call(&IpcRequest::Status)? {
            IpcResponse::Status(_) => {}
            other => return Err(format!("unexpected status response: {other:?}").into()),
        }
        let elapsed = started.elapsed();
        max_latency = max_latency.max(elapsed);
        samples += 1;
        thread::sleep(Duration::from_millis(20));
    }
    assert!(samples > 100, "采样次数过少: {samples}");
    assert!(
        max_latency < Duration::from_millis(500),
        "Hub 不可达时 Status 必须保持毫秒级响应（实测最大 {max_latency:?}）；内核锁严禁跨网络 I/O"
    );

    // 4. 心跳确实执行过（失败并被降级为分区受限），证明确有网络 tick 在采样期间发生。
    match client.call(&IpcRequest::Status)? {
        IpcResponse::Status(st) => {
            assert_eq!(st.fabric.lease, "partition_local");
            assert!(st.fabric.witness_epoch.is_none());
        }
        other => return Err(format!("unexpected status: {other:?}").into()),
    }

    daemon.shutdown()?;
    stop.store(true, Ordering::Relaxed);
    let _ = accept_thread.join();
    Ok(())
}

#[test]
fn paired_device_is_authorized_locally_and_revocation_refuses_it_at_runtime() -> TestResult {
    let hub = RunningGoHub::spawn()?;
    let tmp = TempDirGuard::new("qz_daemon_membership")?;
    let qz_home = tmp.path().join("home");
    fs::create_dir_all(&qz_home)?;
    let ca_pem = tmp.path().join("hub_ca.pem");
    fs::write(&ca_pem, &hub.ca_cert_pem)?;

    let identity = bootstrap_identity(&qz_home, &hub)?;
    let mut daemon = QuetzalcoatlDaemon::start(fabric_config(&qz_home, &hub, &ca_pem))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    login_with_pin(&qz_home, &hub)?;

    // 1. 完成配对 start → join → approve。
    let start = run_json(
        &["pair", "start", "--hub", &hub.https_url, "--json"],
        &qz_home,
    )?;
    let pair_code = start["pair_code"].as_str().ok_or("pair_code")?.to_owned();
    let _ = run_json(
        &[
            "pair",
            "join",
            "--hub",
            &hub.https_url,
            "--code",
            &pair_code,
            "--json",
        ],
        &qz_home,
    )?;
    let approve = run_json(
        &[
            "pair",
            "approve",
            "--hub",
            &hub.https_url,
            "--code",
            &pair_code,
            "--json",
        ],
        &qz_home,
    )?;
    let joiner_device_id = approve["joiner_device_id"]
        .as_str()
        .ok_or("joiner_device_id")?
        .to_owned();
    let joiner = read_pending_joiner(&qz_home)?;
    assert_eq!(joiner.device_id().to_string(), joiner_device_id);

    // 2. 新设备必须被本地 EpochKeyRing 接受：真实 iroh 握手 Ping 成功。
    let ring = membership_ring(&identity, &joiner.public_record())?;
    // 该运行时必须与 FabricNode 同寿命存活（Drop 运行时会终止 iroh 后台任务）。
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let joiner_node = rt.block_on(FabricNode::bind(
        FabricNodeConfig {
            agent_id: identity.agent_id,
            device: joiner.clone(),
            epoch_ring: ring,
            bind_ipv4: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
            enable_mdns: false,
            discover_overlay_interfaces: false,
            relay: Some(relay_settings(&hub)),
            local_capabilities: None,
        },
        None,
    ))?;
    let daemon_ep = daemon_endpoint_id_hex(&client)?;
    let daemon_addr = relay_addr(&daemon_ep, &hub)?;
    joiner_node.register_peer_addr(daemon_addr.clone());
    let mut pong = None;
    let mut last_err = None;
    for attempt in 0..20 {
        match rt.block_on(joiner_node.send_rpc(
            daemon_addr.clone(),
            &FabricRpcRequest::Ping {
                agent_id: identity.agent_id,
                sender_device_id: joiner.device_id(),
            },
        )) {
            Ok(resp) => {
                pong = Some(resp);
                break;
            }
            Err(e) => {
                last_err = Some(e);
                if attempt < 19 {
                    thread::sleep(Duration::from_millis(250));
                }
            }
        }
    }
    let pong = pong.ok_or_else(|| {
        format!(
            "approved 新设备始终无法握手: {}",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| String::from("unknown"))
        )
    })?;
    assert!(
        matches!(pong, FabricRpcResponse::Pong { .. }),
        "approved 新设备必须被 SovereignAuthHook 放行: {pong:?}"
    );

    // 3. 踢人：本地轮换纪元并持久化，随后运行时必须拒斥该设备。
    match client.call(&IpcRequest::FabricRevokeDevice {
        device_id: joiner.device_id(),
    })? {
        IpcResponse::FabricRevokeDevice(res) => {
            assert_eq!(res.device_id, joiner.device_id());
            assert!(res.new_epoch >= 2, "踢人必须前向轮换纪元密钥");
        }
        other => return Err(format!("unexpected revoke response: {other:?}").into()),
    }
    let membership_raw = fs::read_to_string(qz_home.join("fabric/membership_state.json"))?;
    assert!(
        !membership_raw.contains(&joiner.device_id().to_string()),
        "吊销后成员状态不得再包含该设备"
    );

    // 旧连接已被主动关闭；重连必须被硬拒。
    let rejected = rt.block_on(async {
        tokio::time::timeout(
            Duration::from_secs(5),
            joiner_node.send_rpc(
                daemon_addr,
                &FabricRpcRequest::Ping {
                    agent_id: identity.agent_id,
                    sender_device_id: joiner.device_id(),
                },
            ),
        )
        .await
    });
    let rejected_ok = match rejected {
        Err(_) => true,
        Ok(Ok(FabricRpcResponse::Error { .. })) => true,
        Ok(Ok(_)) => false,
        Ok(Err(_)) => true,
    };
    assert!(rejected_ok, "吊销设备重连必须被拒绝，实际: {rejected:?}");

    let nodes = run_json(&["nodes", "--json"], &qz_home)?;
    let peers = nodes["peers"].as_array().ok_or("peers")?;
    assert!(
        !peers
            .iter()
            .any(|p| p["device_id"].as_str() == Some(joiner_device_id.as_str())),
        "qz nodes 不得再列出已吊销设备"
    );

    rt.block_on(joiner_node.shutdown());
    daemon.shutdown()?;
    Ok(())
}

#[test]
fn graceful_shutdown_hands_lease_off_to_online_peer() -> TestResult {
    let hub = RunningGoHub::spawn()?;
    let tmp = TempDirGuard::new("qz_daemon_handoff")?;
    let qz_home = tmp.path().join("home");
    fs::create_dir_all(&qz_home)?;
    let ca_pem = tmp.path().join("hub_ca.pem");
    fs::write(&ca_pem, &hub.ca_cert_pem)?;

    let identity = bootstrap_identity(&qz_home, &hub)?;
    let mut daemon = QuetzalcoatlDaemon::start(fabric_config(&qz_home, &hub, &ca_pem))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    login_with_pin(&qz_home, &hub)?;

    let start = run_json(
        &["pair", "start", "--hub", &hub.https_url, "--json"],
        &qz_home,
    )?;
    let pair_code = start["pair_code"].as_str().ok_or("pair_code")?.to_owned();
    let _ = run_json(
        &[
            "pair",
            "join",
            "--hub",
            &hub.https_url,
            "--code",
            &pair_code,
            "--json",
        ],
        &qz_home,
    )?;
    let _ = run_json(
        &[
            "pair",
            "approve",
            "--hub",
            &hub.https_url,
            "--code",
            &pair_code,
            "--json",
        ],
        &qz_home,
    )?;
    let joiner = read_pending_joiner(&qz_home)?;
    let ring = membership_ring(&identity, &joiner.public_record())?;

    let seen = Arc::new(AtomicBool::new(false));
    let counter = Arc::new(AtomicUsize::new(0));
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let joiner_node = rt.block_on(FabricNode::bind(
        FabricNodeConfig {
            agent_id: identity.agent_id,
            device: joiner.clone(),
            epoch_ring: ring,
            bind_ipv4: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
            enable_mdns: false,
            discover_overlay_interfaces: false,
            relay: Some(relay_settings(&hub)),
            local_capabilities: None,
        },
        Some(Arc::new(HandoffProbe {
            seen: Arc::clone(&seen),
            counter: Arc::clone(&counter),
            local_device: joiner.device_id(),
            accepted_epoch: 99,
        })),
    ))?;

    let daemon_addr = relay_addr(&daemon_endpoint_id_hex(&client)?, &hub)?;
    joiner_node.register_peer_addr(daemon_addr.clone());
    // 让 daemon 侧记录到在线对等连接
    for _ in 0..3 {
        let _ = rt.block_on(joiner_node.send_rpc(
            daemon_addr.clone(),
            &FabricRpcRequest::Ping {
                agent_id: identity.agent_id,
                sender_device_id: joiner.device_id(),
            },
        ))?;
        thread::sleep(Duration::from_millis(120));
    }

    // 优雅退出必须向在线对等节点发起 VoluntaryLeaseHandoff。
    daemon.shutdown()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && !seen.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        seen.load(Ordering::SeqCst),
        "fabric 启用时优雅退出必须发起 <100ms 主动租约移交"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 1);

    rt.block_on(joiner_node.shutdown());
    Ok(())
}

#[test]
fn revoke_of_unknown_device_is_a_typed_error_not_a_silent_ack() -> TestResult {
    let hub = RunningGoHub::spawn()?;
    let tmp = TempDirGuard::new("qz_daemon_revoke_unknown")?;
    let qz_home = tmp.path().join("home");
    fs::create_dir_all(&qz_home)?;
    let ca_pem = tmp.path().join("hub_ca.pem");
    fs::write(&ca_pem, &hub.ca_cert_pem)?;
    let _ = bootstrap_identity(&qz_home, &hub)?;
    let mut daemon = QuetzalcoatlDaemon::start(fabric_config(&qz_home, &hub, &ca_pem))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    login_with_pin(&qz_home, &hub)?;

    match client.call(&IpcRequest::FabricRevokeDevice {
        device_id: DeviceId::new_v4(),
    })? {
        IpcResponse::Error { code, detail } => {
            assert_eq!(code, "INTEGRITY_VIOLATION");
            assert!(!detail.starts_with("Ack"));
        }
        other => return Err(format!("未知设备吊销必须类型化失败: {other:?}").into()),
    }
    daemon.shutdown()?;
    Ok(())
}

#[test]
fn corrupt_or_tampered_membership_state_is_quarantined_and_daemon_still_starts() -> TestResult {
    let tmp = TempDirGuard::new("qz_membership_corrupt")?;
    let qz_home = tmp.path().join("home");
    fs::create_dir_all(&qz_home)?;
    // 先正常生成主权身份（fabric 关闭也走同一条 load_or_init 成员重放路径）。
    {
        let mut genesis = QuetzalcoatlDaemon::start(disabled_config(&qz_home))?;
        genesis.shutdown()?;
    }

    let fabric_dir = qz_home.join("fabric");
    fs::create_dir_all(&fabric_dir)?;
    let membership_path = fabric_dir.join("membership_state.json");

    // 1. 完全损坏的 JSON：必须隔离并安全回退，而不是让守护进程启动失败。
    fs::write(&membership_path, b"{ this is not json")?;
    {
        let mut daemon = QuetzalcoatlDaemon::start(disabled_config(&qz_home))?;
        let client =
            IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
        assert!(matches!(
            client.call(&IpcRequest::Status)?,
            IpcResponse::Status(_)
        ));
        daemon.shutdown()?;
    }
    assert!(!membership_path.exists(), "损坏的成员状态必须被移出原路径");
    let quarantined: Vec<PathBuf> = fs::read_dir(&fabric_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("membership_state.json.corrupt-"))
        })
        .collect();
    assert_eq!(quarantined.len(), 1, "必须留下 .corrupt-<ts> 隔离副本");

    // 2. 结构合法但内容被篡改（非法十六进制纪元密钥）：同样隔离并回退。
    fs::write(
        &membership_path,
        br#"{"extra_epoch_keys":[[7,"not-a-hex-key"]],"peer_devices":[]}"#,
    )?;
    {
        let mut daemon = QuetzalcoatlDaemon::start(disabled_config(&qz_home))?;
        daemon.shutdown()?;
    }
    assert!(!membership_path.exists(), "被篡改的成员状态同样必须被隔离");
    let quarantined_total = fs::read_dir(&fabric_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("membership_state.json.corrupt-"))
        })
        .count();
    assert!(
        quarantined_total >= 2,
        "两类损坏都必须各自留下隔离副本，实际 {quarantined_total}"
    );

    Ok(())
}

/// Fix Round 2 / Item 1：两台**互不手动拨号**的空闲守护进程必须通过 Hub 提供的 endpoint id
/// 自行建立 P2P 直连；Hub 被杀后仍能仅靠 P2P 收敛脊柱事件（证明生产拨号路径真实生效）。
#[test]
fn two_idle_daemons_dial_via_hub_discovery_and_converge_peer_only_after_hub_loss() -> TestResult {
    let mut hub = RunningGoHub::spawn()?;
    let tmp = TempDirGuard::new("qz_daemon_peer_convergence")?;
    let home_a = tmp.path().join("home_a");
    let home_b = tmp.path().join("home_b");
    fs::create_dir_all(&home_a)?;
    fs::create_dir_all(&home_b)?;
    let ca_pem = tmp.path().join("hub_ca.pem");
    fs::write(&ca_pem, &hub.ca_cert_pem)?;

    // 1. A：真实身份注册 + fabric 守护进程 + OPAQUE 登录。
    let identity_a = bootstrap_identity(&home_a, &hub)?;
    let mut daemon_a = QuetzalcoatlDaemon::start(fabric_config(&home_a, &hub, &ca_pem))?;
    let client_a =
        IpcClient::from_runtime_info(daemon_a.runtime_info(), daemon_a.ipc_token().to_owned());
    login_with_pin(&home_a, &hub)?;

    // 2. 配对 B（无需第二台真实机器：把 B 的设备身份装配到独立 home）。
    let start = run_json(
        &["pair", "start", "--hub", &hub.https_url, "--json"],
        &home_a,
    )?;
    let pairing_id = start["pairing_id"].as_str().ok_or("pairing_id")?.to_owned();
    let short_code = start["short_code"].as_str().ok_or("short_code")?.to_owned();
    let pair_code = start["pair_code"].as_str().ok_or("pair_code")?.to_owned();
    let _ = run_json(
        &[
            "pair",
            "join",
            "--hub",
            &hub.https_url,
            "--code",
            &pair_code,
            "--json",
        ],
        &home_a,
    )?;
    let _ = run_json(
        &[
            "pair",
            "approve",
            "--hub",
            &hub.https_url,
            "--code",
            &pair_code,
            "--json",
        ],
        &home_a,
    )?;
    let device_b = read_pending_joiner(&home_a)?;

    // 2a. home_b：复制 A 的身份快照，仅替换设备身份为 B，并写入"成员 = A"的成员表。
    {
        let mut genesis_b = QuetzalcoatlDaemon::start(disabled_config(&home_b))?;
        genesis_b.shutdown()?;
    }
    let _ = fs::remove_dir_all(home_b.join("spine"));
    let _ = fs::remove_dir_all(home_b.join("fabric"));
    fs::create_dir_all(home_b.join("fabric"))?;
    let mut state_a: serde_json::Value =
        serde_json::from_slice(&fs::read(home_a.join("identity/sovereign_state.json"))?)?;
    state_a["device_id"] = serde_json::Value::String(device_b.device_id().to_string());
    state_a["ed25519_seed_hex"] =
        serde_json::Value::String(hex_encode_seed(device_b.ed25519_seed()));
    state_a["xwing_seed_hex"] = serde_json::Value::String(hex_encode_seed(device_b.xwing_seed()));
    fs::write(
        home_b.join("identity/sovereign_state.json"),
        serde_json::to_vec_pretty(&state_a)?,
    )?;
    let membership_b = serde_json::json!({
        "extra_epoch_keys": [],
        "peer_devices": [identity_a.device.public_record()],
    });
    fs::write(
        home_b.join("fabric/membership_state.json"),
        serde_json::to_vec_pretty(&membership_b)?,
    )?;

    // 2b. 为 B 取得 Hub 会话（pair complete），再启动 B 守护进程并登录。
    let b_token = {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let anon = HubClient::new(HubClientConfig {
            base_url: hub.https_url.clone(),
            session_token: None,
            custom_ca_certs_der: vec![hub.ca_cert_der.clone()],
        })?;
        let (session, _root) =
            rt.block_on(anon.pair_complete_and_unwrap(&pairing_id, &short_code, &device_b))?;
        session.session_token
    };
    let mut daemon_b = QuetzalcoatlDaemon::start(fabric_config(&home_b, &hub, &ca_pem))?;
    let client_b =
        IpcClient::from_runtime_info(daemon_b.runtime_info(), daemon_b.ipc_token().to_owned());
    let (login_ok, _, login_err) = qz(
        &[
            "login",
            "--hub",
            &hub.https_url,
            "--token",
            &b_token,
            "--json",
        ],
        &home_b,
    )?;
    assert!(login_ok, "B 令牌登录失败: {login_err}");

    // 3. 两台守护进程互不手动拨号：仅靠 Hub 发现即应在有限个心跳内出现 **直连** 对端。
    let device_a_id = identity_a.device.device_id().to_string();
    let device_b_id = device_b.device_id().to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut connected = false;
    while Instant::now() < deadline {
        let nodes_a = run_json(&["nodes", "--json"], &home_a)?;
        let nodes_b = run_json(&["nodes", "--json"], &home_b)?;
        let a_sees_b = nodes_a["peers"].as_array().is_some_and(|rows| {
            rows.iter().any(|r| {
                r["device_id"].as_str() == Some(device_b_id.as_str())
                    && r["path_kind"].as_str() != Some("disconnected")
            })
        });
        let b_sees_a = nodes_b["peers"].as_array().is_some_and(|rows| {
            rows.iter().any(|r| {
                r["device_id"].as_str() == Some(device_a_id.as_str())
                    && r["path_kind"].as_str() != Some("disconnected")
            })
        });
        if a_sees_b && b_sees_a {
            connected = true;
            break;
        }
        thread::sleep(Duration::from_millis(300));
    }
    assert!(
        connected,
        "两台空闲守护进程必须在有限心跳内通过 Hub 发现自行拨号建立 P2P 连接"
    );

    // A 项：远端 holder 不得在本地绑定长连接，也不得授权有状态通道外发。
    for client in [&client_a, &client_b] {
        let _ = client.call(&IpcRequest::ChannelEnable {
            channel: String::from("feishu"),
        })?;
    }
    let nodes = run_json(&["nodes", "--json"], &home_a)?;
    let holder = nodes["router_holder"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (holder_client, remote_client, remote_name) = if holder == device_a_id {
        (&client_a, &client_b, "B")
    } else {
        (&client_b, &client_a, "A")
    };
    let _ = holder_client.call(&IpcRequest::Status)?;
    match remote_client.call(&IpcRequest::Status)? {
        IpcResponse::Status(st) => {
            let feishu = st
                .channels
                .iter()
                .find(|h| h.channel == "feishu")
                .ok_or("missing feishu health")?;
            if feishu.bound_witness_epoch.is_some() {
                return Err(format!("remote daemon {remote_name} must not bind feishu").into());
            }
            let holder_report = feishu.holder_device_id.as_deref().unwrap_or("");
            if !holder_report.is_empty() && !holder_report.starts_with("remote-holder:") {
                return Err(format!(
                    "remote daemon {remote_name} must not claim local ownership, got {holder_report:?}"
                )
                .into());
            }
        }
        other => return Err(format!("unexpected remote status: {other:?}").into()),
    }
    match remote_client.call(&IpcRequest::ChannelDeliver {
        channel: String::from("feishu"),
        destination: None,
        text: String::from("remote-holder-send"),
    })? {
        IpcResponse::Error { code, .. } => {
            assert_eq!(code, "PERMISSION_DENIED");
        }
        other => {
            return Err(format!("remote holder stateful send must be denied: {other:?}").into());
        }
    }

    let baseline_b_events = match client_b.call(&IpcRequest::Status)? {
        IpcResponse::Status(st) => st.spine_events_count,
        other => return Err(format!("unexpected status: {other:?}").into()),
    };

    // 4. 杀 Hub：此后只能依靠已建立的 P2P 直连收敛（证明真实 peer-only 同步路径）。
    hub.kill();
    thread::sleep(Duration::from_millis(200));

    match client_a.call(&IpcRequest::ExploreTick {
        synthesize_skill_id: Some(String::from("skill.peer_convergence")),
        synthesize_script_body: Some(String::from("#!/bin/sh\necho peer-convergence\n")),
        attempt_external_send: false,
    })? {
        IpcResponse::ExploreTick(rep) => assert!(rep.woke_explore),
        other => return Err(format!("unexpected explore response: {other:?}").into()),
    }

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut converged = false;
    while Instant::now() < deadline {
        if let IpcResponse::Status(st) = client_b.call(&IpcRequest::Status)?
            && st.spine_events_count > baseline_b_events
        {
            converged = true;
            break;
        }
        thread::sleep(Duration::from_millis(300));
    }
    assert!(
        converged,
        "Hub 下线后 B 必须仅靠 P2P 直连同步合入 A 的新事件（baseline={baseline_b_events}）"
    );

    daemon_a.shutdown()?;
    daemon_b.shutdown()?;
    Ok(())
}

fn hex_encode_seed(seed: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in seed {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[test]
fn channel_send_under_partition_local_queues_outbox_and_refuses_public_send() -> TestResult {
    let tmp = TempDirGuard::new("qz_channel_outbox_fence")?;
    let qz_home = tmp.path().join("home");
    fs::create_dir_all(qz_home.join("secrets"))?;
    fs::write(
        qz_home.join("secrets/webhook.json"),
        serde_json::json!({"url": "https://127.0.0.1:9/hook"}).to_string(),
    )?;

    let blackhole = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    let blackhole_port = blackhole.local_addr()?.port();
    let keep_alive: Arc<std::sync::Mutex<Vec<TcpStream>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let keep_clone = Arc::clone(&keep_alive);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);
    blackhole.set_nonblocking(true)?;
    let accept_thread = thread::spawn(move || {
        while !stop_clone.load(Ordering::Relaxed) {
            match blackhole.accept() {
                Ok((stream, _)) => {
                    if let Ok(mut guard) = keep_clone.lock() {
                        guard.push(stream);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    {
        let mut genesis = QuetzalcoatlDaemon::start(disabled_config(&qz_home))?;
        genesis.shutdown()?;
    }
    let identity = read_sovereign_identity(&qz_home)?;
    let blackhole_url = format!("https://127.0.0.1:{blackhole_port}");
    let session = serde_json::json!({
        "hub_url": blackhole_url,
        "hub_ca_file": null,
        "relay_url": blackhole_url,
        "qad_port": 7842,
        "session_token": "synthetic-partition-token",
        "account_id": "synthetic",
        "agent_id": identity.agent_id.to_string(),
        "device_id": identity.device.device_id().to_string(),
    });
    fs::create_dir_all(qz_home.join("fabric"))?;
    fs::write(
        qz_home.join("fabric/hub_session.json"),
        serde_json::to_vec_pretty(&session)?,
    )?;

    let mut cfg = DaemonConfig::new(qz_home.clone());
    cfg.fabric = Some(DaemonFabricConfig {
        hub_url: blackhole_url.clone(),
        hub_ca_file: None,
        relay_url: blackhole_url,
        qad_port: 7842,
        enable_mdns: false,
        tick_interval_ms: 250,
    });
    cfg.discovery_search_paths = Some(Vec::new());
    let mut daemon = QuetzalcoatlDaemon::start(cfg)?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    for channel in ["webhook", "feishu"] {
        match client.call(&IpcRequest::ChannelEnable {
            channel: String::from(channel),
        })? {
            IpcResponse::ChannelUpdate(row) => assert!(row.enabled),
            other => return Err(format!("unexpected channel enable: {other:?}").into()),
        }
    }

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let IpcResponse::Status(st) = client.call(&IpcRequest::Status)?
            && st.fabric.lease == "partition_local"
        {
            break;
        }
        if Instant::now() >= deadline {
            return Err("fabric never entered partition_local".into());
        }
        thread::sleep(Duration::from_millis(100));
    }

    match client.call(&IpcRequest::Status)? {
        IpcResponse::Status(st) => {
            let feishu = st
                .channels
                .iter()
                .find(|h| h.channel == "feishu")
                .ok_or("missing feishu health")?;
            assert_eq!(feishu.bound_witness_epoch, None);
            assert!(feishu.holder_device_id.is_none());
            assert_eq!(st.fabric.lease, "partition_local");
        }
        other => return Err(format!("unexpected status: {other:?}").into()),
    }

    match client.call(&IpcRequest::ChannelDeliver {
        channel: String::from("webhook"),
        destination: None,
        text: String::from("CANARY-PARTITION-OUTBOX"),
    })? {
        IpcResponse::Error { code, .. } => assert_eq!(code, "PARTITION_RESTRICTED"),
        other => return Err(format!("partition send must be refused, got {other:?}").into()),
    }

    let db = rusqlite::Connection::open(qz_home.join("spine/spine.sqlite"))?;
    let payload: String = db.query_row(
        "SELECT payload_utf8 FROM spine_events WHERE payload_utf8 LIKE '%outbox_queued%' ORDER BY seq DESC LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    assert!(payload.contains("outbox_queued"));
    assert!(
        payload.contains("CANARY-PARTITION-OUTBOX"),
        "Outbox must persist the replayable rendered body for later delivery"
    );
    assert!(payload.contains("webhook"));

    daemon.shutdown()?;
    stop.store(true, Ordering::Relaxed);
    let _ = accept_thread.join();
    Ok(())
}
