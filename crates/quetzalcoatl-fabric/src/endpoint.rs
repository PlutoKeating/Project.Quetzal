#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `FabricNode`（`iroh 1.5.0` 端点封装、双向设备授权门禁、LAN mDNS / Overlay IP / Go Hub QAD 穿透）与 `HubClient`。

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::str::FromStr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use ed25519_dalek::{Signer, SigningKey};
use iroh::address_lookup::{EndpointInfo, MemoryLookup};
use iroh::endpoint::{
    AfterHandshakeOutcome, BeforeConnectOutcome, Connection, EndpointHooks, PortmapperConfig,
    WeakConnectionHandle, presets,
};
use iroh::tls::CaTlsConfig;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, NetReportConfig, RelayConfig, RelayMap, RelayMode,
    RelayUrl, SecretKey, Watcher,
};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use iroh_relay::RelayQuicConfig;
use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, DevicePublicRecord, EpochKeyRing, OpaqueMhfParams, PackAad,
    PackCompartment, RootWrapSlot, SealedPackfile, Slot4WrappedRootKey, WrappedRootKeySlot,
    XWING_ENC_LEN, XWING_PK_LEN, hex_decode, hex_decode_fixed, hex_encode,
    opaque_client_build_registration, opaque_client_finish_3dh, opaque_finalize_oprf,
    opaque_harden_randomized_pwd, opaque_open_envelope, opaque_oprf_blind_deterministic,
    opaque_random_scalar_and_point,
};
use quetzalcoatl_types::{
    AgentId, ArtifactId, DeviceId, Epoch, HlcTimestamp, QuetzalcoatlError, Result,
};
use rand_core::{OsRng, RngCore};
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::worker_pool::{
    NodeCapabilityAnnouncement, NodeCapabilitySpec, RemoteWorkerTaskResult, RemoteWorkerTaskSpec,
};

/// `quetzalcoatl-fabric` 自定义 QUIC ALPN 协议标识。
pub const FABRIC_ALPN: &[u8] = b"/quetzalcoatl/fabric/v2";

const MAX_FABRIC_RPC_BYTES: usize = 32 * 1024 * 1024;
const OPAQUE_DEFAULT_CONTEXT: &[u8] = b"Quetzalcoatl-OPAQUE-Slot4-v1";

/// 解析 PEM 或原始 DER 格式的自定义根证书/固定服务端证书字节。
pub fn parse_ca_certs_pem_or_der(raw: &[u8]) -> Result<Vec<Vec<u8>>> {
    if let Ok(text) = std::str::from_utf8(raw)
        && text.contains("-----BEGIN CERTIFICATE-----")
    {
        let mut certs = Vec::new();
        let mut rest = text;
        while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
            let after_begin = &rest[start + "-----BEGIN CERTIFICATE-----".len()..];
            let Some(end) = after_begin.find("-----END CERTIFICATE-----") else {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: String::from("PEM 证书缺少 END CERTIFICATE 标记"),
                });
            };
            let b64_body: String = after_begin[..end]
                .chars()
                .filter(|c| !c.is_ascii_whitespace())
                .collect();
            let der = base64_std_decode(&b64_body)?;
            if !der.is_empty() {
                certs.push(der);
            }
            rest = &after_begin[end + "-----END CERTIFICATE-----".len()..];
        }
        if certs.is_empty() {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("PEM 文件中未解析出有效证书"),
            });
        }
        return Ok(certs);
    }
    if raw.is_empty() {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("证书内容为空"),
        });
    }
    Ok(vec![raw.to_vec()])
}

fn base64url_nopad_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0usize;
    while i + 3 <= bytes.len() {
        let n =
            (u32::from(bytes[i]) << 16) | (u32::from(bytes[i + 1]) << 8) | u32::from(bytes[i + 2]);
        out.push(char::from(TABLE[((n >> 18) & 0x3f) as usize]));
        out.push(char::from(TABLE[((n >> 12) & 0x3f) as usize]));
        out.push(char::from(TABLE[((n >> 6) & 0x3f) as usize]));
        out.push(char::from(TABLE[(n & 0x3f) as usize]));
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = u32::from(bytes[i]) << 16;
        out.push(char::from(TABLE[((n >> 18) & 0x3f) as usize]));
        out.push(char::from(TABLE[((n >> 12) & 0x3f) as usize]));
    } else if rem == 2 {
        let n = (u32::from(bytes[i]) << 16) | (u32::from(bytes[i + 1]) << 8);
        out.push(char::from(TABLE[((n >> 18) & 0x3f) as usize]));
        out.push(char::from(TABLE[((n >> 12) & 0x3f) as usize]));
        out.push(char::from(TABLE[((n >> 6) & 0x3f) as usize]));
    }
    out
}

fn decode_b64_val(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

fn base64_std_decode(input: &str) -> Result<Vec<u8>> {
    let clean = input.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    let mut i = 0usize;
    while i + 4 <= clean.len() {
        let a = decode_b64_val(clean[i]).ok_or_else(|| QuetzalcoatlError::SerializationError {
            detail: String::from("非法 Base64 字符"),
        })?;
        let b =
            decode_b64_val(clean[i + 1]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("非法 Base64 字符"),
            })?;
        let c =
            decode_b64_val(clean[i + 2]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("非法 Base64 字符"),
            })?;
        let d =
            decode_b64_val(clean[i + 3]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("非法 Base64 字符"),
            })?;
        let n = (u32::from(a) << 18) | (u32::from(b) << 12) | (u32::from(c) << 6) | u32::from(d);
        out.push(((n >> 16) & 0xff) as u8);
        out.push(((n >> 8) & 0xff) as u8);
        out.push((n & 0xff) as u8);
        i += 4;
    }
    let rem = clean.len() - i;
    if rem == 2 {
        let a = decode_b64_val(clean[i]).ok_or_else(|| QuetzalcoatlError::SerializationError {
            detail: String::from("非法 Base64 字符"),
        })?;
        let b =
            decode_b64_val(clean[i + 1]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("非法 Base64 字符"),
            })?;
        let n = (u32::from(a) << 18) | (u32::from(b) << 12);
        out.push(((n >> 16) & 0xff) as u8);
    } else if rem == 3 {
        let a = decode_b64_val(clean[i]).ok_or_else(|| QuetzalcoatlError::SerializationError {
            detail: String::from("非法 Base64 字符"),
        })?;
        let b =
            decode_b64_val(clean[i + 1]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("非法 Base64 字符"),
            })?;
        let c =
            decode_b64_val(clean[i + 2]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("非法 Base64 字符"),
            })?;
        let n = (u32::from(a) << 18) | (u32::from(b) << 12) | (u32::from(c) << 6);
        out.push(((n >> 16) & 0xff) as u8);
        out.push(((n >> 8) & 0xff) as u8);
    } else if rem == 1 {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("非法 Base64 尾部长度"),
        });
    }
    Ok(out)
}

#[derive(Debug)]
struct PinnedOrCaCertVerifier {
    webpki: Option<Arc<WebPkiServerVerifier>>,
    pinned_der: Vec<Vec<u8>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedOrCaCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if let Some(verifier) = &self.webpki
            && let Ok(ok) = verifier.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            )
        {
            return Ok(ok);
        }
        if self
            .pinned_der
            .iter()
            .any(|p| p.as_slice() == end_entity.as_ref())
        {
            return Ok(ServerCertVerified::assertion());
        }
        Err(rustls::Error::General(String::from(
            "untrusted server certificate (neither CA-verified nor pinned)",
        )))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn build_ca_tls_config(custom_ca_certs_der: &[Vec<u8>]) -> CaTlsConfig {
    if custom_ca_certs_der.is_empty() {
        return CaTlsConfig::embedded();
    }
    let certs_owned = custom_ca_certs_der.to_vec();
    CaTlsConfig::custom_server_cert_verifier(Arc::new(move |provider| {
        let mut store = rustls::RootCertStore::empty();
        for der in &certs_owned {
            let _ = store.add(CertificateDer::from(der.clone()));
        }
        let webpki = if store.is_empty() {
            None
        } else {
            WebPkiServerVerifier::builder_with_provider(Arc::new(store), Arc::clone(&provider))
                .build()
                .ok()
        };
        Ok(Arc::new(PinnedOrCaCertVerifier {
            webpki,
            pinned_der: certs_owned.clone(),
            provider,
        }))
    }))
}

fn build_rustls_client_config(custom_ca_certs_der: &[Vec<u8>]) -> Result<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let ca_cfg = if custom_ca_certs_der.is_empty() {
        CaTlsConfig::embedded().with_extra_roots(rustls_native_certs::load_native_certs().certs)
    } else {
        build_ca_tls_config(custom_ca_certs_der)
    };
    ca_cfg
        .client_config(provider)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("构造 TLS ClientConfig 失败: {e}"),
        })
}

/// 探测本机已有的 Tailscale（`100.64.0.0/10` CGNAT）或 WireGuard Overlay 接口地址（零系统 VPN 槽位侵占）。
fn probe_overlay_ipv4_candidates(port_hint: u16) -> Vec<SocketAddr> {
    let mut found = BTreeSet::<Ipv4Addr>::new();
    // 尝试通过无发送 UDP connect 探测到 CGNAT 100.100.100.100 的本机源地址（若系统装有 Tailscale 等 Overlay 路由则命中 100.64.0.0/10）
    if let Ok(sock) = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        && sock
            .connect(SocketAddr::from((Ipv4Addr::new(100, 100, 100, 100), 53)))
            .is_ok()
        && let Ok(SocketAddr::V4(local)) = sock.local_addr()
    {
        let oct = local.ip().octets();
        if oct[0] == 100 && (oct[1] & 0xc0) == 64 {
            found.insert(*local.ip());
        }
    }
    found
        .into_iter()
        .filter(|ip| port_hint > 0 && !ip.is_unspecified())
        .map(|ip| SocketAddr::new(IpAddr::V4(ip), port_hint))
        .collect()
}

/// 自建或官方零知识 `quetzalcoatl-hub` 中继与 QAD 配置（默认完全禁用 n0 官方中继）。
#[derive(Clone, Debug)]
pub struct FabricRelaySettings {
    pub relay_url: String,
    pub qad_port: u16,
    pub auth_token: Option<String>,
    pub custom_ca_certs_der: Vec<Vec<u8>>,
}

