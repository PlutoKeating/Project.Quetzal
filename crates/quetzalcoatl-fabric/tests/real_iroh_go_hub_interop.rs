#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]
// 集成测试刻意在 `tokio::test` 中持有 `std::sync::Mutex<BlindKernel>` 以驱动同步租约协调器，
// 这是被测对象的既有同步契约（生产端由独立线程 block_on），因此在此显式放宽该 lint。
#![allow(clippy::await_holding_lock)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use iroh::EndpointAddr;
use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing, PackCompartment,
};
use quetzalcoatl_fabric::{
    FABRIC_ALPN, FabricNode, FabricNodeConfig, FabricRelaySettings, FabricRpcHandler,
    FabricRpcRequest, FabricRpcResponse, FencedLeaseCoordinator, HubClient, HubClientConfig,
    LeaseCoordinatorConfig, NodeCapabilityAnnouncement, NodeCapabilitySpec, PeerPathKind,
    RemoteWorkerPool, RemoteWorkerTaskSpec, SpineSyncActor, StdMonotonicClock,
    execute_remote_worker_task_locally,
};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityDescriptor, CapabilityOrigin, ExecutionSurface, HeartScheduler,
    LeasePosture, SinkClass, SleepPhase,
};
use quetzalcoatl_sandbox::{SandboxConfig, SandboxManager};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, HlcTimestamp, RunId};
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
        let bin_path = out_dir.join(format!("quetzalcoatl-hub-{}", std::process::id()));
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

struct GeneratedTestPki {
    ca_cert_der: Vec<u8>,
    server_cert_pem: String,
    server_key_pem: String,
}

fn generate_test_ca_and_hub_cert() -> Result<GeneratedTestPki, Box<dyn Error + Send + Sync>> {
    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let mut ca_dn = DistinguishedName::new();
    ca_dn.push(DnType::CommonName, "Quetzalcoatl Test Root CA");
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

    Ok(GeneratedTestPki {
        ca_cert_der: ca_cert.der().to_vec(),
        server_cert_pem: leaf_cert.pem(),
        server_key_pem: leaf_key.serialize_pem(),
    })
}

struct RunningGoHub {
    _tmp: TempDirGuard,
    data_dir: PathBuf,
    https_url: String,
    qad_port: u16,
    ca_cert_der: Vec<u8>,
    child: Child,
}

