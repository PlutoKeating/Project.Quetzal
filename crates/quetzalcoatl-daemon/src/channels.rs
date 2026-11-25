#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatld` 通道监管：逐通道显式 opt-in（默认全关）、持久化开关状态、
//! 长连接随 Router `witness_epoch` 漂移移交，并向 `qz status` 暴露健康行。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use quetzalcoatl_channels::{
    ChannelCredentials, ChannelError, ChannelHealth, ChannelSupervisor, ChannelTransport,
    DeliveryReport, HttpPostTransport, HttpRequestSpec, OutboundMessage, SystemIntentsDriver,
    build_http_request, drivers_with_transport, load_credentials,
};
use quetzalcoatl_harness::HttpsUpstreamTransport;
use quetzalcoatl_sandbox::{UpstreamRequest, UpstreamTransport};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedChannelState {
    #[serde(default)]
    enabled: Vec<String>,
}

/// 系统本地意图的零网络 spool 传输（仅写本机 `0600` 追加文件）。
pub struct LocalIntentSpool {
    home: PathBuf,
}

impl LocalIntentSpool {
    #[must_use]
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }
}

impl ChannelTransport for LocalIntentSpool {
    fn send(&self, _destination: &str, payload: &str) -> std::result::Result<(), ChannelError> {
        let dir = self.home.join("channels/system-intents");
        std::fs::create_dir_all(&dir).map_err(|_| ChannelError::TransportUnavailable)?;
        let path = dir.join("outbox.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|_| ChannelError::TransportUnavailable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        writeln!(file, "{payload}").map_err(|_| ChannelError::TransportUnavailable)
    }

    fn close(&self) {}
}

/// 守护进程内的通道监管器。
pub struct ChannelRuntime {
    supervisor: ChannelSupervisor,
    state_path: PathBuf,
    credentials: BTreeMap<String, ChannelCredentials>,
    http: HttpsUpstreamTransport,
}

impl ChannelRuntime {
    /// 加载持久化开关；文件不存在时所有通道保持关闭（默认 OFF）。
    pub fn load(home: &Path) -> Result<Self> {
        Self::load_with_extra_root_der_certs(home, Vec::new())
    }

    /// 加载并附加自定义 TLS 根证书（用于自建 CA 的部署/测试）。
    pub fn load_with_extra_root_der_certs(home: &Path, extra_roots: Vec<Vec<u8>>) -> Result<Self> {
        let drivers = drivers_with_transport(Arc::new(HttpPostTransport));
        let mut drivers = drivers;
        drivers.insert(
            String::from("system-intents"),
            Arc::new(SystemIntentsDriver::new(Arc::new(LocalIntentSpool::new(
                home.to_path_buf(),
            )))),
        );
        let mut supervisor = ChannelSupervisor::new(drivers);
        let state_path = home.join("channels/state.json");
        if let Ok(raw) = std::fs::read_to_string(&state_path) {
            let parsed: PersistedChannelState = serde_json::from_str(&raw).unwrap_or_default();
            for channel in parsed.enabled {
                if supervisor.enable(&channel).is_err() {
                    // M1：陈旧/非法状态行只跳过并告警，绝不阻断 quetzalcoatld 启动。
                    eprintln!("quetzalcoatld: 跳过已失效的通道 opt-in 状态 `{channel}`");
                }
            }
        }
        let mut credentials = BTreeMap::new();
        for id in quetzalcoatl_channels::descriptors().keys() {
            if let Ok(Some(creds)) = load_credentials(home, id) {
                credentials.insert(id.clone(), creds);
            }
        }
        let http = HttpsUpstreamTransport::with_extra_root_der_certs(extra_roots)?;
        Ok(Self {
            supervisor,
            state_path,
            credentials,
            http,
        })
    }

    /// 商品化出站发送：租约门禁 → 通道限额渲染 → 凭据 URL/Header 模板 → 真实 HTTP(S) POST。
    pub fn deliver(
        &mut self,
        channel: &str,
        destination: &str,
        text: &str,
    ) -> Result<DeliveryReport> {
        self.deliver_with_idempotency(channel, destination, text, None)
    }