/// `FabricNode` 启动配置。
#[derive(Clone)]
pub struct FabricNodeConfig {
    pub agent_id: AgentId,
    pub device: DeviceIdentity,
    pub epoch_ring: EpochKeyRing,
    pub bind_ipv4: Option<SocketAddr>,
    pub enable_mdns: bool,
    pub discover_overlay_interfaces: bool,
    pub relay: Option<FabricRelaySettings>,
    pub local_capabilities: Option<NodeCapabilitySpec>,
}

/// 对等节点当前活跃传输路径类型。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PeerPathKind {
    DirectIp { addr: SocketAddr, rtt_ms: u64 },
    Relay { relay_url: String, rtt_ms: u64 },
    Disconnected,
}

/// 对等节点综合状态快照（供 `qz nodes` 与调度器查询）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerStatusSnapshot {
    pub device_id: DeviceId,
    pub endpoint_id_hex: String,
    pub authorized: bool,
    pub path: PeerPathKind,
    pub capabilities: Option<NodeCapabilityAnnouncement>,
}

/// QAD（`/iroh-qad/0`）公网反射地址探测结果快照。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QadReportSnapshot {
    pub udp_v4: bool,
    pub global_v4: Option<SocketAddrV4>,
    pub preferred_relay: Option<String>,
}

/// 跨节点 `iroh` RPC 请求帧。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FabricRpcRequest {
    Ping {
        agent_id: AgentId,
        sender_device_id: DeviceId,
    },
    PushPackfiles {
        agent_id: AgentId,
        sender_device_id: DeviceId,
        packs: Vec<SealedPackfile>,
    },
    PullPackfiles {
        agent_id: AgentId,
        sender_device_id: DeviceId,
        known_heads: Vec<(DeviceId, u64)>,
    },
    VoluntaryLeaseHandoff {
        agent_id: AgentId,
        from_device_id: DeviceId,
        released_epoch: u64,
        latest_packs: Vec<SealedPackfile>,
    },
    AnnounceCapabilities {
        announcement: NodeCapabilityAnnouncement,
    },
    ExecuteRemoteWorkerTask {
        agent_id: AgentId,
        requester_device_id: DeviceId,
        witness_epoch: u64,
        task: RemoteWorkerTaskSpec,
    },
}

/// 跨节点 `iroh` RPC 响应帧。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FabricRpcResponse {
    Pong {
        responder_device_id: DeviceId,
        capability: Option<NodeCapabilityAnnouncement>,
    },
    PackfilesAck {
        ingested_events: usize,
    },
    PackfilesBatch {
        packs: Vec<SealedPackfile>,
    },
    LeaseHandoffAccepted {
        new_holder_device_id: DeviceId,
        new_witness_epoch: u64,
    },
    CapabilityAck,
    RemoteWorkerTaskCompleted {
        result: Box<RemoteWorkerTaskResult>,
    },
    Error {
        code: String,
        detail: String,
    },
}

/// 应用层挂载在 `FabricNode` 上的入站 RPC 处理器。
pub trait FabricRpcHandler: Send + Sync + 'static {
    fn handle_rpc(
        &self,
        authenticated_peer_device: DeviceId,
        req: FabricRpcRequest,
    ) -> FabricRpcResponse;
}

#[derive(Default, Debug)]
struct AuthorizedPeerDirectory {
    pubkey_to_device: BTreeMap<[u8; 32], DeviceId>,
    device_to_pubkey: BTreeMap<DeviceId, [u8; 32]>,
    capabilities: BTreeMap<DeviceId, NodeCapabilityAnnouncement>,
}

impl AuthorizedPeerDirectory {
    fn from_ring(ring: &EpochKeyRing, local_device_id: DeviceId) -> Self {
        let mut dir = Self::default();
        dir.sync_from_ring(ring, local_device_id);
        dir
    }

    fn sync_from_ring(&mut self, ring: &EpochKeyRing, local_device_id: DeviceId) {
        self.pubkey_to_device.clear();
        self.device_to_pubkey.clear();
        for (&dev_id, rec) in ring.active_devices() {
            if dev_id == local_device_id {
                continue;
            }
            self.pubkey_to_device.insert(rec.ed25519_pubkey, dev_id);
            self.device_to_pubkey.insert(dev_id, rec.ed25519_pubkey);
        }
        self.capabilities
            .retain(|dev_id, _| self.device_to_pubkey.contains_key(dev_id));
    }
}

#[derive(Clone, Debug)]
struct SovereignAuthHook {
    peers: Arc<RwLock<AuthorizedPeerDirectory>>,
    weak_conns: Arc<Mutex<BTreeMap<EndpointId, Vec<WeakConnectionHandle>>>>,
}

impl EndpointHooks for SovereignAuthHook {
    async fn before_connect<'a>(
        &'a self,
        remote_addr: &'a EndpointAddr,
        alpn: &'a [u8],
    ) -> BeforeConnectOutcome {
        if alpn != FABRIC_ALPN {
            return BeforeConnectOutcome::Reject;
        }
        let allowed = self
            .peers
            .read()
            .map(|g| g.pubkey_to_device.contains_key(remote_addr.id.as_bytes()))
            .unwrap_or(false);
        if allowed {
            BeforeConnectOutcome::Accept
        } else {
            BeforeConnectOutcome::Reject
        }
    }

    async fn after_handshake<'a>(&'a self, conn: &'a Connection) -> AfterHandshakeOutcome {
        if conn.alpn() != FABRIC_ALPN {
            return AfterHandshakeOutcome::Reject {
                error_code: 400u32.into(),
                reason: b"unsupported ALPN".to_vec(),
            };
        }
        let remote_id = conn.remote_id();
        let allowed = self
            .peers
            .read()
            .map(|g| g.pubkey_to_device.contains_key(remote_id.as_bytes()))
            .unwrap_or(false);
        if !allowed {
            return AfterHandshakeOutcome::Reject {
                error_code: 403u32.into(),
                reason: b"unauthorized or revoked device".to_vec(),
            };
        }
        if let Ok(mut conns) = self.weak_conns.lock() {
            let list = conns.entry(remote_id).or_default();
            list.retain(|w| w.upgrade().is_some());
            list.push(conn.weak_handle());
        }
        AfterHandshakeOutcome::Accept
    }
}

fn inspect_connection_best_path(conn: &Connection) -> PeerPathKind {
    let paths = conn.paths();
    let mut best_ip: Option<(SocketAddr, u64)> = None;
    let mut best_relay: Option<(String, u64)> = None;

    for p in paths.iter() {
        let rtt_ms = u64::try_from(p.stats().rtt.as_millis()).unwrap_or(0);
        match p.remote_addr() {
            iroh::TransportAddr::Ip(sock) if p.is_selected() || best_ip.is_none() => {
                best_ip = Some((*sock, rtt_ms));
            }
            iroh::TransportAddr::Relay(url) if p.is_selected() || best_relay.is_none() => {
                best_relay = Some((url.to_string(), rtt_ms));
            }
            _ => {}
        }
    }

    if let Some((addr, rtt_ms)) = best_ip {
        PeerPathKind::DirectIp { addr, rtt_ms }
    } else if let Some((relay_url, rtt_ms)) = best_relay {
        PeerPathKind::Relay { relay_url, rtt_ms }
    } else {
        PeerPathKind::Disconnected
    }
}

fn extract_sender_device_from_req(
    agent_id: AgentId,
    req: &FabricRpcRequest,
) -> Result<(AgentId, DeviceId)> {
    match req {
        FabricRpcRequest::Ping {
            agent_id: a,
            sender_device_id: d,
        }
        | FabricRpcRequest::PushPackfiles {
            agent_id: a,
            sender_device_id: d,
            ..
        }
        | FabricRpcRequest::PullPackfiles {
            agent_id: a,
            sender_device_id: d,
            ..
        } => Ok((*a, *d)),
        FabricRpcRequest::VoluntaryLeaseHandoff {
            agent_id: a,
            from_device_id: d,
            ..
        } => Ok((*a, *d)),
        FabricRpcRequest::AnnounceCapabilities { announcement } => {
            Ok((announcement.agent_id, announcement.device_id))
        }
        FabricRpcRequest::ExecuteRemoteWorkerTask {
            agent_id: a,
            requester_device_id: d,
            ..
        } => Ok((*a, *d)),
        #[allow(unreachable_patterns)]
        _ => Err(QuetzalcoatlError::SerializationError {
            detail: format!("unknown RPC for {agent_id}"),
        }),
    }
}

/// 真实 `iroh 1.5.0` P2P 加密平面节点。
#[derive(Clone)]
pub struct FabricNode {
    agent_id: AgentId,
    device_id: DeviceId,
    endpoint: Endpoint,
    mem_lookup: MemoryLookup,
    peers: Arc<RwLock<AuthorizedPeerDirectory>>,
    weak_conns: Arc<Mutex<BTreeMap<EndpointId, Vec<WeakConnectionHandle>>>>,
    pooled_conns: Arc<Mutex<BTreeMap<EndpointId, Connection>>>,
    overlay_addrs: Vec<SocketAddr>,
    relay_url: Option<String>,
    accept_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl FabricNode {
    pub async fn bind(
        config: FabricNodeConfig,
        rpc_handler: Option<Arc<dyn FabricRpcHandler>>,
    ) -> Result<Self> {
        if config.epoch_ring.agent_id() != config.agent_id {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("FabricNodeConfig agent_id 与 EpochKeyRing 不一致"),
            });
        }
        let local_dev_id = config.device.device_id();
        let secret_key = SecretKey::from_bytes(config.device.ed25519_seed());
        let peers = Arc::new(RwLock::new(AuthorizedPeerDirectory::from_ring(
            &config.epoch_ring,
            local_dev_id,
        )));
        let weak_conns: Arc<Mutex<BTreeMap<EndpointId, Vec<WeakConnectionHandle>>>> =
            Arc::new(Mutex::new(BTreeMap::new()));

        let auth_hook = SovereignAuthHook {
            peers: Arc::clone(&peers),
            weak_conns: Arc::clone(&weak_conns),
        };
        let mem_lookup = MemoryLookup::new();

        // 使用 presets::Minimal，彻底禁用 n0 官方中继与 n0 Pkarr/DNS！
        let mut net_rep_cfg = NetReportConfig::default();
        net_rep_cfg.captive_portal_check = false;

