#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 出站发送商品化路径：真实 HTTP(S) 传输、凭据 URL/Header 模板、last_delivery 健康状态。

use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use quetzalcoatl_daemon::ChannelRuntime;
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

fn home(tag: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("qz_ch_out_{tag}_{}", Uuid::new_v4().simple()));
    fs::create_dir_all(dir.join("secrets"))?;
    Ok(dir)
}

fn write_secret(
    home: &Path,
    channel: &str,
    value: serde_json::Value,
) -> Result<(), Box<dyn Error>> {
    let path = home.join("secrets").join(format!("{channel}.json"));
    fs::write(path, value.to_string())?;
    Ok(())
}

type HookServer = (u16, thread::JoinHandle<Vec<u8>>);

/// 单次 HTTP 200 测试服务器。
fn start_http_ok_server() -> Result<HookServer, Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let handle = thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return Vec::new();
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = Vec::new();
        let mut chunk = [0u8; 2048];
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        buf
    });
    Ok((port, handle))
}

#[test]
fn channel_deliver_uses_credentials_real_http_and_records_health() -> TestResult {
    let home = home("ok")?;
    let (port, server) = start_http_ok_server()?;
    write_secret(
        &home,
        "webhook",
        serde_json::json!({"url": format!("http://127.0.0.1:{port}/hook"), "token": "synthetic-token", "secret": "synthetic-secret"}),
    )?;
    let mut runtime = ChannelRuntime::load(&home)?;
    runtime.enable("webhook")?;
    let report = runtime.deliver("webhook", "", "CANARY-SEND-BODY-998877")?;
    assert_eq!(report.channel, "webhook");
    assert_eq!(report.parts, 1);
    let request = server.join().map_err(|_| "server join")?;
    let text = String::from_utf8_lossy(&request);
    assert!(text.contains("Authorization: Bearer synthetic-token"));
    assert!(text.contains("X-QZ-Signature: sha256="));
    assert!(text.contains("CANARY-SEND-BODY-998877"));

    let health = runtime
        .health()
        .into_iter()
        .find(|h| h.channel == "webhook")
        .ok_or("missing health")?;
    let delivery = health.last_delivery.ok_or("missing last_delivery")?;
    assert!(delivery.ok);
    assert!(delivery.error.is_none());
    Ok(())
}

#[test]
fn channel_deliver_records_last_error_without_echoing_body() -> TestResult {
    let home = home("err")?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    write_secret(
        &home,
        "webhook",
        serde_json::json!({"url": format!("http://127.0.0.1:{port}/hook")}),
    )?;
    let mut runtime = ChannelRuntime::load(&home)?;
    runtime.enable("webhook")?;
    let err = runtime
        .deliver("webhook", "", "CANARY-ERROR-BODY-998877")
        .err()
        .ok_or("connection refused must fail")?;
    assert!(!err.to_string().contains("CANARY-ERROR-BODY-998877"));
    let health = runtime
        .health()
        .into_iter()
        .find(|h| h.channel == "webhook")
        .ok_or("missing health")?;
    let delivery = health.last_delivery.ok_or("missing last_delivery")?;
    assert!(!delivery.ok);
    let recorded = delivery.error.ok_or("missing error")?;
    assert!(!recorded.contains("CANARY-ERROR-BODY-998877"));
    Ok(())
}

#[test]
fn channel_deliver_attempts_https_destination() -> TestResult {
    let home = home("https")?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let attempted = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&attempted);
    let handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut first = [0u8; 1];
            if stream.read(&mut first).is_ok() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    });
    write_secret(
        &home,
        "webhook",
        serde_json::json!({"url": format!("https://127.0.0.1:{port}/hook")}),
    )?;
    let mut runtime = ChannelRuntime::load(&home)?;
    runtime.enable("webhook")?;
    let _ = runtime.deliver("webhook", "", "https-attempt");
    handle.join().map_err(|_| "https server join")?;
    assert!(
        attempted.load(Ordering::SeqCst),
        "https:// destination must attempt a real TLS connection"
    );
    Ok(())
}