    /// 出站发送并附加可选 `Idempotency-Key`（Outbox 重放时使用）。
    pub fn deliver_with_idempotency(
        &mut self,
        channel: &str,
        destination: &str,
        text: &str,
        idempotency_key: Option<&str>,
    ) -> Result<DeliveryReport> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        let result = self.deliver_inner(channel, destination, text, idempotency_key);
        match result {
            Ok(report) => {
                self.supervisor.record_delivery(channel, now_ms, true, None);
                Ok(report)
            }
            Err(err) => {
                self.supervisor
                    .record_delivery(channel, now_ms, false, Some(err.to_string()));
                Err(err)
            }
        }
    }

    fn deliver_inner(
        &mut self,
        channel: &str,
        destination: &str,
        text: &str,
        idempotency_key: Option<&str>,
    ) -> Result<DeliveryReport> {
        self.supervisor
            .authorize_send(channel)
            .map_err(channel_error_to_qz)?;
        let driver =
            self.supervisor.driver(channel).cloned().ok_or_else(|| {
                QuetzalcoatlError::invalid_id("ChannelId", String::from("未知通道"))
            })?;
        let message = OutboundMessage::text_only(text);
        if driver.descriptor().local_only {
            return driver
                .deliver(destination, &message)
                .map_err(channel_error_to_qz);
        }
        let parts = driver.render(&message).map_err(channel_error_to_qz)?;
        let creds = self.credentials.get(channel).ok_or_else(|| {
            channel_error_to_qz(ChannelError::MissingCredential(String::from(channel)))
        })?;
        for part in &parts {
            let mut spec = build_http_request(channel, creds, destination, &part.payload)
                .map_err(channel_error_to_qz)?;
            if let Some(key) = idempotency_key {
                spec.headers
                    .insert(String::from("Idempotency-Key"), String::from(key));
            }
            let request = parse_upstream_request(&spec)?;
            let response =
                self.http
                    .roundtrip(&request)
                    .map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("通道 {channel} 出站网络失败: {e}"),
                    })?;
            if !(200..300).contains(&response.status) {
                return Err(channel_error_to_qz(ChannelError::TransportRejected(
                    response.status,
                )));
            }
        }
        Ok(DeliveryReport {
            channel: String::from(channel),
            destination: String::from(destination),
            parts: parts.len(),
            truncated: parts.iter().any(|p| p.truncated),
        })
    }

    fn persist(&self) -> Result<()> {
        let mut enabled: Vec<String> = self
            .supervisor
            .health()
            .into_iter()
            .filter(|h| h.enabled)
            .map(|h| h.channel)
            .collect();
        enabled.sort();
        let encoded =
            serde_json::to_vec_pretty(&PersistedChannelState { enabled }).map_err(|e| {
                QuetzalcoatlError::SerializationError {
                    detail: format!("序列化通道状态失败: {e}"),
                }
            })?;
        if let Some(parent) = self.state_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("创建通道状态目录失败 ({}): {e}", parent.display()),
            })?;
        }
        let tmp = self.state_path.with_extension("json.tmp");
        std::fs::write(&tmp, encoded).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("写入通道状态失败: {e}"),
        })?;
        std::fs::rename(&tmp, &self.state_path).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("提交通道状态失败: {e}"),
        })
    }

    /// 显式启用单通道（默认关闭）。
    pub fn enable(&mut self, channel: &str) -> Result<ChannelHealth> {
        self.supervisor
            .enable(channel)
            .map_err(channel_error_to_qz)?;
        self.persist()?;
        self.health_for(channel)
    }

    /// 显式停用单通道并关闭其长连接。
    pub fn disable(&mut self, channel: &str) -> Result<ChannelHealth> {
        self.supervisor
            .disable(channel)
            .map_err(channel_error_to_qz)?;
        self.persist()?;
        self.health_for(channel)
    }

    /// 平台加密回调解密：仅当载荷确为加密模式时要求本地密钥，明文载荷原样返回。
    pub fn decrypt_platform(&self, channel: &str, body: &[u8]) -> Result<Vec<u8>> {
        match channel {
            "wecom" if extract_xml(body, "Encrypt").is_some() => {
                let key = self
                    .credentials
                    .get(channel)
                    .and_then(|c| c.get("encoding_aes_key"))
                    .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
                        detail: String::from("WeCom 加密回调缺少 EncodingAESKey"),
                    })?;
                let encrypt = extract_xml(body, "Encrypt").ok_or_else(|| {
                    QuetzalcoatlError::SerializationError {
                        detail: String::from("WeCom 加密回调缺少 Encrypt 字段"),
                    }
                })?;
                let receive_id = self
                    .credentials
                    .get(channel)
                    .and_then(|c| c.get("receive_id"));
                crate::platform_crypto::decrypt_wecom_with_receive_id(&encrypt, key, receive_id)
            }
            "feishu" | "dingtalk" if is_encrypted_json(body) => {
                let keys: &[&str] = if channel == "feishu" {
                    &["encrypt_key", "aes_key"]
                } else {
                    &["aes_key", "encrypt_key"]
                };
                let key = keys
                    .iter()
                    .find_map(|k| self.credentials.get(channel).and_then(|c| c.get(k)))
                    .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
                        detail: format!("通道 {channel} 加密回调缺少 Encrypt Key"),
                    })?;
                crate::platform_crypto::decrypt_json_envelope(body, key)
            }
            _ => Ok(body.to_vec()),
        }
    }

    /// 用通道驱动把解密后的载荷规范化为统一入站信封。
    pub fn normalize(
        &self,
        channel: &str,
        body: &[u8],
        received_at_ms: u64,
    ) -> Result<quetzalcoatl_channels::ChannelEnvelope> {
        let driver = self
            .supervisor
            .driver(channel)
            .ok_or_else(|| QuetzalcoatlError::invalid_id("ChannelId", String::from(channel)))?;
        driver
            .normalize(&quetzalcoatl_channels::RawInbound::new(
                body.to_vec(),
                received_at_ms,
            ))
            .map_err(channel_error_to_qz)
    }

    /// 按 Router 租约重新对齐长连接所有权。
    pub fn reconcile_lease(&mut self, witness_epoch: u64, holder: &str) -> Vec<String> {
        self.supervisor.reconcile_lease(witness_epoch, holder)
    }

    /// 守护进程专用：仅本机是 Router holder 时才绑定长连接。
    pub fn reconcile_lease_for_local(
        &mut self,
        witness_epoch: u64,
        holder: &str,
        local_device_id: &str,
    ) -> Vec<String> {
        self.supervisor
            .reconcile_lease_for_local(witness_epoch, holder, local_device_id)
    }

    #[must_use]
    pub fn health(&self) -> Vec<ChannelHealth> {
        let mut rows = self.supervisor.health();
        rows.sort_by(|a, b| a.channel.cmp(&b.channel));
        rows
    }

    fn health_for(&self, channel: &str) -> Result<ChannelHealth> {
        self.health()
            .into_iter()
            .find(|h| h.channel == channel)
            .ok_or_else(|| QuetzalcoatlError::invalid_id("ChannelId", String::from("未知通道")))
    }

    #[must_use]
    pub fn is_enabled(&self, channel: &str) -> bool {
        self.supervisor.is_enabled(channel)
    }

    /// 出站门禁（含远端 holder 的有状态通道拒绝）。
    pub fn authorize_send(&self, channel: &str) -> Result<()> {
        self.supervisor
            .authorize_send(channel)
            .map_err(channel_error_to_qz)
    }
}