        let mut builder = Endpoint::builder(presets::Minimal)
            .secret_key(secret_key)
            .alpns(vec![FABRIC_ALPN.to_vec()])
            .portmapper_config(PortmapperConfig::Disabled)
            .net_report_config(net_rep_cfg)
            .hooks(auth_hook)
            .address_lookup(mem_lookup.clone());

        if let Some(bind_addr) = config.bind_ipv4 {
            builder = builder
                .clear_ip_transports()
                .bind_addr(bind_addr)
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("绑定 FabricNode UDP 地址失败 ({bind_addr}): {e}"),
                })?;
        }

        if config.enable_mdns {
            builder = builder.address_lookup(MdnsAddressLookup::builder());
        }

        if let Some(relay_cfg) = &config.relay {
            let relay_url = RelayUrl::from_str(&relay_cfg.relay_url).map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: format!("非法 Hub Relay URL ({}): {e}", relay_cfg.relay_url),
                }
            })?;
            let mut rc =
                RelayConfig::new(relay_url, Some(RelayQuicConfig::new(relay_cfg.qad_port)));
            if let Some(tok) = &relay_cfg.auth_token {
                rc = rc.with_auth_token(tok.clone());
            }
            builder = builder
                .relay_mode(RelayMode::Custom(RelayMap::from(rc)))
                .ca_tls_config(build_ca_tls_config(&relay_cfg.custom_ca_certs_der));
        } else {
            builder = builder.relay_mode(RelayMode::Disabled);
        }

        let endpoint = builder
            .bind()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("启动 iroh 1.5 Endpoint 失败: {e}"),
            })?;

        let configured_relay_url = config.relay.as_ref().map(|r| r.relay_url.clone());
        let mut overlay_addrs = Vec::new();
        if config.discover_overlay_interfaces {
            let bound_v4_port = endpoint
                .bound_sockets()
                .into_iter()
                .find_map(|s| if s.is_ipv4() { Some(s.port()) } else { None })
                .unwrap_or(0);
            overlay_addrs = probe_overlay_ipv4_candidates(bound_v4_port);
            for ext in &overlay_addrs {
                endpoint.add_external_addr(*ext).await;
            }
        }

        let local_cap_ann = match &config.local_capabilities {
            Some(spec) => Some(NodeCapabilityAnnouncement::sign_new(
                config.agent_id,
                &config.device,
                spec,
                0,
                0,
            )?),
            None => None,
        };

        let ep_accept = endpoint.clone();
        let peers_accept = Arc::clone(&peers);
        let weak_accept = Arc::clone(&weak_conns);
        let agent_id = config.agent_id;

        let accept_join = tokio::spawn(async move {
            while let Some(incoming) = ep_accept.accept().await {
                let Ok(accepting) = incoming.accept() else {
                    continue;
                };
                let peers_conn = Arc::clone(&peers_accept);
                let weak_conn = Arc::clone(&weak_accept);
                let handler_conn = rpc_handler.clone();
                let local_cap_clone = local_cap_ann.clone();

                tokio::spawn(async move {
                    let Ok(conn) = accepting.await else {
                        return;
                    };
                    let remote_id = conn.remote_id();
                    let auth_dev = peers_conn
                        .read()
                        .ok()
                        .and_then(|g| g.pubkey_to_device.get(remote_id.as_bytes()).copied());
                    let Some(peer_device_id) = auth_dev else {
                        conn.close(403u32.into(), b"unauthorized device");
                        return;
                    };
                    if let Ok(mut wc) = weak_conn.lock() {
                        wc.entry(remote_id).or_default().push(conn.weak_handle());
                    }

                    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                        // 每次收到新流前再次校验该设备未被动态吊销！
                        let still_active =
                            peers_conn.read().ok().and_then(|g| {
                                g.pubkey_to_device.get(remote_id.as_bytes()).copied()
                            }) == Some(peer_device_id);
                        if !still_active {
                            conn.close(403u32.into(), b"device revoked");
                            break;
                        }

                        let peers_stream = Arc::clone(&peers_conn);
                        let handler_stream = handler_conn.clone();
                        let cap_stream = local_cap_clone.clone();

                        tokio::spawn(async move {
                            let mut len_buf = [0u8; 4];
                            if recv.read_exact(&mut len_buf).await.is_err() {
                                return;
                            }
                            let frame_len = u32::from_be_bytes(len_buf) as usize;
                            if frame_len == 0 || frame_len > MAX_FABRIC_RPC_BYTES {
                                return;
                            }
                            let mut body = vec![0u8; frame_len];
                            if recv.read_exact(&mut body).await.is_err() {
                                return;
                            }
                            let req: FabricRpcRequest = match serde_json::from_slice(&body) {
                                Ok(r) => r,
                                Err(e) => {
                                    let _ = write_rpc_frame(
                                        &mut send,
                                        &FabricRpcResponse::Error {
                                            code: String::from("SERIALIZATION_ERROR"),
                                            detail: e.to_string(),
                                        },
                                    )
                                    .await;
                                    return;
                                }
                            };

                            let resp = match extract_sender_device_from_req(agent_id, &req) {
                                Ok((req_agent, claimed_dev))
                                    if req_agent == agent_id && claimed_dev == peer_device_id =>
                                {
                                    if let FabricRpcRequest::AnnounceCapabilities {
                                        ref announcement,
                                    } = req
                                        && let Ok(mut pg) = peers_stream.write()
                                    {
                                        pg.capabilities
                                            .insert(peer_device_id, announcement.clone());
                                    }
                                    match (req, handler_stream) {
                                        (FabricRpcRequest::Ping { .. }, None) => {
                                            FabricRpcResponse::Pong {
                                                responder_device_id: local_dev_id,
                                                capability: cap_stream,
                                            }
                                        }
                                        (r, Some(h)) => {
                                            let res = tokio::task::spawn_blocking(move || {
                                                h.handle_rpc(peer_device_id, r)
                                            })
                                            .await;
                                            match res {
                                                Ok(mut out) => {
                                                    if let FabricRpcResponse::Pong {
                                                        ref mut responder_device_id,
                                                        ref mut capability,
                                                    } = out
                                                    {
                                                        *responder_device_id = local_dev_id;
                                                        if capability.is_none() {
                                                            *capability = cap_stream;
                                                        }
                                                    }
                                                    out
                                                }
                                                Err(e) => FabricRpcResponse::Error {
                                                    code: String::from("STORAGE_ERROR"),
                                                    detail: e.to_string(),
                                                },
                                            }
                                        }
                                        (_, None) => FabricRpcResponse::Error {
                                            code: String::from("PERMISSION_DENIED"),
                                            detail: String::from("no RPC handler mounted"),
                                        },
                                    }
                                }
                                _ => FabricRpcResponse::Error {
                                    code: String::from("PERMISSION_DENIED"),
                                    detail: String::from(
                                        "RPC agent_id or sender_device_id mismatch with authenticated EndpointId",
                                    ),
                                },
                            };

                            let _ = write_rpc_frame(&mut send, &resp).await;
                        });
                    }
                });
            }
        });

        Ok(Self {
            agent_id: config.agent_id,
            device_id: local_dev_id,
            endpoint,
            mem_lookup,
            peers,
            weak_conns,
            pooled_conns: Arc::new(Mutex::new(BTreeMap::new())),
            overlay_addrs,
            relay_url: configured_relay_url,
            accept_task: Arc::new(Mutex::new(Some(accept_join))),
        })
    }

    pub fn endpoint(&self) -> Result<&Endpoint> {
        Ok(&self.endpoint)
    }

    pub fn endpoint_id(&self) -> Result<EndpointId> {
        Ok(self.endpoint.id())
    }

    pub fn endpoint_addr(&self) -> Result<EndpointAddr> {
        Ok(self.endpoint.addr())
    }

    #[must_use]
    pub const fn agent_id(&self) -> AgentId {
        self.agent_id
    }

    #[must_use]
    pub const fn device_id(&self) -> DeviceId {
        self.device_id
    }

    #[must_use]
    pub fn discovered_overlay_addrs(&self) -> &[SocketAddr] {
        &self.overlay_addrs
    }

    pub fn register_peer_addr(&self, addr: EndpointAddr) {
        self.mem_lookup.add_endpoint_info(EndpointInfo::from(addr));
    }

    pub fn sync_membership(&self, epoch_ring: &EpochKeyRing) {
        if let Ok(mut guard) = self.peers.write() {
            guard.sync_from_ring(epoch_ring, self.device_id);
        }
    }

    pub async fn revoke_peer_and_disconnect(&self, revoked_device_id: DeviceId) {
        let maybe_pk = if let Ok(mut guard) = self.peers.write() {
            let pk = guard.device_to_pubkey.remove(&revoked_device_id);
            if let Some(p) = pk {
                guard.pubkey_to_device.remove(&p);
            }
            guard.capabilities.remove(&revoked_device_id);
            pk
        } else {
            None
        };

        if let Some(pk) = maybe_pk
            && let Ok(ep_id) = EndpointId::from_bytes(&pk)
        {
            if let Ok(mut pool) = self.pooled_conns.lock()
                && let Some(conn) = pool.remove(&ep_id)
            {
                conn.close(403u32.into(), b"device revoked");
            }
            if let Ok(mut wc) = self.weak_conns.lock()
                && let Some(handles) = wc.remove(&ep_id)
            {
                for h in handles {
                    if let Some(conn) = h.upgrade() {
                        conn.close(403u32.into(), b"device revoked");
                    }
                }
            }
        }
    }

    pub async fn wait_online(&self, timeout: Duration) -> Result<()> {
        tokio::time::timeout(timeout, self.endpoint.online())
            .await
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: format!("等待 FabricNode 连接到 Go Hub 中继超时 ({timeout:?})"),
            })
    }

    pub async fn wait_for_qad_global_v4(&self, timeout: Duration) -> Result<QadReportSnapshot> {
        let mut watcher = self.endpoint.net_report();
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(rep) = watcher.get()
                && rep.udp_v4
                && rep.global_v4.is_some()
            {
                return Ok(QadReportSnapshot {
                    udp_v4: rep.udp_v4,
                    global_v4: rep.global_v4,
                    preferred_relay: rep.preferred_relay.map(|u| u.to_string()),
                });
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("等待 Go Hub `/iroh-qad/0` 探测 global_v4 超时 ({timeout:?})"),
                });
            }
            let rem = deadline.saturating_duration_since(now);
            let _ =
                tokio::time::timeout(rem.min(Duration::from_millis(200)), watcher.updated()).await;
        }
    }

    pub async fn connect_peer(&self, peer_addr: EndpointAddr) -> Result<Connection> {
        let remote_id = peer_addr.id;
        if let Ok(pool) = self.pooled_conns.lock()
            && let Some(existing) = pool.get(&remote_id)
            && existing.close_reason().is_none()
        {
            return Ok(existing.clone());
        }
        self.register_peer_addr(peer_addr.clone());
        let conn = self
            .endpoint
            .connect(peer_addr, FABRIC_ALPN)
            .await
            .map_err(|e| QuetzalcoatlError::PermissionDenied {
                detail: format!("iroh 连接对等节点 {remote_id} 失败: {e}"),
            })?;
        if let Ok(mut pool) = self.pooled_conns.lock() {
            pool.insert(remote_id, conn.clone());
        }
        Ok(conn)
    }

    pub async fn wait_for_direct_path(
        &self,
        peer_id: EndpointId,
        timeout: Duration,
    ) -> Result<SocketAddr> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(addr) = self.current_direct_addr_for(peer_id) {
                return Ok(addr);
            }
            if Instant::now() >= deadline {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("等待对等节点 {peer_id} 升级为直连 QUIC IP 路径超时"),
                });
            }
            // 发送轻量数据包驱动 QUIC 路径探测与打洞迁移确认（严禁把 MutexGuard 跨 await 持有）
            let probe_conn = if let Ok(pool) = self.pooled_conns.lock()
                && let Some(conn) = pool.get(&peer_id).cloned()
                && conn.close_reason().is_none()
            {
                Some(conn)
            } else {
                None
            };
            if let Some(conn) = probe_conn {
                let _ = self
                    .send_rpc_over_conn(
                        &conn,
                        &FabricRpcRequest::Ping {
                            agent_id: self.agent_id,
                            sender_device_id: self.device_id,
                        },
                    )
                    .await;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    }

    fn current_direct_addr_for(&self, peer_id: EndpointId) -> Option<SocketAddr> {
        if let Ok(pool) = self.pooled_conns.lock()
            && let Some(conn) = pool.get(&peer_id)
            && conn.close_reason().is_none()
            && let PeerPathKind::DirectIp { addr, .. } = inspect_connection_best_path(conn)
        {
            return Some(addr);
        }
        if let Ok(wc) = self.weak_conns.lock()
            && let Some(handles) = wc.get(&peer_id)
        {
            for h in handles {
                if let Some(conn) = h.upgrade()
                    && conn.close_reason().is_none()
                    && let PeerPathKind::DirectIp { addr, .. } = inspect_connection_best_path(&conn)
                {
                    return Some(addr);
                }
            }
        }
        None
    }

    async fn send_rpc_over_conn(
        &self,
        conn: &Connection,
        req: &FabricRpcRequest,
    ) -> Result<FabricRpcResponse> {
        let (mut send, mut recv) =
            conn.open_bi()
                .await
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("打开 iroh 双向流失败: {e}"),
                })?;
        write_rpc_frame(&mut send, req).await?;

        let mut len_buf = [0u8; 4];
        recv.read_exact(&mut len_buf)
            .await
            .map_err(|e| QuetzalcoatlError::PermissionDenied {
                detail: format!("读取 iroh RPC 响应长度失败（连接可能被对端授权拦截）: {e}"),
            })?;
        let resp_len = u32::from_be_bytes(len_buf) as usize;
        if resp_len == 0 || resp_len > MAX_FABRIC_RPC_BYTES {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!("远端 iroh RPC 响应长度非法: {resp_len}"),
            });
        }
        let mut resp_bytes = vec![0u8; resp_len];
        recv.read_exact(&mut resp_bytes)
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 iroh RPC 响应载荷失败: {e}"),
            })?;
        let resp: FabricRpcResponse = serde_json::from_slice(&resp_bytes).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析 iroh RPC 响应 JSON 失败: {e}"),
            }
        })?;
        if let FabricRpcResponse::Error { code, detail } = &resp
            && code == "PERMISSION_DENIED"
        {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: detail.clone(),
            });
        }
        Ok(resp)
    }

    pub async fn send_rpc(
        &self,
        peer_addr: EndpointAddr,
        req: &FabricRpcRequest,
    ) -> Result<FabricRpcResponse> {
        let remote_id = peer_addr.id;
        let conn = self.connect_peer(peer_addr.clone()).await?;
        match self.send_rpc_over_conn(&conn, req).await {
            Ok(r) => Ok(r),
            Err(first_err) => {
                if let Ok(mut pool) = self.pooled_conns.lock() {
                    pool.remove(&remote_id);
                }
                // 若复用旧连接因已关闭报错，仅在设备仍授权时尝试重连一次
                let still_authorized = self
                    .peers
                    .read()
                    .map(|g| g.pubkey_to_device.contains_key(remote_id.as_bytes()))
                    .unwrap_or(false);
                if !still_authorized {
                    return Err(first_err);
                }
                let fresh_conn = self.connect_peer(peer_addr).await?;
                self.send_rpc_over_conn(&fresh_conn, req).await
            }
        }
    }

    /// 返回当前已连接且已授权对等节点的可拨号地址（含自建 Hub RelayUrl，供 P2P Packfile 同步与
    /// 优雅退出 `<100ms` 租约移交使用）。
    #[must_use]
    pub fn peer_endpoint_addrs(&self) -> Vec<EndpointAddr> {
        let relay = self
            .relay_url
            .as_deref()
            .and_then(|raw| RelayUrl::from_str(raw).ok());
        self.peer_statuses()
            .into_iter()
            .filter(|p| p.authorized && !matches!(p.path, PeerPathKind::Disconnected))
            .filter_map(|p| EndpointId::from_str(&p.endpoint_id_hex).ok())
            .map(|id| {
                let mut addr = EndpointAddr::new(id);
                if let Some(relay_url) = relay.clone() {
                    addr = addr.with_relay_url(relay_url);
                }
                addr
            })
            .collect()
    }

    #[must_use]
    pub fn peer_statuses(&self) -> Vec<PeerStatusSnapshot> {
        let Ok(dir) = self.peers.read() else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(dir.device_to_pubkey.len());
        for (&dev_id, pubkey) in &dir.device_to_pubkey {
            let endpoint_id_hex = hex_encode(pubkey);
            let mut path = PeerPathKind::Disconnected;
            if let Ok(ep_id) = EndpointId::from_bytes(pubkey) {
                if let Ok(pool) = self.pooled_conns.lock()
                    && let Some(conn) = pool.get(&ep_id)
                    && conn.close_reason().is_none()
                {
                    path = inspect_connection_best_path(conn);
                }
                if path == PeerPathKind::Disconnected
                    && let Ok(wc) = self.weak_conns.lock()
                    && let Some(handles) = wc.get(&ep_id)
                {
                    for h in handles {
                        if let Some(conn) = h.upgrade()
                            && conn.close_reason().is_none()
                        {
                            let cand = inspect_connection_best_path(&conn);
                            if matches!(cand, PeerPathKind::DirectIp { .. }) {
                                path = cand;
                                break;
                            }
                            path = cand;
                        }
                    }
                }
            }
            out.push(PeerStatusSnapshot {
                device_id: dev_id,
                endpoint_id_hex,
                authorized: true,
                path,
                capabilities: dir.capabilities.get(&dev_id).cloned(),
            });
        }
        out
    }

    pub async fn shutdown(&self) {
        if let Ok(mut guard) = self.accept_task.lock()
            && let Some(h) = guard.take()
        {
            h.abort();
        }
        if let Ok(mut pool) = self.pooled_conns.lock() {
            for (_, conn) in std::mem::take(&mut *pool) {
                conn.close(0u32.into(), b"shutdown");
            }
        }
        self.endpoint.close().await;
    }
}

