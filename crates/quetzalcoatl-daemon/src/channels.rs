#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatld` 通道监管：逐通道显式 opt-in（默认全关）、持久化开关状态、
//! 长连接随 Router `witness_epoch` 漂移移交，并向 `qz status` 暴露健康行。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use quetzalcoatl_channels::{
    ChannelError, ChannelHealth, ChannelSupervisor, ChannelTransport, HttpPostTransport,
    SystemIntentsDriver, drivers_with_transport,
};
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
}

impl ChannelRuntime {
    /// 加载持久化开关；文件不存在时所有通道保持关闭（默认 OFF）。
    pub fn load(home: &Path) -> Result<Self> {
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
                supervisor.enable(&channel).map_err(channel_error_to_qz)?;
            }
        }
        Ok(Self {
            supervisor,
            state_path,
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

    /// 按 Router 租约重新对齐长连接所有权。
    pub fn reconcile_lease(&mut self, witness_epoch: u64, holder: &str) -> Vec<String> {
        self.supervisor.reconcile_lease(witness_epoch, holder)
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

/// 通道描述符注册表（供 CLI 展示；名称与实现同源）。
#[must_use]
pub fn descriptor_map() -> BTreeMap<String, quetzalcoatl_channels::ChannelDescriptor> {
    quetzalcoatl_channels::descriptors()
}