#[test]
fn channel_runtime_skips_stale_state_entry_without_failing_startup() -> TestResult {
    let home = home("stale")?;
    fs::create_dir_all(home.join("channels"))?;
    fs::write(
        home.join("channels/state.json"),
        r#"{"enabled":["not-a-real-channel","webhook"]}"#,
    )?;
    let runtime = ChannelRuntime::load(&home)?;
    assert!(runtime.is_enabled("webhook"));
    assert!(!runtime.is_enabled("not-a-real-channel"));
    Ok(())
}

#[test]
fn second_delivery_attempt_is_refused_after_single_use_endpoint() -> TestResult {
    let home = home("once")?;
    let (port, server) = start_http_ok_server()?;
    write_secret(
        &home,
        "webhook",
        serde_json::json!({"url": format!("http://127.0.0.1:{port}/hook")}),
    )?;
    let mut runtime = ChannelRuntime::load(&home)?;
    runtime.enable("webhook")?;
    runtime.deliver("webhook", "", "first")?;
    let wire = server.join().map_err(|_| "server join")?;
    assert!(String::from_utf8_lossy(&wire).contains("first"));
    let err = runtime
        .deliver("webhook", "", "second")
        .err()
        .ok_or("second delivery must be refused by closed transport")?;
    assert!(!err.to_string().is_empty());
    Ok(())
}

type TlsServer = (u16, thread::JoinHandle<Vec<u8>>, Vec<u8>);

fn spawn_tls_server() -> Result<TlsServer, Box<dyn Error>> {
    use rcgen::{
        BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
        IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType,
    };
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let mut ca_dn = DistinguishedName::new();
    ca_dn.push(DnType::CommonName, "Test CA");
    ca_params.distinguished_name = ca_dn;
    let ca_key = KeyPair::generate()?;
    let ca_cert = ca_params.self_signed(&ca_key)?;
    let ca_issuer = Issuer::from_params(&ca_params, ca_key);

    let mut leaf_params = CertificateParams::default();
    leaf_params.is_ca = IsCa::NoCa;
    leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    leaf_params.subject_alt_names = vec![
        SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)),
        SanType::DnsName("localhost".try_into()?),
    ];
    let mut leaf_dn = DistinguishedName::new();
    leaf_dn.push(DnType::CommonName, "127.0.0.1");
    leaf_params.distinguished_name = leaf_dn;
    let leaf_key = KeyPair::generate()?;
    let leaf_cert = leaf_params.signed_by(&leaf_key, &ca_issuer)?;

    let certs = vec![CertificateDer::from(leaf_cert.der().to_vec())];
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let handle = thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else {
            return Vec::new();
        };
        let Ok(conn) = rustls::ServerConnection::new(Arc::new(config)) else {
            return Vec::new();
        };
        let mut tls = rustls::StreamOwned::new(conn, stream);
        let mut buf = Vec::new();
        let mut chunk = [0u8; 2048];
        loop {
            match std::io::Read::read(&mut tls, &mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
            }
        }
        let _ = std::io::Write::write_all(
            &mut tls,
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        buf
    });
    Ok((port, handle, ca_cert.der().to_vec()))
}

#[test]
fn https_certificate_verification_requires_trusted_ca() -> TestResult {
    // 1) 默认系统根：自建 CA 必须验证失败。
    let home_untrusted = home("tls-untrusted")?;
    let (port_u, server_u, _ca_u) = spawn_tls_server()?;
    write_secret(
        &home_untrusted,
        "webhook",
        serde_json::json!({"url": format!("https://127.0.0.1:{port_u}/hook")}),
    )?;
    let mut untrusted = ChannelRuntime::load(&home_untrusted)?;
    untrusted.enable("webhook")?;
    let err = untrusted
        .deliver("webhook", "", "untrusted")
        .err()
        .ok_or("self-signed server must fail certificate verification")?;
    assert!(!err.to_string().is_empty());
    let _ = server_u.join();

    // 2) 注入可信测试 CA：同一证书链必须成功。
    let home_trusted = home("tls-trusted")?;
    let (port_t, server_t, ca_der) = spawn_tls_server()?;
    write_secret(
        &home_trusted,
        "webhook",
        serde_json::json!({"url": format!("https://127.0.0.1:{port_t}/hook")}),
    )?;
    let mut trusted = ChannelRuntime::load_with_extra_root_der_certs(&home_trusted, vec![ca_der])?;
    trusted.enable("webhook")?;
    trusted.deliver("webhook", "", "trusted")?;
    let wire = server_t.join().map_err(|_| "tls server join")?;
    assert!(String::from_utf8_lossy(&wire).contains("trusted"));
    Ok(())
}