fn channel_error_to_qz(err: ChannelError) -> QuetzalcoatlError {
    match err {
        ChannelError::NotEnabled(channel) => {
            QuetzalcoatlError::invalid_id("ChannelId", format!("未知或未注册通道: {channel}"))
        }
        ChannelError::PermissionDenied(detail) => QuetzalcoatlError::PermissionDenied { detail },
        other => QuetzalcoatlError::StorageError {
            detail: other.to_string(),
        },
    }
}

/// 将 fabric 租约视图归一成通道长连接所有权锚点。
/// `router_holder == None` 时返回空持有者，触发所有长连接关闭。
#[must_use]
pub(crate) fn resolve_lease_anchor(
    witness_epoch: Option<u64>,
    router_holder: Option<&str>,
    _local_device_id: &str,
) -> (u64, String) {
    match router_holder.filter(|h| !h.trim().is_empty()) {
        Some(holder) => (witness_epoch.unwrap_or(0), String::from(holder)),
        None => (witness_epoch.unwrap_or(0), String::new()),
    }
}

/// 通道描述符注册表（供 CLI 展示；名称与实现同源）。
#[must_use]
pub fn descriptor_map() -> BTreeMap<String, quetzalcoatl_channels::ChannelDescriptor> {
    quetzalcoatl_channels::descriptors()
}