async fn write_rpc_frame<T: Serialize>(
    send: &mut iroh::endpoint::SendStream,
    msg: &T,
) -> Result<()> {
    let payload = serde_json::to_vec(msg).map_err(|e| QuetzalcoatlError::SerializationError {
        detail: format!("编码 iroh RPC 帧失败: {e}"),
    })?;
    let len_u32 =
        u32::try_from(payload.len()).map_err(|_| QuetzalcoatlError::SerializationError {
            detail: String::from("iroh RPC 帧超过 u32 上限"),
        })?;
    send.write_all(&len_u32.to_be_bytes())
        .await
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("写入 iroh 流长度头失败: {e}"),
        })?;
    send.write_all(&payload)
        .await
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("写入 iroh 流消息体失败: {e}"),
        })?;
    send.finish().map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("关闭 iroh 发送流失败: {e}"),
    })?;
    Ok(())
}

/// `quetzalcoatl-hub` CAS 见证租约响应记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseWitnessRecord {
    pub agent_id: AgentId,
    pub holder_device_id: String,
    pub witness_epoch: u64,
    pub expires_at_ms: i64,
    pub updated_at_ms: i64,
}

/// `quetzalcoatl-hub` 认证会话信息。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HubAuthSession {
    pub session_token: String,
    pub account_id: String,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
}

/// 已授权设备在 Hub 上的 P2P 拨号发现记录（`endpoint_id_hex` 即设备 Ed25519 公钥，零明文/零记忆内容）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricPeerEndpoint {
    pub device_id: DeviceId,
    pub endpoint_id_hex: String,
    pub relay_url: Option<String>,
}

/// `/v1/pair/initiate` 响应。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairInitiateResponse {
    pub pairing_id: String,
    pub short_code: String,
    pub expires_at_ms: i64,
}

/// `/v1/pair/approve` 成功后由本机签发的 Slot 2 X-Wing HPKE 信封快照（供 `qz pair approve` 展示）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairHpkeBundle {
    pub pairing_id: String,
    pub agent_id: AgentId,
    pub joiner_device_id: DeviceId,
    pub slot2_aad_utf8: String,
    pub slot2_nonce_hex: String,
    pub slot2_ciphertext_hex: String,
    pub slot2_hpke_enc_hex: String,
}