#[test]
fn partition_outbox_replays_full_channel_payload_once_after_witnessed() -> TestResult {
    use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing};
    use quetzalcoatl_kernel::{
        BlindKernel, CapabilityDescriptor, CapabilityInvocation, CapabilityOrigin, CapabilitySet,
        ExecutionSurface, HeartScheduler, LeasePosture, PrincipalRole, ScopeChain, SinkClass,
        SleepPhase,
    };
    use quetzalcoatl_sandbox::{SandboxConfig, SandboxManager};
    use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
    use quetzalcoatl_types::{AgentId, DeviceId, Epoch, HlcTimestamp};

    let home = home("outbox")?;
    let (port, server) = start_http_ok_server()?;
    write_secret(
        &home,
        "webhook",
        serde_json::json!({"url": format!("http://127.0.0.1:{port}/hook")}),
    )?;
    let agent = AgentId::new_v4();
    let root = AccountRootKey::generate()?;
    let device = DeviceIdentity::generate(DeviceId::new_v4())?;
    let ring = EpochKeyRing::new_genesis(agent, &root, device.public_record())?;
    let store = RusqliteWalStore::open(&home.join("spine.sqlite"))?;
    let hlc = HlcTimestamp::from_parts(1_795_400_000_000, 0, device.device_id().hlc_node_tag());
    let spine = SpineEngine::new(agent, device, ring, hlc, store)?;
    let sandbox = SandboxManager::new(SandboxConfig::new(&home));
    let mut kernel = BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(1, 0.15, SleepPhase::Awake),
        LeasePosture::PartitionLocal,
    );
    kernel.register_capability(CapabilityDescriptor {
        capability_id: String::from("external.send"),
        interface_id: String::from("quetzalcoatl.core"),
        sink_class: SinkClass::HighRiskExternalWrite,
        surface: ExecutionSurface::ExternalChannel,
        idempotent: false,
        origin: CapabilityOrigin::HostRegistered,
    })?;
    let mut invocation = CapabilityInvocation::new(
        "external.send",
        serde_json::json!({
            "channel": "webhook",
            "destination": "",
            "text": "OUTBOX-REPLAY-CANARY",
            "idempotency_key": "outbox-replay-1",
        })
        .to_string(),
    );
    invocation.idempotency_key = Some(String::from("outbox-replay-1"));
    let denied = kernel.authorize_capability(
        PrincipalRole::Worker,
        None,
        CapabilitySet::All,
        ScopeChain::unrestricted(),
        std::collections::BTreeSet::from(["external.send".to_owned()]),
        &invocation,
        1_795_400_000_100,
    );
    assert!(denied.is_err());
    assert_eq!(kernel.ledger().outbox().len(), 1);

    kernel.set_lease_posture(LeasePosture::Witnessed {
        witness_epoch: Epoch::new(2),
    });
    let items = kernel.drain_reconciled_outbox(Epoch::new(2))?;
    assert_eq!(items.len(), 1);
    assert!(kernel.ledger().outbox().is_empty());
    let args: serde_json::Value = serde_json::from_str(&items[0].arguments_json)?;
    let mut runtime = ChannelRuntime::load(&home)?;
    runtime.enable("webhook")?;
    runtime.deliver(
        args["channel"].as_str().ok_or("channel")?,
        args["destination"].as_str().unwrap_or(""),
        args["text"].as_str().ok_or("text")?,
    )?;
    let wire = server.join().map_err(|_| "server join")?;
    assert!(String::from_utf8_lossy(&wire).contains("OUTBOX-REPLAY-CANARY"));
    assert!(kernel.drain_reconciled_outbox(Epoch::new(2))?.is_empty());
    Ok(())
}