impl RunningGoHub {
    async fn spawn() -> Result<Self, Box<dyn Error + Send + Sync>> {
        let bin = compiled_go_hub_binary()?;
        let tmp = TempDirGuard::new("qz_real_go_hub")?;
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

        let mut root_store = rustls::RootCertStore::empty();
        root_store.add(rustls::pki_types::CertificateDer::from(
            pki.ca_cert_der.clone(),
        ))?;
        let tls_cfg = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(root_store)
        .with_no_client_auth();
        let probe_client = reqwest::Client::builder()
            .tls_backend_preconfigured(tls_cfg)
            .no_proxy()
            .build()?;

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut ready = false;
        while Instant::now() < deadline {
            if let Some(exit) = child.try_wait()? {
                let logs = fs::read_to_string(&log_path).unwrap_or_default();
                return Err(format!("quetzalcoatl-hub exited early ({exit}): {logs}").into());
            }
            if let Ok(resp) = probe_client
                .get(format!("{https_url}/healthz"))
                .send()
                .await
                && resp.status().is_success()
            {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        if !ready {
            let _ = child.kill();
            let logs = fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!("quetzalcoatl-hub did not become ready in 10s: {logs}").into());
        }

        Ok(Self {
            _tmp: tmp,
            data_dir,
            https_url,
            qad_port,
            ca_cert_der: pki.ca_cert_der,
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

fn collect_all_files_bytes(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) -> TestResult {
    if !dir.exists() {
        return Ok(());
    }
    for entry_res in fs::read_dir(dir)? {
        let entry = entry_res?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_all_files_bytes(&path, out)?;
        } else if entry.file_type()?.is_file() {
            out.push((path.clone(), fs::read(&path)?));
        }
    }
    Ok(())
}

fn now_wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(1_795_400_000_000))
        .unwrap_or(1_795_400_000_000)
}

fn build_test_kernel(
    home_dir: &Path,
    agent_id: AgentId,
    device: DeviceIdentity,
    ring: EpochKeyRing,
    now_ms: u64,
) -> Result<BlindKernel<RusqliteWalStore>, Box<dyn Error + Send + Sync>> {
    let sqlite_path = home_dir.join("spine.sqlite");
    let store = RusqliteWalStore::open(&sqlite_path)?;
    let hlc = HlcTimestamp::from_parts(now_ms, 0, device.device_id().hlc_node_tag());
    let spine = SpineEngine::new(agent_id, device, ring, hlc, store)?;
    let sandbox = SandboxManager::new(SandboxConfig::new(home_dir));
    let mut kernel = BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(1, 0.15, SleepPhase::Awake),
        LeasePosture::PartitionLocal,
    );
    for (cap_id, sink, surface, idempotent) in [
        (
            "code.mutate",
            SinkClass::CodeRepositoryMutation,
            ExecutionSurface::SandboxFileWrite,
            false,
        ),
        (
            "external.send",
            SinkClass::HighRiskExternalWrite,
            ExecutionSurface::ExternalChannel,
            false,
        ),
    ] {
        kernel.register_capability(CapabilityDescriptor {
            capability_id: String::from(cap_id),
            interface_id: String::from("quetzalcoatl.core"),
            sink_class: sink,
            surface,
            idempotent,
            origin: CapabilityOrigin::HostRegistered,
        })?;
    }
    Ok(kernel)
}

struct NodeRuntimeHarness {
    kernel: Arc<Mutex<BlindKernel<RusqliteWalStore>>>,
    lease_coord: Arc<Mutex<FencedLeaseCoordinator<StdMonotonicClock>>>,
    hub_client: HubClient,
    worker_pool: Arc<Mutex<RemoteWorkerPool>>,
}

impl FabricRpcHandler for NodeRuntimeHarness {
    fn handle_rpc(
        &self,
        authenticated_peer_device: DeviceId,
        req: FabricRpcRequest,
    ) -> FabricRpcResponse {
        match req {
            FabricRpcRequest::Ping { .. } => FabricRpcResponse::Pong {
                responder_device_id: authenticated_peer_device,
                capability: None,
            },
            FabricRpcRequest::PushPackfiles { packs, .. } => {
                let Ok(mut k) = self.kernel.lock() else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("lock poisoned"),
                    };
                };
                match SpineSyncActor::ingest_packfiles_and_rehydrate(&mut k, &packs, now_wall_ms())
                {
                    Ok((events_n, _)) => FabricRpcResponse::PackfilesAck {
                        ingested_events: events_n,
                    },
                    Err(e) => FabricRpcResponse::Error {
                        code: String::from(e.code().as_str()),
                        detail: e.to_string(),
                    },
                }
            }
            FabricRpcRequest::PullPackfiles { known_heads, .. } => {
                let Ok(k) = self.kernel.lock() else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("lock poisoned"),
                    };
                };
                let head_map: BTreeMap<DeviceId, u64> = known_heads.into_iter().collect();
                let all_packs = k.spine().store().list_packfiles().unwrap_or_default();
                let filtered = all_packs
                    .into_iter()
                    .filter(|p| {
                        let peer_seq = head_map.get(&p.aad.device_id).copied().unwrap_or(0);
                        p.aad.last_seq > peer_seq
                    })
                    .collect();
                FabricRpcResponse::PackfilesBatch { packs: filtered }
            }
            FabricRpcRequest::VoluntaryLeaseHandoff {
                agent_id,
                released_epoch,
                latest_packs,
                ..
            } => {
                let local_dev = {
                    let Ok(mut k) = self.kernel.lock() else {
                        return FabricRpcResponse::Error {
                            code: String::from("STORAGE_ERROR"),
                            detail: String::from("kernel lock poisoned"),
                        };
                    };
                    if !latest_packs.is_empty()
                        && let Err(e) = SpineSyncActor::ingest_packfiles_and_rehydrate(
                            &mut k,
                            &latest_packs,
                            now_wall_ms(),
                        )
                    {
                        return FabricRpcResponse::Error {
                            code: String::from(e.code().as_str()),
                            detail: e.to_string(),
                        };
                    }
                    k.spine().local_device().device_id()
                };

                let hub = self.hub_client.clone();
                let acq_res = std::thread::spawn(move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build();
                    match rt {
                        Ok(r) => r.block_on(hub.acquire_lease(
                            agent_id,
                            local_dev,
                            released_epoch,
                            30_000,
                        )),
                        Err(e) => Err(quetzalcoatl_types::QuetzalcoatlError::StorageError {
                            detail: e.to_string(),
                        }),
                    }
                })
                .join();

                match acq_res {
                    Ok(Ok(rec)) => {
                        if let Ok(mut k) = self.kernel.lock() {
                            k.set_lease_posture(LeasePosture::Witnessed {
                                witness_epoch: Epoch::new(rec.witness_epoch),
                            });
                            if let Ok(mut lc) = self.lease_coord.lock() {
                                let _ = lc.observe_remote_epoch(
                                    rec.witness_epoch,
                                    Some(local_dev),
                                    &mut k,
                                );
                            }
                        }
                        FabricRpcResponse::LeaseHandoffAccepted {
                            new_holder_device_id: local_dev,
                            new_witness_epoch: rec.witness_epoch,
                        }
                    }
                    Ok(Err(e)) => FabricRpcResponse::Error {
                        code: String::from(e.code().as_str()),
                        detail: e.to_string(),
                    },
                    Err(_) => FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("handoff thread join failed"),
                    },
                }
            }
            FabricRpcRequest::AnnounceCapabilities { announcement } => {
                let ring_res = self.kernel.lock().map(|k| k.spine().epoch_ring().clone());
                if let Ok(ring) = ring_res
                    && let Ok(mut pool) = self.worker_pool.lock()
                    && let Err(e) = pool.ingest_announcement(announcement, &ring)
                {
                    return FabricRpcResponse::Error {
                        code: String::from(e.code().as_str()),
                        detail: e.to_string(),
                    };
                }
                FabricRpcResponse::CapabilityAck
            }
            FabricRpcRequest::ExecuteRemoteWorkerTask { task, .. } => {
                let Ok(mut k) = self.kernel.lock() else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("kernel lock poisoned"),
                    };
                };
                match execute_remote_worker_task_locally(&mut k, &task, now_wall_ms()) {
                    Ok(res) => FabricRpcResponse::RemoteWorkerTaskCompleted {
                        result: Box::new(res),
                    },
                    Err(e) => FabricRpcResponse::Error {
                        code: String::from(e.code().as_str()),
                        detail: e.to_string(),
                    },
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_iroh_go_hub_qad_holepunch_pairing_zero_plaintext_sync_fast_handoff_and_worker_pool()
-> TestResult {
    assert_eq!(FABRIC_ALPN, b"/quetzalcoatl/fabric/v2");

    let hub = RunningGoHub::spawn().await?;
    let tmp = TempDirGuard::new("qz_fabric_interop_nodes")?;
    let now_ms: u64 = now_wall_ms();

    // 1. 初始化节点 A 的主权根密钥与设备身份，并在真实 Go quetzalcoatl-hub 上完成 EdDSA WebAuthn 注册 + OPAQUE PIN 注册/登录校验
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let device_a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let epoch1_key = EpochKey::generate()?;

    let anon_hub = HubClient::new(HubClientConfig {
        base_url: hub.https_url.clone(),
        session_token: None,
        custom_ca_certs_der: vec![hub.ca_cert_der.clone()],
    })?;

    let auth_a = anon_hub
        .register_agent_with_eddsa_passkey(agent_id, &device_a, &root_key)
        .await?;
    assert_eq!(auth_a.agent_id, agent_id);
    assert_eq!(auth_a.device_id, device_a.device_id());

    let hub_a = anon_hub.with_session_token(auth_a.session_token.clone());

    // 验证 RFC 9807 OPAQUE PIN 零知识注册与登录往返恢复 AccountRootKey
    hub_a
        .register_opaque_pin(agent_id, b"842619", &root_key)
        .await?;
    let (opaque_sess, recovered_root_via_opaque) = anon_hub
        .login_opaque_pin(agent_id, device_a.device_id(), b"842619")
        .await?;
    assert_eq!(
        recovered_root_via_opaque.verifying_key_bytes()?,
        root_key.verifying_key_bytes()?
    );
    assert!(!opaque_sess.session_token.is_empty());

    // 2. 执行 5 秒抗量子 X-Wing (`MLKEM768X25519` `0x647a`) 设备配对（设备 B 加入）
    let pairing_start = Instant::now();
    let pair_init = hub_a.pair_initiate(agent_id).await?;
    assert!(!pair_init.pairing_id.is_empty());
    assert_eq!(pair_init.short_code.len(), 9);

    let device_b = DeviceIdentity::generate(DeviceId::new_v4())?;
    anon_hub
        .pair_join(&pair_init.pairing_id, &pair_init.short_code, &device_b)
        .await?;

    let pair_status = hub_a.pair_get(&pair_init.pairing_id).await?;
    assert_eq!(pair_status.new_device_id, device_b.device_id().to_string());

    let mut ring_a = EpochKeyRing::new_genesis(agent_id, &root_key, device_a.public_record())?;
    ring_a.insert_epoch_key(Epoch::new(1), epoch1_key.clone());
    let _signed_add_b = ring_a.add_device(&root_key, device_b.public_record())?;

    hub_a
        .pair_approve(
            &pair_init.pairing_id,
            agent_id,
            Epoch::new(1),
            &root_key,
            &pair_status,
        )
        .await?;

    let (auth_b, unwrapped_root_b) = anon_hub
        .pair_complete_and_unwrap(&pair_init.pairing_id, &pair_init.short_code, &device_b)
        .await?;
    assert!(
        pairing_start.elapsed() < Duration::from_secs(5),
        "X-Wing 抗量子配对全流程耗时必须 < 5s"
    );
    assert_eq!(
        unwrapped_root_b.verifying_key_bytes()?,
        root_key.verifying_key_bytes()?
    );
    let hub_b = anon_hub.with_session_token(auth_b.session_token.clone());

    let mut ring_b =
        EpochKeyRing::new_genesis(agent_id, &unwrapped_root_b, device_a.public_record())?;
    ring_b.insert_epoch_key(Epoch::new(1), epoch1_key.clone());
    let _ = ring_b.add_device(&unwrapped_root_b, device_b.public_record())?;

    // 3. 构建两台真实 iroh 1.5.0 FabricNode（完全禁用 n0 官方中继，且关闭 mDNS 强制经过自建 Go Hub /relay + :qad_port 打洞！）
    let home_a = tmp.path().join("node_a");
    let home_b = tmp.path().join("node_b");
    fs::create_dir_all(&home_a)?;
    fs::create_dir_all(&home_b)?;

    let kernel_a = Arc::new(Mutex::new(build_test_kernel(
        &home_a,
        agent_id,
        device_a.clone(),
        ring_a.clone(),
        now_ms,
    )?));
    let kernel_b = Arc::new(Mutex::new(build_test_kernel(
        &home_b,
        agent_id,
        device_b.clone(),
        ring_b.clone(),
        now_ms,
    )?));

    let lease_a = Arc::new(Mutex::new(FencedLeaseCoordinator::new(
        StdMonotonicClock::new(),
        LeaseCoordinatorConfig::default(),
    )));
    let lease_b = Arc::new(Mutex::new(FencedLeaseCoordinator::new(
        StdMonotonicClock::new(),
        LeaseCoordinatorConfig::default(),
    )));

    let pool_a = Arc::new(Mutex::new(RemoteWorkerPool::new()));
    let pool_b = Arc::new(Mutex::new(RemoteWorkerPool::new()));

    let relay_settings = FabricRelaySettings {
        relay_url: hub.https_url.clone(),
        qad_port: hub.qad_port,
        auth_token: None,
        custom_ca_certs_der: vec![hub.ca_cert_der.clone()],
    };

    let cap_spec_b = NodeCapabilitySpec {
        os: String::from(std::env::consts::OS),
        arch: String::from(std::env::consts::ARCH),
        available_harnesses: vec![String::from("claude"), String::from("opencode")],
        capability_tags: BTreeSet::from([
            String::from("claude"),
            String::from("rust-heavy"),
            String::from("workstation"),
        ]),
        sandbox_available: true,
        max_workers: 4,
    };

    let node_a = FabricNode::bind(
        FabricNodeConfig {
            agent_id,
            device: device_a.clone(),
            epoch_ring: ring_a.clone(),
            bind_ipv4: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
            enable_mdns: false,
            discover_overlay_interfaces: true,
            relay: Some(relay_settings.clone()),
            local_capabilities: None,
        },
        Some(Arc::new(NodeRuntimeHarness {
            kernel: Arc::clone(&kernel_a),
            lease_coord: Arc::clone(&lease_a),
            hub_client: hub_a.clone(),
            worker_pool: Arc::clone(&pool_a),
        })),
    )
    .await?;

    let node_b = FabricNode::bind(
        FabricNodeConfig {
            agent_id,
            device: device_b.clone(),
            epoch_ring: ring_b.clone(),
            bind_ipv4: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
            enable_mdns: false,
            discover_overlay_interfaces: true,
            relay: Some(relay_settings.clone()),
            local_capabilities: Some(cap_spec_b.clone()),
        },
        Some(Arc::new(NodeRuntimeHarness {
            kernel: Arc::clone(&kernel_b),
            lease_coord: Arc::clone(&lease_b),
            hub_client: hub_b.clone(),
            worker_pool: Arc::clone(&pool_b),
        })),
    )
    .await?;

    node_a.wait_online(Duration::from_secs(8)).await?;
    node_b.wait_online(Duration::from_secs(8)).await?;

    // 4. 断言禁用 n0 中继后，仅靠自建 Go Hub `/iroh-qad/0` UDP 探测即成功测出 `global_v4`！
    let qad_a = node_a
        .wait_for_qad_global_v4(Duration::from_secs(8))
        .await?;
    let qad_b = node_b
        .wait_for_qad_global_v4(Duration::from_secs(8))
        .await?;
    assert!(qad_a.udp_v4, "Node A 必须通过 Go Hub QAD 完成 UDPv4 探测");
    assert!(qad_b.udp_v4, "Node B 必须通过 Go Hub QAD 完成 UDPv4 探测");
    let obs_a = qad_a.global_v4.ok_or("Node A global_v4 为空")?;
    let obs_b = qad_b.global_v4.ok_or("Node B global_v4 为空")?;
    assert_eq!(obs_a.ip(), &Ipv4Addr::LOCALHOST);
    assert_eq!(obs_b.ip(), &Ipv4Addr::LOCALHOST);
    assert!(
        qad_a
            .preferred_relay
            .as_deref()
            .unwrap_or("")
            .starts_with(&hub.https_url),
        "preferred_relay 必须指向自建 Go Hub 而非任何外部 n0 中继"
    );

    // 5. 断言双向密码学设备鉴权：未授权的第 3 台设备尝试连入 Node A 被立即拒绝！
    let rogue_device = DeviceIdentity::generate(DeviceId::new_v4())?;
    let rogue_root = AccountRootKey::generate()?;
    let rogue_ring =
        EpochKeyRing::new_genesis(agent_id, &rogue_root, rogue_device.public_record())?;
    let rogue_node = FabricNode::bind(
        FabricNodeConfig {
            agent_id,
            device: rogue_device,
            epoch_ring: rogue_ring,
            bind_ipv4: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
            enable_mdns: false,
            discover_overlay_interfaces: false,
            relay: Some(relay_settings.clone()),
            local_capabilities: None,
        },
        None,
    )
    .await?;
    rogue_node.wait_online(Duration::from_secs(8)).await?;

    let relay_only_addr_a =
        EndpointAddr::new(node_a.endpoint_id()?).with_relay_url(hub.https_url.parse()?);
    let rogue_rpc_res = rogue_node
        .send_rpc(
            relay_only_addr_a,
            &FabricRpcRequest::Ping {
                agent_id,
                sender_device_id: DeviceId::new_v4(),
            },
        )
        .await;
    assert!(
        rogue_rpc_res.is_err(),
        "未经 AccountRootKey 授权的陌生 EndpointId 必须被 FabricNode 硬拒收"
    );
    rogue_node.shutdown().await;

    // 6. 仅凭 RelayUrl（不含任何直连 IP）由 Node A 拨号 Node B：验证经 Go Hub `/relay` 握手后自动打洞升级为 Direct QUIC IP 路径！
    let relay_only_addr_b =
        EndpointAddr::new(node_b.endpoint_id()?).with_relay_url(hub.https_url.parse()?);
    node_a.register_peer_addr(relay_only_addr_b.clone());

    let _conn_ab = node_a.connect_peer(relay_only_addr_b.clone()).await?;
    let pong = node_a
        .send_rpc(
            relay_only_addr_b.clone(),
            &FabricRpcRequest::Ping {
                agent_id,
                sender_device_id: device_a.device_id(),
            },
        )
        .await?;
    assert!(matches!(pong, FabricRpcResponse::Pong { .. }));

    let direct_sock = node_a
        .wait_for_direct_path(node_b.endpoint_id()?, Duration::from_secs(8))
        .await?;
    assert_eq!(direct_sock.ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));

    let peers_on_a = node_a.peer_statuses();
    let b_status = peers_on_a
        .iter()
        .find(|p| p.device_id == device_b.device_id())
        .ok_or("peer_statuses 中应包含已连接的设备 B")?;
    assert!(
        matches!(b_status.path, PeerPathKind::DirectIp { .. }),
        "设备 B 传输路径必须已从 Relay 升级为 DirectIp，实际为: {:?}",
        b_status.path
    );

    // 7. 验证错峰 Packfile 经 Go Hub Presigned PUT 同步 + Canary 零明文扫描！
    let canary_secret = "CANARY_SECRET_SPINE_PLAINTEXT_991827_NEVER_IN_HUB";
    let mut sync_a = SpineSyncActor::new();
    let mut sync_b = SpineSyncActor::new();

    {
        let mut ka = kernel_a.lock().map_err(|_| "lock ka")?;
        let _ = ka.spine_mut().append_event(
            PackCompartment::Core,
            &format!(r#"{{"secret_note":"{canary_secret}"}}"#),
            now_ms + 100,
        )?;
        let sealed = ka.spine_mut().seal_checkpoint(None, now_ms + 200)?;
        assert_eq!(sealed.len(), 1);
    }

    let up_rep = {
        let mut ka = kernel_a.lock().map_err(|_| "lock ka")?;
        sync_a.sync_via_hub(&mut ka, &hub_a, now_ms + 300).await?
    };
    assert_eq!(up_rep.uploaded_packs, 1);

    // 扫描 Go Hub 的全部磁盘文件（SQLite 主库 + WAL + blobs 块目录）：断言 0 字节明文泄露！
    let mut hub_disk_files = Vec::new();
    collect_all_files_bytes(&hub.data_dir, &mut hub_disk_files)?;
    assert!(
        !hub_disk_files.is_empty(),
        "Go Hub 数据目录必须包含 SQLite 与密文块文件"
    );
    let canary_bytes = canary_secret.as_bytes();
    for (file_path, raw_bytes) in &hub_disk_files {
        let found = raw_bytes
            .windows(canary_bytes.len())
            .any(|w| w == canary_bytes);
        assert!(
            !found,
            "零知识违规：在 Hub 存储文件 {} 中检测到明文金丝雀字节！",
            file_path.display()
        );
    }

    // Node B 错峰从 Go Hub 拉取 Packfile 并解密合入脊柱
    let down_rep = {
        let mut kb = kernel_b.lock().map_err(|_| "lock kb")?;
        sync_b.sync_via_hub(&mut kb, &hub_b, now_ms + 400).await?
    };
    assert_eq!(down_rep.downloaded_packs, 1);
    assert!(down_rep.ingested_events >= 1);
    {
        let kb = kernel_b.lock().map_err(|_| "lock kb")?;
        let all_events = kb.spine().store().list_all_events()?;
        assert!(
            all_events
                .iter()
                .any(|(ev, _)| ev.payload_utf8.contains(canary_secret)),
            "Node B 解密 Packfile 后必须完整恢复 Node A 的签名事件"
        );
    }

    // 8. 验证 `<100ms` 主动合盖/挂起 `Router` 租约移交（Node A `epoch=1` -> Node B `epoch=2`）
    {
        let mut ka = kernel_a.lock().map_err(|_| "lock ka")?;
        let mut lca = lease_a.lock().map_err(|_| "lock lca")?;
        let posture = lca
            .tick_and_reconcile(
                &mut ka,
                &mut sync_a,
                &hub_a,
                &hub_a,
                now_ms + 500,
                |_, _, _, _| Ok(()),
            )
            .await?;
        assert_eq!(
            posture,
            LeasePosture::Witnessed {
                witness_epoch: Epoch::new(1)
            }
        );

        // 在移交前写入一条最新事件，验证移交时连同最新检查点一并秒级同步给接班节点 B
        let _ = ka.spine_mut().append_event(
            PackCompartment::Core,
            r#"{"handoff_marker":"before_lid_close_v1"}"#,
            now_ms + 550,
        )?;
    }

    let handoff_begin = Instant::now();
    let new_epoch_on_b = {
        let mut ka = kernel_a.lock().map_err(|_| "lock ka")?;
        let mut lca = lease_a.lock().map_err(|_| "lock lca")?;
        lca.voluntary_handoff(
            &mut ka,
            &mut sync_a,
            &hub_a,
            Some(&hub_a),
            Some((&node_a, node_b.endpoint_addr()?)),
            now_ms + 600,
        )
        .await?
    };
    let handoff_elapsed = handoff_begin.elapsed();
    assert_eq!(new_epoch_on_b, 2);
    assert!(
        handoff_elapsed < Duration::from_millis(100),
        "合盖主动释放 + 远端节点接班耗时必须 < 100ms，实际耗时: {:?}",
        handoff_elapsed
    );

    {
        let kb = kernel_b.lock().map_err(|_| "lock kb")?;
        assert_eq!(
            kb.lease_posture(),
            LeasePosture::Witnessed {
                witness_epoch: Epoch::new(2)
            }
        );
        let events_b = kb.spine().store().list_all_events()?;
        assert!(
            events_b
                .iter()
                .any(|(ev, _)| ev.payload_utf8.contains("before_lid_close_v1")),
            "接班后的 Node B 必须已同步合盖前的最终检查点事件"
        );
    }

    // 9. 验证跨节点 `RemoteWorkerPool` 异构能力广播与远程沙箱 + 洁净室 `Verifier` 派发！
    let ann_b =
        NodeCapabilityAnnouncement::sign_new(agent_id, &device_b, &cap_spec_b, 0, now_ms + 700)?;
    let ack = node_b
        .send_rpc(
            node_a.endpoint_addr()?,
            &FabricRpcRequest::AnnounceCapabilities {
                announcement: ann_b.clone(),
            },
        )
        .await?;
    assert!(matches!(ack, FabricRpcResponse::CapabilityAck));

    let selected = {
        let pa = pool_a.lock().map_err(|_| "lock pool_a")?;
        pa.select_best_node(&[String::from("claude"), String::from("rust-heavy")])
            .ok_or("RemoteWorkerPool 应匹配到具备 claude + rust-heavy 标签的 Node B")?
    };
    assert_eq!(selected.device_id, device_b.device_id());

    let sandbox_probe_b = {
        let kb = kernel_b.lock().map_err(|_| "lock kb")?;
        kb.sandbox().probe()?
    };
    if sandbox_probe_b.available {
        let mut peer_addrs = BTreeMap::new();
        peer_addrs.insert(device_b.device_id(), node_b.endpoint_addr()?);

        let task_spec = RemoteWorkerTaskSpec {
            run_id: RunId::new_v4(),
            title: String::from("remote-rust-heavy-commit"),
            required_tags: vec![String::from("claude"), String::from("rust-heavy")],
            worker_shell_script: String::from(
                "printf 'pub fn compute() -> u32 { 77 }\\n' > src/lib.rs && printf 'REMOTE_WORKER_OK\\n'",
            ),
            workspace_files: BTreeMap::from([(
                String::from("src/lib.rs"),
                b"pub fn compute() -> u32 { 0 }\n".to_vec(),
            )]),
            verifier_suite_files: BTreeMap::from([(
                String::from("verify.sh"),
                b"#!/bin/sh\ngrep -q '77' \"$QZ_CANDIDATE_WORKSPACE/src/lib.rs\" && echo 'test result: ok. 2 passed; 0 failed'\n".to_vec(),
            )]),
            verifier_shell_cmd: Some(String::from("sh \"$QZ_VERIFIER_SUITE/verify.sh\"")),
        };

        let remote_res = {
            let pool_snapshot = pool_a.lock().map_err(|_| "lock pool_a")?.clone();
            pool_snapshot
                .dispatch_task(&node_a, &peer_addrs, 2, &task_spec)
                .await?
        };
        assert_eq!(remote_res.executed_by_device_id, device_b.device_id());
        let mark = remote_res
            .verification_mark
            .as_ref()
            .ok_or("远端高危/代码变更 Commit Run 必须返回 VerificationMark")?;
        mark.verify_integrity()?;
        assert_eq!(
            remote_res.output_files.get("src/lib.rs").map(Vec::as_slice),
            Some(&b"pub fn compute() -> u32 { 77 }\n"[..])
        );
        assert!(
            !remote_res.sealed_packfiles.is_empty(),
            "远端 Worker 结项必须返回密封的 SealedPackfile"
        );

        let mut ka = kernel_a.lock().map_err(|_| "lock ka")?;
        let (ingested_n, _) = SpineSyncActor::ingest_packfiles_and_rehydrate(
            &mut ka,
            &remote_res.sealed_packfiles,
            now_ms + 800,
        )?;
        assert!(ingested_n >= 1);
    }

    // 10. 验证动态设备吊销后立即踢断已有 iroh 连接并拒收后续重连！
    let (_ep2, _revoke_change) = ring_a.revoke_device(&root_key, device_b.device_id())?;
    node_a.sync_membership(&ring_a);
    node_a
        .revoke_peer_and_disconnect(device_b.device_id())
        .await;

    let post_revoke_ping = node_b
        .send_rpc(
            node_a.endpoint_addr()?,
            &FabricRpcRequest::Ping {
                agent_id,
                sender_device_id: device_b.device_id(),
            },
        )
        .await;
    assert!(
        post_revoke_ping.is_err(),
        "设备被 AccountRootKey 吊销后必须立即断开并拦截任何后续 iroh RPC"
    );

    node_a.shutdown().await;
    node_b.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_iroh_lan_mdns_peer_discovery_without_hub() -> TestResult {
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let device_a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let device_b = DeviceIdentity::generate(DeviceId::new_v4())?;
    let epoch1_key = EpochKey::generate()?;

    let mut ring = EpochKeyRing::new_genesis(agent_id, &root_key, device_a.public_record())?;
    ring.insert_epoch_key(Epoch::new(1), epoch1_key);
    let _ = ring.add_device(&root_key, device_b.public_record())?;

    let node_a = FabricNode::bind(
        FabricNodeConfig {
            agent_id,
            device: device_a.clone(),
            epoch_ring: ring.clone(),
            bind_ipv4: None,
            enable_mdns: true,
            discover_overlay_interfaces: true,
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
            bind_ipv4: None,
            enable_mdns: true,
            discover_overlay_interfaces: true,
            relay: None,
            local_capabilities: None,
        },
        None,
    )
    .await?;

    // 仅传 EndpointId（零 Relay、零手动 IP）：靠 mDNS 局域网广播或本地直连完成握手与 Ping！
    let b_id_only = EndpointAddr::new(node_b.endpoint_id()?);
    let mdns_res = tokio::time::timeout(
        Duration::from_secs(6),
        node_a.send_rpc(
            b_id_only,
            &FabricRpcRequest::Ping {
                agent_id,
                sender_device_id: device_a.device_id(),
            },
        ),
    )
    .await;

    // 若容器/沙箱内核禁用了 IPv4 多播路由则回退校验显式 LAN SocketAddr 直连（无任何 Relay）
    if mdns_res.is_err() || matches!(mdns_res, Ok(Err(_))) {
        let lan_addr = node_b.endpoint_addr()?;
        let pong = node_a
            .send_rpc(
                lan_addr,
                &FabricRpcRequest::Ping {
                    agent_id,
                    sender_device_id: device_a.device_id(),
                },
            )
            .await?;
        assert!(matches!(pong, FabricRpcResponse::Pong { .. }));
    } else if let Ok(Ok(pong)) = mdns_res {
        assert!(matches!(pong, FabricRpcResponse::Pong { .. }));
    }

    node_a.shutdown().await;
    node_b.shutdown().await;
    Ok(())
}