/// `/v1/pair/{pairing_id}` 状态查询响应。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairStatusResponse {
    pub pairing_id: String,
    pub agent_id: AgentId,
    pub new_device_id: String,
    pub new_device_ed25519_hex: String,
    pub new_device_xwing_pk_hex: String,
    pub expires_at_ms: i64,
}

/// `HubClient` 连接配置。
#[derive(Clone, Debug)]
pub struct HubClientConfig {
    pub base_url: String,
    pub session_token: Option<String>,
    pub custom_ca_certs_der: Vec<Vec<u8>>,
}

/// 面向 Go `quetzalcoatl-hub` 的零知识 HTTPS 客户端。
#[derive(Clone)]
pub struct HubClient {
    config: HubClientConfig,
    http: reqwest::Client,
}

impl HubClient {
    pub fn new(config: HubClientConfig) -> Result<Self> {
        let tls_cfg = build_rustls_client_config(&config.custom_ca_certs_der)?;
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls_cfg)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("构造 HubClient HTTP 客户端失败: {e}"),
            })?;
        let mut normalized = config;
        normalized.base_url = normalized.base_url.trim_end_matches('/').to_owned();
        Ok(Self {
            config: normalized,
            http,
        })
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    #[must_use]
    pub fn session_token(&self) -> Option<&str> {
        self.config.session_token.as_deref()
    }

    #[must_use]
    pub fn with_session_token(&self, token: impl Into<String>) -> Self {
        let mut next = self.clone();
        next.config.session_token = Some(token.into());
        next
    }

    fn require_token(&self) -> Result<&str> {
        self.config
            .session_token
            .as_deref()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
                detail: String::from(
                    "HubClient 尚未配置 session_token，请先执行 qz login 或 qz pair",
                ),
            })
    }

    fn parse_hub_error(status: reqwest::StatusCode, raw: &[u8]) -> QuetzalcoatlError {
        if let Ok(val) = serde_json::from_slice::<serde_json::Value>(raw) {
            let code = val.get("code").and_then(|v| v.as_str()).unwrap_or("");
            let detail = val
                .get("detail")
                .and_then(|v| v.as_str())
                .unwrap_or("hub request error")
                .to_owned();
            match code {
                "STALE_LEASE_EPOCH" => {
                    let provided = val.get("provided").and_then(|v| v.as_u64()).unwrap_or(0);
                    let current = val.get("current").and_then(|v| v.as_u64()).unwrap_or(0);
                    return QuetzalcoatlError::StaleLeaseEpoch { provided, current };
                }
                "CLOCK_DRIFT_EXCEEDED" => {
                    return QuetzalcoatlError::ClockDriftExceeded {
                        remote_wall_ms: val
                            .get("remote_wall_ms")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        local_wall_ms: val
                            .get("local_wall_ms")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        max_drift_ms: val
                            .get("max_drift_ms")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(300_000),
                    };
                }
                "CREDENTIAL_REJECTED" => {
                    return QuetzalcoatlError::CredentialRejected { detail };
                }
                "PERMISSION_DENIED" => {
                    return QuetzalcoatlError::PermissionDenied { detail };
                }
                "INTEGRITY_VIOLATION" => {
                    return QuetzalcoatlError::IntegrityViolation { detail };
                }
                _ => {}
            }
        }
        let fallback = format!("HTTP {status}: {}", String::from_utf8_lossy(raw));
        if status.as_u16() == 401 {
            QuetzalcoatlError::CredentialRejected { detail: fallback }
        } else if status.as_u16() == 403 {
            QuetzalcoatlError::PermissionDenied { detail: fallback }
        } else {
            QuetzalcoatlError::StorageError { detail: fallback }
        }
    }

    /// 使用 EdDSA (`COSE alg = -8`) WebAuthn + Slot 1 (`PasskeyPrf`) 在零知识 Hub 上完成初始主权 Agent 注册引导。
    pub async fn register_agent_with_eddsa_passkey(
        &self,
        agent_id: AgentId,
        device: &DeviceIdentity,
        root_key: &AccountRootKey,
    ) -> Result<HubAuthSession> {
        let root_vk = root_key.verifying_key_bytes()?;
        let begin_body = serde_json::json!({
            "agent_id": agent_id.to_string(),
            "device_id": device.device_id().to_string(),
            "root_verifying_key_hex": hex_encode(&root_vk),
            "device_ed25519_pubkey_hex": hex_encode(device.ed25519_public_key()),
            "device_xwing_pubkey_hex": hex_encode(device.xwing_public_key()),
        });

        let begin_resp = self
            .http
            .post(format!(
                "{}/v1/auth/passkey/register/begin",
                self.config.base_url
            ))
            .json(&begin_body)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("passkey/register/begin 网络错误: {e}"),
            })?;
        let begin_status = begin_resp.status();
        let begin_raw = begin_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !begin_status.is_success() {
            return Err(Self::parse_hub_error(begin_status, &begin_raw));
        }
        let begin_json: serde_json::Value = serde_json::from_slice(&begin_raw).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        let challenge_id = begin_json["challenge_id"].as_str().ok_or_else(|| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("缺少 challenge_id"),
            }
        })?;
        let challenge_b64 = begin_json["challenge_b64"].as_str().ok_or_else(|| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("缺少 challenge_b64"),
            }
        })?;
        let rp_id = begin_json["rp_id"].as_str().unwrap_or("localhost");

        let mut cred_seed = [0u8; 32];
        let mut cred_id_bytes = [0u8; 16];
        let mut prf_out = [0u8; 32];
        OsRng.fill_bytes(&mut cred_seed);
        OsRng.fill_bytes(&mut cred_id_bytes);
        OsRng.fill_bytes(&mut prf_out);
        let cred_sk = SigningKey::from_bytes(&cred_seed);
        let cred_pk = cred_sk.verifying_key().to_bytes();

        let origin = self.config.base_url.clone();
        let client_data = serde_json::json!({
            "type": "webauthn.create",
            "challenge": challenge_b64,
            "origin": origin,
            "crossOrigin": false,
        });
        let client_data_bytes = serde_json::to_vec(&client_data).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        let rp_hash = Sha256::digest(rp_id.as_bytes());
        let mut auth_data = Vec::with_capacity(37);
        auth_data.extend_from_slice(&rp_hash);
        auth_data.push(0x05); // UP | UV
        auth_data.extend_from_slice(&1u32.to_be_bytes());

        let cd_hash = Sha256::digest(&client_data_bytes);
        let mut signed_msg = Vec::with_capacity(37 + 32);
        signed_msg.extend_from_slice(&auth_data);
        signed_msg.extend_from_slice(&cd_hash);
        let webauthn_sig = cred_sk.sign(&signed_msg).to_bytes();

        let wrapped_slot1: WrappedRootKeySlot =
            root_key.wrap_with_passkey_prf(agent_id, &prf_out)?;
        let finish_body = serde_json::json!({
            "challenge_id": challenge_id,
            "credential_id": hex_encode(&cred_id_bytes),
            "alg": -8,
            "public_key_hex": hex_encode(&cred_pk),
            "client_data_json_b64": base64url_nopad_encode(&client_data_bytes),
            "authenticator_data_b64": base64url_nopad_encode(&auth_data),
            "signature_b64": base64url_nopad_encode(&webauthn_sig),
            "slot1_envelope": {
                "agent_id": agent_id.to_string(),
                "slot": "passkey_prf",
                "aad_utf8": wrapped_slot1.aad_utf8,
                "nonce_hex": hex_encode(&wrapped_slot1.nonce),
                "ciphertext_hex": hex_encode(&wrapped_slot1.ciphertext),
            }
        });

        let fin_resp = self
            .http
            .post(format!(
                "{}/v1/auth/passkey/register/finish",
                self.config.base_url
            ))
            .json(&finish_body)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("passkey/register/finish 网络错误: {e}"),
            })?;
        let fin_status = fin_resp.status();
        let fin_raw = fin_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !fin_status.is_success() {
            return Err(Self::parse_hub_error(fin_status, &fin_raw));
        }
        serde_json::from_slice(&fin_raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("解析注册会话响应失败: {e}"),
        })
    }

    /// 注册 RFC 9807 `OPAQUE-Ristretto255-SHA512` 零知识 PIN 并写入 Slot 4 根密钥信封。
    pub async fn register_opaque_pin(
        &self,
        agent_id: AgentId,
        pin: &[u8],
        root_key: &AccountRootKey,
    ) -> Result<()> {
        let tok = self.require_token()?;
        let (blind_scalar, _) = opaque_random_scalar_and_point();
        let blinded = opaque_oprf_blind_deterministic(pin, &blind_scalar)?;

        let init_resp = self
            .http
            .post(format!(
                "{}/v1/auth/opaque/register/init",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "agent_id": agent_id.to_string(),
                "blinded_element_hex": hex_encode(&blinded),
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("opaque/register/init 网络错误: {e}"),
            })?;
        let init_st = init_resp.status();
        let init_raw = init_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !init_st.is_success() {
            return Err(Self::parse_hub_error(init_st, &init_raw));
        }
        let init_json: serde_json::Value = serde_json::from_slice(&init_raw).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        let eval_hex = init_json["evaluated_element_hex"].as_str().ok_or_else(|| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("缺少 evaluated_element_hex"),
            }
        })?;
        let server_pk_hex = init_json["server_public_key_hex"].as_str().ok_or_else(|| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("缺少 server_public_key_hex"),
            }
        })?;
        let server_identity = init_json["server_identity"]
            .as_str()
            .unwrap_or("server:quetzalcoatl-hub:v2");
        let salt_hex = init_json["mhf"]["salt_hex"].as_str().ok_or_else(|| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("缺少 mhf.salt_hex"),
            }
        })?;
        #[allow(clippy::cast_possible_truncation)]
        let mhf = OpaqueMhfParams {
            memory_kib: init_json["mhf"]["memory_kib"].as_u64().unwrap_or(65_536) as u32,
            iterations: init_json["mhf"]["iterations"].as_u64().unwrap_or(3) as u32,
            parallelism: init_json["mhf"]["parallelism"].as_u64().unwrap_or(1) as u32,
            salt: hex_decode_fixed::<16>("mhf.salt_hex", salt_hex)?,
        };

        let evaluated = hex_decode_fixed::<32>("evaluated_element_hex", eval_hex)?;
        let server_pk = hex_decode_fixed::<32>("server_public_key_hex", server_pk_hex)?;
        let oprf_out = opaque_finalize_oprf(pin, &blind_scalar, &evaluated)?;
        let client_id_str = format!("agent:{agent_id}");
        let bundle = opaque_client_build_registration(
            &oprf_out,
            &mhf,
            &server_pk,
            server_identity.as_bytes(),
            client_id_str.as_bytes(),
        )?;
        let slot4 = root_key.wrap_slot4(agent_id, &bundle.export_key)?;

        let fin_resp = self
            .http
            .post(format!(
                "{}/v1/auth/opaque/register/finish",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "agent_id": agent_id.to_string(),
                "credential_identifier": client_id_str,
                "client_public_key_hex": hex_encode(&bundle.client_public_key),
                "masking_key_hex": hex_encode(&bundle.masking_key),
                "envelope_hex": hex_encode(&bundle.envelope),
                "slot4_envelope": {
                    "aad_utf8": slot4.aad_utf8,
                    "nonce_hex": hex_encode(&slot4.nonce),
                    "ciphertext_hex": hex_encode(&slot4.ciphertext),
                }
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("opaque/register/finish 网络错误: {e}"),
            })?;
        let fin_st = fin_resp.status();
        let fin_raw = fin_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !fin_st.is_success() {
            return Err(Self::parse_hub_error(fin_st, &fin_raw));
        }
        Ok(())
    }

    /// 使用 RFC 9807 `OPAQUE` 零知识 PIN 执行 3DH 登录并解封恢复 `AccountRootKey`。
    pub async fn login_opaque_pin(
        &self,
        agent_id: AgentId,
        device_id: DeviceId,
        pin: &[u8],
    ) -> Result<(HubAuthSession, AccountRootKey)> {
        let (blind_scalar, _) = opaque_random_scalar_and_point();
        let (client_eph_scalar, client_eph_pk) = opaque_random_scalar_and_point();
        let mut client_nonce = [0u8; 32];
        OsRng.fill_bytes(&mut client_nonce);
        let blinded = opaque_oprf_blind_deterministic(pin, &blind_scalar)?;

        let mut ke1 = Vec::with_capacity(96);
        ke1.extend_from_slice(&blinded);
        ke1.extend_from_slice(&client_nonce);
        ke1.extend_from_slice(&client_eph_pk);

        let client_id_str = format!("agent:{agent_id}");
        let start_resp = self
            .http
            .post(format!(
                "{}/v1/auth/opaque/login/start",
                self.config.base_url
            ))
            .json(&serde_json::json!({
                "agent_id": agent_id.to_string(),
                "device_id": device_id.to_string(),
                "client_identity": client_id_str,
                "ke1_hex": hex_encode(&ke1),
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("opaque/login/start 网络错误: {e}"),
            })?;
        let start_st = start_resp.status();
        let start_raw = start_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !start_st.is_success() {
            return Err(Self::parse_hub_error(start_st, &start_raw));
        }
        let start_json: serde_json::Value = serde_json::from_slice(&start_raw).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        let login_id = start_json["login_id"].as_str().ok_or_else(|| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("缺少 login_id"),
            }
        })?;
        let ke2_hex = start_json["ke2_hex"].as_str().ok_or_else(|| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("缺少 ke2_hex"),
            }
        })?;
        let server_identity = start_json["server_identity"]
            .as_str()
            .unwrap_or("server:quetzalcoatl-hub:v2");
        let salt_hex = start_json["mhf"]["salt_hex"].as_str().ok_or_else(|| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("缺少 mhf.salt_hex"),
            }
        })?;
        #[allow(clippy::cast_possible_truncation)]
        let mhf = OpaqueMhfParams {
            memory_kib: start_json["mhf"]["memory_kib"].as_u64().unwrap_or(65_536) as u32,
            iterations: start_json["mhf"]["iterations"].as_u64().unwrap_or(3) as u32,
            parallelism: start_json["mhf"]["parallelism"].as_u64().unwrap_or(1) as u32,
            salt: hex_decode_fixed::<16>("mhf.salt_hex", salt_hex)?,
        };

        let ke2 = hex_decode("ke2_hex", ke2_hex)?;
        if ke2.len() != 320 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!("KE2 长度必须为 320 字节，实际 {}", ke2.len()),
            });
        }
        let mut evaluated = [0u8; 32];
        let mut masking_nonce = [0u8; 32];
        let mut server_nonce = [0u8; 32];
        let mut server_eph_pk = [0u8; 32];
        let mut got_server_mac = [0u8; 64];
        evaluated.copy_from_slice(&ke2[0..32]);
        masking_nonce.copy_from_slice(&ke2[32..64]);
        let masked_resp = &ke2[64..192];
        let cred_resp = &ke2[0..192];
        server_nonce.copy_from_slice(&ke2[192..224]);
        server_eph_pk.copy_from_slice(&ke2[224..256]);
        got_server_mac.copy_from_slice(&ke2[256..320]);

        let oprf_out = opaque_finalize_oprf(pin, &blind_scalar, &evaluated)?;
        let randomized_pwd = opaque_harden_randomized_pwd(&oprf_out, &mhf)?;
        let (export_key, client_priv_scalar, server_pk) = opaque_open_envelope(
            &randomized_pwd,
            &evaluated,
            &masking_nonce,
            masked_resp,
            server_identity.as_bytes(),
            client_id_str.as_bytes(),
        )?;
        let (ke3_client_mac, expected_server_mac) = opaque_client_finish_3dh(
            OPAQUE_DEFAULT_CONTEXT,
            client_id_str.as_bytes(),
            server_identity.as_bytes(),
            &ke1,
            &client_priv_scalar,
            &client_eph_scalar,
            cred_resp,
            &server_nonce,
            &server_pk,
            &server_eph_pk,
        )?;
        if expected_server_mac != got_server_mac {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("OPAQUE KE2 ServerMAC 校验失败"),
            });
        }

        let fin_resp = self
            .http
            .post(format!(
                "{}/v1/auth/opaque/login/finish",
                self.config.base_url
            ))
            .json(&serde_json::json!({
                "login_id": login_id,
                "ke3_hex": hex_encode(&ke3_client_mac),
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("opaque/login/finish 网络错误: {e}"),
            })?;
        let fin_st = fin_resp.status();
        let fin_raw = fin_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !fin_st.is_success() {
            return Err(Self::parse_hub_error(fin_st, &fin_raw));
        }
        let fin_json: serde_json::Value = serde_json::from_slice(&fin_raw).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        let session = HubAuthSession {
            session_token: fin_json["session_token"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            account_id: fin_json["account_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            agent_id,
            device_id,
        };
        let s4 = &fin_json["slot4_envelope"];
        let wrapped_s4 = Slot4WrappedRootKey {
            aad_utf8: s4["aad_utf8"].as_str().unwrap_or_default().to_owned(),
            nonce: hex_decode_fixed::<24>(
                "slot4.nonce_hex",
                s4["nonce_hex"].as_str().unwrap_or_default(),
            )?,
            kek_debug_only: None,
            ciphertext: hex_decode(
                "slot4.ciphertext_hex",
                s4["ciphertext_hex"].as_str().unwrap_or_default(),
            )?,
        };
        let root_key = AccountRootKey::unwrap_slot4(agent_id, &export_key, &wrapped_s4)?;
        Ok((session, root_key))
    }

    pub async fn pair_initiate(&self, agent_id: AgentId) -> Result<PairInitiateResponse> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .post(format!("{}/v1/pair/initiate", self.config.base_url))
            .bearer_auth(tok)
            .json(&serde_json::json!({ "agent_id": agent_id.to_string() }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("pair/initiate 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })
    }

    pub async fn pair_join(
        &self,
        pairing_id: &str,
        short_code: &str,
        joiner_device: &DeviceIdentity,
    ) -> Result<()> {
        let resp = self
            .http
            .post(format!("{}/v1/pair/join", self.config.base_url))
            .json(&serde_json::json!({
                "pairing_id": pairing_id,
                "short_code": short_code,
                "device_id": joiner_device.device_id().to_string(),
                "ed25519_pubkey_hex": hex_encode(joiner_device.ed25519_public_key()),
                "xwing_pubkey_hex": hex_encode(joiner_device.xwing_public_key()),
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("pair/join 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        Ok(())
    }

    pub async fn pair_get(&self, pairing_id: &str) -> Result<PairStatusResponse> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .get(format!("{}/v1/pair/{pairing_id}", self.config.base_url))
            .bearer_auth(tok)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("pair/get 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })
    }

    pub async fn pair_approve(
        &self,
        pairing_id: &str,
        agent_id: AgentId,
        epoch: Epoch,
        root_key: &AccountRootKey,
        joiner_status: &PairStatusResponse,
    ) -> Result<()> {
        self.pair_approve_with_hpke_bundle(pairing_id, agent_id, epoch, root_key, joiner_status)
            .await
            .map(|_bundle| ())
    }

    /// 同 `pair_approve`，但额外回传本机生成的 Slot 2 X-Wing HPKE 信封快照（只含密文与非敏感 AAD）。
    pub async fn pair_approve_with_hpke_bundle(
        &self,
        pairing_id: &str,
        agent_id: AgentId,
        epoch: Epoch,
        root_key: &AccountRootKey,
        joiner_status: &PairStatusResponse,
    ) -> Result<PairHpkeBundle> {
        let tok = self.require_token()?;
        let joiner_dev_id = DeviceId::from_str(&joiner_status.new_device_id)?;
        let joiner_ed = hex_decode_fixed::<32>(
            "new_device_ed25519_hex",
            &joiner_status.new_device_ed25519_hex,
        )?;
        let joiner_xw = hex_decode_fixed::<XWING_PK_LEN>(
            "new_device_xwing_pk_hex",
            &joiner_status.new_device_xwing_pk_hex,
        )?;

        let pub_rec = DevicePublicRecord {
            device_id: joiner_dev_id,
            ed25519_pubkey: joiner_ed,
            xwing_pubkey: joiner_xw.to_vec(),
        };
        let signed = root_key.sign_membership_change(
            agent_id,
            epoch,
            quetzalcoatl_crypto::MemberOperation::AddDevice,
            &pub_rec,
        )?;
        let slot2 = root_key.wrap_with_pairing_hpke(agent_id, &joiner_xw)?;
        let hpke_enc = slot2
            .hpke_enc
            .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                detail: String::from("Slot2 缺少 X-Wing HPKE enc"),
            })?;

        let resp = self
            .http
            .post(format!("{}/v1/pair/approve", self.config.base_url))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "pairing_id": pairing_id,
                "epoch": epoch.get(),
                "xwing_pubkey_blake3_hex": signed.xwing_pubkey_blake3.to_hex(),
                "root_signature_hex": hex_encode(&signed.root_signature),
                "slot2_envelope": {
                    "agent_id": agent_id.to_string(),
                    "slot": "qr_pairing_hpke",
                    "aad_utf8": slot2.aad_utf8,
                    "nonce_hex": hex_encode(&slot2.nonce),
                    "ciphertext_hex": hex_encode(&slot2.ciphertext),
                    "hpke_enc_hex": hex_encode(&hpke_enc),
                }
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("pair/approve 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        Ok(PairHpkeBundle {
            pairing_id: String::from(pairing_id),
            agent_id,
            joiner_device_id: joiner_dev_id,
            slot2_aad_utf8: slot2.aad_utf8.clone(),
            slot2_nonce_hex: hex_encode(&slot2.nonce),
            slot2_ciphertext_hex: hex_encode(&slot2.ciphertext),
            slot2_hpke_enc_hex: hex_encode(&hpke_enc),
        })
    }

    pub async fn pair_complete_and_unwrap(
        &self,
        pairing_id: &str,
        short_code: &str,
        joiner_device: &DeviceIdentity,
    ) -> Result<(HubAuthSession, AccountRootKey)> {
        let proof_msg = format!("quetzalcoatl/v2/pair-complete:{pairing_id}");
        let sig = joiner_device.sign_bytes(proof_msg.as_bytes())?;

        let resp = self
            .http
            .post(format!("{}/v1/pair/complete", self.config.base_url))
            .json(&serde_json::json!({
                "pairing_id": pairing_id,
                "short_code": short_code,
                "device_signature_hex": hex_encode(&sig),
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("pair/complete 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }

        let json: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            })?;
        let agent_str =
            json["agent_id"]
                .as_str()
                .ok_or_else(|| QuetzalcoatlError::SerializationError {
                    detail: String::from("pair/complete 缺少 agent_id"),
                })?;
        let agent_id = AgentId::from_str(agent_str)?;
        let session = HubAuthSession {
            session_token: json["session_token"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            account_id: json["account_id"].as_str().unwrap_or_default().to_owned(),
            agent_id,
            device_id: joiner_device.device_id(),
        };

        let s2 = &json["slot2_envelope"];
        let enc_bytes = hex_decode_fixed::<XWING_ENC_LEN>(
            "slot2.hpke_enc_hex",
            s2["hpke_enc_hex"].as_str().unwrap_or_default(),
        )?;
        let ct_bytes = hex_decode(
            "slot2.ciphertext_hex",
            s2["ciphertext_hex"].as_str().unwrap_or_default(),
        )?;
        let slot = WrappedRootKeySlot {
            slot: RootWrapSlot::QrPairingHpke,
            aad_utf8: s2["aad_utf8"].as_str().unwrap_or_default().to_owned(),
            nonce: [0u8; 24],
            ciphertext: ct_bytes,
            hpke_enc: Some(enc_bytes.to_vec()),
        };
        let root = AccountRootKey::unwrap_with_pairing_hpke(
            agent_id,
            joiner_device.xwing_keypair(),
            &slot,
        )?;
        Ok((session, root))
    }

    /// 从 Hub 拉取本 Agent 全部活跃设备的 iroh 拨号信息（endpoint id + Hub Relay 基址），
    /// 供空闲守护进程主动拨号建立 P2P 同步，无需任何入站流量或人工注册地址。
    pub async fn list_fabric_peers(&self, agent_id: AgentId) -> Result<Vec<FabricPeerEndpoint>> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .get(format!(
                "{}/v1/auth/devices/{agent_id}",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("list_fabric_peers 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        let val: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            })?;
        let relay_url = val["relay_url"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| Some(self.config.base_url.clone()));
        let mut out = Vec::new();
        if let Some(arr) = val["devices"].as_array() {
            for item in arr {
                if item["revoked"].as_bool().unwrap_or(false) {
                    continue;
                }
                let Some(dev_str) = item["device_id"].as_str() else {
                    continue;
                };
                let endpoint_hex = item["endpoint_id_hex"]
                    .as_str()
                    .or_else(|| item["ed25519_pubkey_hex"].as_str())
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                if endpoint_hex.is_empty() {
                    continue;
                }
                out.push(FabricPeerEndpoint {
                    device_id: DeviceId::from_str(dev_str)?,
                    endpoint_id_hex: endpoint_hex,
                    relay_url: relay_url.clone(),
                });
            }
        }
        Ok(out)
    }

    pub async fn list_active_devices(&self, agent_id: AgentId) -> Result<Vec<DevicePublicRecord>> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .get(format!(
                "{}/v1/auth/devices/{agent_id}",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("list_active_devices 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        let val: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            })?;
        let mut out = Vec::new();
        if let Some(arr) = val["devices"].as_array() {
            for item in arr {
                if item["revoked"].as_bool().unwrap_or(false) {
                    continue;
                }
                let Some(dev_str) = item["device_id"].as_str() else {
                    continue;
                };
                let Some(ed_hex) = item["ed25519_pubkey_hex"].as_str() else {
                    continue;
                };
                let Some(xw_hex) = item["xwing_pubkey_hex"].as_str() else {
                    continue;
                };
                out.push(DevicePublicRecord {
                    device_id: DeviceId::from_str(dev_str)?,
                    ed25519_pubkey: hex_decode_fixed::<32>("ed25519_pubkey_hex", ed_hex)?,
                    xwing_pubkey: hex_decode("xwing_pubkey_hex", xw_hex)?,
                });
            }
        }
        Ok(out)
    }

    /// 执行三步式零知识 Packfile 上传（`/packs/presign` -> Presigned `PUT` -> `/packs/commit`）。
    pub async fn upload_packfile(&self, agent_id: AgentId, pack: &SealedPackfile) -> Result<u64> {
        let tok = self.require_token()?;
        let sha256_hex = hex_encode(&Sha256::digest(&pack.ciphertext));
        let content_len =
            i64::try_from(pack.ciphertext.len()).map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("Packfile 密文长度超出 i64"),
            })?;

        // 1. POST /v1/spine/{agent_id}/packs/presign
        let presign_resp = self
            .http
            .post(format!(
                "{}/v1/spine/{agent_id}/packs/presign",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "pack_id": pack.pack_id.to_hex(),
                "content_length": content_len,
                "sha256_hex": sha256_hex,
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("packs/presign 网络错误: {e}"),
            })?;
        let p_st = presign_resp.status();
        let p_raw = presign_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !p_st.is_success() {
            return Err(Self::parse_hub_error(p_st, &p_raw));
        }
        let p_json: serde_json::Value =
            serde_json::from_slice(&p_raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            })?;
        let upload_id =
            p_json["upload_id"]
                .as_str()
                .ok_or_else(|| QuetzalcoatlError::SerializationError {
                    detail: String::from("缺少 upload_id"),
                })?;
        let put_url =
            p_json["put_url"]
                .as_str()
                .ok_or_else(|| QuetzalcoatlError::SerializationError {
                    detail: String::from("缺少 put_url"),
                })?;

        // 2. PUT <put_url> 附带 required_headers
        let mut put_req = self.http.put(put_url).body(pack.ciphertext.clone());
        if let Some(hdrs) = p_json["required_headers"].as_object() {
            for (k, v) in hdrs {
                if let Some(vs) = v.as_str() {
                    put_req = put_req.header(k.as_str(), vs);
                }
            }
        }
        let put_resp = put_req
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("Presigned PUT 上传密文块失败: {e}"),
            })?;
        let put_st = put_resp.status();
        if !put_st.is_success() {
            let put_raw = put_resp.bytes().await.unwrap_or_default();
            return Err(Self::parse_hub_error(put_st, &put_raw));
        }

        // 3. POST /v1/spine/{agent_id}/packs/commit
        let aad_utf8 = pack.aad.to_canonical_json();
        let comp_str = match pack.aad.compartment {
            PackCompartment::Core => "core",
            PackCompartment::ExternalChannel => "external_channel",
        };
        let commit_resp = self
            .http
            .post(format!(
                "{}/v1/spine/{agent_id}/packs/commit",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "upload_id": upload_id,
                "pack_id": pack.pack_id.to_hex(),
                "aad": {
                    "agent_id": pack.aad.agent_id.to_string(),
                    "compartment": comp_str,
                    "device_id": pack.aad.device_id.to_string(),
                    "epoch": pack.aad.epoch,
                    "first_seq": pack.aad.first_seq,
                    "last_seq": pack.aad.last_seq,
                    "max_hlc": pack.aad.max_hlc.to_hex(),
                    "min_hlc": pack.aad.min_hlc.to_hex(),
                    "padded_len": pack.aad.padded_len,
                    "uncompressed_blake3": pack.aad.uncompressed_blake3.to_hex(),
                    "v": pack.aad.v,
                },
                "aad_utf8": aad_utf8,
                "dek_wrap_nonce_hex": hex_encode(&pack.dek_wrap_nonce),
                "wrapped_dek_hex": hex_encode(&pack.wrapped_dek),
                "pack_nonce_hex": hex_encode(&pack.pack_nonce),
                "content_length": content_len,
                "sha256_hex": sha256_hex,
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("packs/commit 网络错误: {e}"),
            })?;
        let c_st = commit_resp.status();
        let c_raw = commit_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !c_st.is_success() {
            return Err(Self::parse_hub_error(c_st, &c_raw));
        }
        let c_json: serde_json::Value =
            serde_json::from_slice(&c_raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            })?;
        Ok(c_json["server_seq"].as_u64().unwrap_or(0))
    }

    pub async fn list_and_download_packfiles(
        &self,
        agent_id: AgentId,
        after_seq: u64,
        limit: u32,
    ) -> Result<(u64, Vec<SealedPackfile>)> {
        let tok = self.require_token()?;
        let list_resp = self
            .http
            .get(format!(
                "{}/v1/spine/{agent_id}/packs?after_seq={after_seq}&limit={limit}",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("GET packs 网络错误: {e}"),
            })?;
        let l_st = list_resp.status();
        let l_raw = list_resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !l_st.is_success() {
            return Err(Self::parse_hub_error(l_st, &l_raw));
        }
        let l_json: serde_json::Value =
            serde_json::from_slice(&l_raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            })?;
        let Some(arr) = l_json["packs"].as_array() else {
            return Ok((after_seq, Vec::new()));
        };

        let mut max_seq = after_seq;
        let mut packs = Vec::with_capacity(arr.len());
        for rec in arr {
            let sseq = rec["server_seq"].as_u64().unwrap_or(0);
            if sseq > max_seq {
                max_seq = sseq;
            }
            let dl_url = rec["download_url"].as_str().ok_or_else(|| {
                QuetzalcoatlError::SerializationError {
                    detail: String::from("Pack 记录缺少 download_url"),
                }
            })?;
            let blob_resp = self.http.get(dl_url).send().await.map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: format!("下载密文块失败: {e}"),
                }
            })?;
            let b_st = blob_resp.status();
            let blob_bytes =
                blob_resp
                    .bytes()
                    .await
                    .map_err(|e| QuetzalcoatlError::StorageError {
                        detail: e.to_string(),
                    })?;
            if !b_st.is_success() {
                return Err(Self::parse_hub_error(b_st, &blob_bytes));
            }
            let expected_sha = rec["sha256_hex"].as_str().unwrap_or_default();
            let actual_sha = hex_encode(&Sha256::digest(&blob_bytes));
            if !expected_sha.eq_ignore_ascii_case(&actual_sha) {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("下载的密文块 SHA-256 与元数据不符"),
                });
            }

            let pack_id = ArtifactId::from_str(rec["pack_id"].as_str().unwrap_or_default())?;
            let comp = match rec["compartment"].as_str().unwrap_or_default() {
                "core" => PackCompartment::Core,
                "external_channel" => PackCompartment::ExternalChannel,
                other => {
                    return Err(QuetzalcoatlError::IntegrityViolation {
                        detail: format!("未知 PackCompartment: {other}"),
                    });
                }
            };
            let aad = PackAad {
                v: 2,
                agent_id: AgentId::from_str(rec["agent_id"].as_str().unwrap_or_default())?,
                device_id: DeviceId::from_str(rec["device_id"].as_str().unwrap_or_default())?,
                compartment: comp,
                epoch: rec["epoch"].as_u64().unwrap_or(0),
                first_seq: rec["first_seq"].as_u64().unwrap_or(0),
                last_seq: rec["last_seq"].as_u64().unwrap_or(0),
                min_hlc: HlcTimestamp::from_hex(rec["min_hlc"].as_str().unwrap_or_default())?,
                max_hlc: HlcTimestamp::from_hex(rec["max_hlc"].as_str().unwrap_or_default())?,
                padded_len: usize::try_from(rec["padded_len"].as_u64().unwrap_or(0)).unwrap_or(0),
                uncompressed_blake3: ArtifactId::from_str(
                    rec["uncompressed_blake3"].as_str().unwrap_or_default(),
                )?,
            };
            let aad_utf8 = rec["aad_utf8"]
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| aad.to_canonical_json());
            let mut wrapped_dek_arr = [0u8; 48];
            let wd_vec = hex_decode(
                "wrapped_dek_hex",
                rec["wrapped_dek_hex"].as_str().unwrap_or_default(),
            )?;
            let _ = &mut wrapped_dek_arr;
            packs.push(SealedPackfile {
                pack_id,
                aad,
                aad_utf8,
                dek_wrap_nonce: hex_decode_fixed::<24>(
                    "dek_wrap_nonce_hex",
                    rec["dek_wrap_nonce_hex"].as_str().unwrap_or_default(),
                )?,
                wrapped_dek: wd_vec,
                pack_nonce: hex_decode_fixed::<24>(
                    "pack_nonce_hex",
                    rec["pack_nonce_hex"].as_str().unwrap_or_default(),
                )?,
                ciphertext: blob_bytes.to_vec(),
            });
        }
        Ok((max_seq, packs))
    }

    pub async fn acquire_lease(
        &self,
        agent_id: AgentId,
        device_id: DeviceId,
        expected_epoch: u64,
        ttl_ms: u64,
    ) -> Result<LeaseWitnessRecord> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .post(format!("{}/v1/lease/acquire", self.config.base_url))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "agent_id": agent_id.to_string(),
                "device_id": device_id.to_string(),
                "expected_epoch": expected_epoch,
                "ttl_ms": ttl_ms,
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("lease/acquire 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })
    }

    pub async fn renew_lease(
        &self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
        ttl_ms: u64,
    ) -> Result<LeaseWitnessRecord> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .post(format!("{}/v1/lease/renew", self.config.base_url))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "agent_id": agent_id.to_string(),
                "device_id": device_id.to_string(),
                "witness_epoch": witness_epoch,
                "ttl_ms": ttl_ms,
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("lease/renew 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })
    }

    pub async fn release_lease(
        &self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
    ) -> Result<LeaseWitnessRecord> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .post(format!("{}/v1/lease/release", self.config.base_url))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "agent_id": agent_id.to_string(),
                "device_id": device_id.to_string(),
                "witness_epoch": witness_epoch,
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("lease/release 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })
    }

    /// `qz group create`：在零知识 Hub 上登记群房间元数据（无任何明文）。
    pub async fn create_group_room(
        &self,
        group_id: &str,
        owner_agent_id: AgentId,
        secrecy_level: u8,
    ) -> Result<GroupRoomRecord> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .post(format!("{}/v1/groups", self.config.base_url))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "group_id": group_id,
                "owner_agent_id": owner_agent_id.to_string(),
                "secrecy_level": secrecy_level,
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("groups/create 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })
    }

    /// 邀请成员：把 openmls 成员身份绑定到群房间。
    pub async fn add_group_member(
        &self,
        group_id: &str,
        agent_id: AgentId,
        role: &str,
    ) -> Result<GroupMemberRecord> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .post(format!(
                "{}/v1/groups/{group_id}/members",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "agent_id": agent_id.to_string(),
                "role": role,
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("groups/members 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })
    }

    /// 列出群房间成员。
    pub async fn list_group_members(&self, group_id: &str) -> Result<Vec<GroupMemberRecord>> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .get(format!(
                "{}/v1/groups/{group_id}/members",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("groups/members 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        let val: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            })?;
        let mut out = Vec::new();
        if let Some(items) = val["members"].as_array() {
            for item in items {
                out.push(serde_json::from_value(item.clone()).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: e.to_string(),
                    }
                })?);
            }
        }
        Ok(out)
    }

    /// 向 Hub 原子定序器提交 openmls 密文（只含密文与元数据）。
    #[allow(clippy::too_many_arguments)]
    pub async fn append_group_commit(
        &self,
        group_id: &str,
        sender_agent_id: AgentId,
        sender_device_id: DeviceId,
        mls_epoch: u64,
        causal_parent_seq: u64,
        mentions: &serde_json::Value,
        ciphertext_b64: &str,
        kind: &str,
        author_kind: &str,
        reencrypt_only: bool,
    ) -> Result<GroupCommitReceipt> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .post(format!(
                "{}/v1/groups/{group_id}/commits",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .json(&serde_json::json!({
                "mls_epoch": mls_epoch,
                "causal_parent_seq": causal_parent_seq,
                "sender_agent_id": sender_agent_id.to_string(),
                "sender_device_id": sender_device_id.to_string(),
                "mentions": mentions,
                "ciphertext_b64": ciphertext_b64,
                "kind": kind,
                "author_kind": author_kind,
                "reencrypt_only": reencrypt_only,
            }))
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("groups/commits 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })
    }

    /// 拉取指定水位线之后的密文提交与当前群头。
    pub async fn list_group_commits(
        &self,
        group_id: &str,
        after_seq: u64,
        limit: u32,
    ) -> Result<(Vec<GroupCommitRecord>, u64, u64)> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .get(format!(
                "{}/v1/groups/{group_id}/commits?after_seq={after_seq}&limit={limit}",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("groups/commits 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        let val: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            })?;
        let mut commits = Vec::new();
        if let Some(items) = val["commits"].as_array() {
            for item in items {
                commits.push(serde_json::from_value(item.clone()).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: e.to_string(),
                    }
                })?);
            }
        }
        let head = val["head_group_seq"].as_u64().unwrap_or(after_seq);
        let epoch = val["current_mls_epoch"].as_u64().unwrap_or(0);
        Ok((commits, head, epoch))
    }

    /// 撤销群成员在 Hub 的提交权限（服务端 `DELETE /v1/groups/{id}/members/{agent_id}`）。
    pub async fn remove_group_member(&self, group_id: &str, agent_id: AgentId) -> Result<()> {
        let tok = self.require_token()?;
        let resp = self
            .http
            .delete(format!(
                "{}/v1/groups/{group_id}/members/{agent_id}",
                self.config.base_url
            ))
            .bearer_auth(tok)
            .send()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("groups/members delete 网络错误: {e}"),
            })?;
        let st = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: e.to_string(),
            })?;
        if !st.is_success() {
            return Err(Self::parse_hub_error(st, &raw));
        }
        Ok(())
    }
}

/// 群房间元数据（零知识，仅 ID/所有者/保密等级）。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GroupRoomRecord {
    pub group_id: String,
    pub owner_agent_id: String,
    pub secrecy_level: u8,
    pub created_at_ms: i64,
}

/// 群成员关系记录。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GroupMemberRecord {
    pub group_id: String,
    pub agent_id: String,
    pub role: String,
    pub added_at_ms: i64,
}

/// Hub 密文提交定序回执。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GroupCommitReceipt {
    pub group_id: String,
    pub server_seq: u64,
    pub mls_epoch: u64,
    pub causal_parent_seq: u64,
    pub sender_agent_id: String,
    pub sender_device_id: String,
    pub kind: String,
    pub author_kind: String,
    pub hop: u32,
    pub created_at_ms: i64,
}

/// 已定序的密文提交。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GroupCommitRecord {
    pub group_id: String,
    pub server_seq: u64,
    pub mls_epoch: u64,
    pub causal_parent_seq: u64,
    pub sender_agent_id: String,
    pub sender_device_id: String,
    pub mentions: serde_json::Value,
    pub ciphertext_b64: String,
    pub kind: String,
    pub author_kind: String,
    pub hop: u32,
    pub created_at_ms: i64,
}