fn parse_upstream_request(spec: &HttpRequestSpec) -> Result<UpstreamRequest> {
    let (scheme, rest) = if let Some(rest) = spec.url.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = spec.url.strip_prefix("http://") {
        ("http", rest)
    } else {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("通道出站 URL 必须为 http(s)"),
        });
    };
    let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
    if authority.is_empty() || authority.contains('@') {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("通道出站 URL 缺少合法主机"),
        });
    }
    let default_port = if scheme == "https" { 443 } else { 80 };
    let (host, port) = if let Some((host, raw_port)) = authority.rsplit_once(':') {
        let port = raw_port
            .parse::<u16>()
            .map_err(|_| QuetzalcoatlError::CredentialRejected {
                detail: String::from("通道出站 URL 端口非法"),
            })?;
        (host, port)
    } else {
        (authority, default_port)
    };
    if host.is_empty() {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("通道出站 URL 缺少主机"),
        });
    }
    Ok(UpstreamRequest {
        method: String::from("POST"),
        scheme: String::from(scheme),
        host: String::from(host),
        port,
        path_and_query: format!("/{path}"),
        headers: spec
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        body: spec.body.as_bytes().to_vec(),
    })
}

fn is_encrypted_json(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .is_some_and(|object| object.contains_key("encrypt") || object.contains_key("Encrypt"))
}

fn extract_xml(body: &[u8], tag: &str) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let rest = text.get(start..)?;
    let end = rest.find(&close)?;
    let raw = rest.get(..end)?.trim();
    Some(
        raw.strip_prefix("<![CDATA[")
            .and_then(|s| s.strip_suffix("]]>"))
            .unwrap_or(raw)
            .to_owned(),
    )
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use quetzalcoatl_channels::{MockTransport, drivers_with_transport};
    use std::sync::Arc;

    #[test]
    fn lease_anchor_handles_holder_transitions_including_none() {
        assert_eq!(
            resolve_lease_anchor(Some(7), Some("device-a"), "local"),
            (7, String::from("device-a"))
        );
        assert_eq!(
            resolve_lease_anchor(None, None, "local"),
            (0, String::new())
        );
    }

    #[test]
    fn runtime_reconcile_binds_local_holder_and_reports_remote_holder() {
        let mock = Arc::new(MockTransport::new());
        let mut supervisor = ChannelSupervisor::new(drivers_with_transport(
            Arc::clone(&mock) as Arc<dyn ChannelTransport>
        ));
        supervisor.enable("feishu").expect("enable");
        let home = std::env::temp_dir().join(format!("qz_rt_handoff_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&home);
        let mut runtime = ChannelRuntime {
            supervisor,
            state_path: home.join("channels/state.json"),
            credentials: BTreeMap::new(),
            http: HttpsUpstreamTransport::with_extra_root_der_certs(Vec::new())
                .expect("tls config"),
        };
        // 本机 holder：绑定。
        assert_eq!(
            runtime.reconcile_lease_for_local(1, "device-a", "device-a"),
            vec![String::from("feishu")]
        );
        let health = runtime.health();
        let feishu = health
            .iter()
            .find(|h| h.channel == "feishu")
            .expect("health");
        assert_eq!(feishu.bound_witness_epoch, Some(1));
        assert_eq!(feishu.holder_device_id.as_deref(), Some("device-a"));

        // 远端 holder：关闭旧连接，不绑定，并报告 remote-holder。
        assert_eq!(
            runtime.reconcile_lease_for_local(2, "device-b", "device-a"),
            vec![String::from("feishu")]
        );
        assert!(
            mock.is_closed(),
            "remote holder handoff must close local connection"
        );
        let health = runtime.health();
        let feishu = health
            .iter()
            .find(|h| h.channel == "feishu")
            .expect("health");
        assert_eq!(feishu.bound_witness_epoch, None);
        assert_eq!(
            feishu.holder_device_id.as_deref(),
            Some("remote-holder:device-b")
        );

        // 无 holder：解绑。
        assert_eq!(
            runtime.reconcile_lease_for_local(0, "", "device-a"),
            Vec::<String>::new()
        );
        let health = runtime.health();
        let feishu = health
            .iter()
            .find(|h| h.channel == "feishu")
            .expect("health");
        assert_eq!(feishu.bound_witness_epoch, None);
        assert!(feishu.holder_device_id.is_none());
        let _ = std::fs::remove_dir_all(&home);
    }
}
