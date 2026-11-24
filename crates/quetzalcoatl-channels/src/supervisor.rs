use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::{ChannelDescriptor, ChannelDriver, ChannelError};

/// 通道运行凭据；`Debug` 始终脱敏，绝不打印令牌。
pub struct ChannelCredentials {
    channel: String,
    values: BTreeMap<String, String>,
}

impl ChannelCredentials {
    #[must_use]
    pub fn new(channel: impl Into<String>, values: BTreeMap<String, String>) -> Self {
        Self {
            channel: channel.into(),
            values,
        }
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    #[must_use]
    pub fn channel(&self) -> &str {
        &self.channel
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

impl fmt::Debug for ChannelCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChannelCredentials")
            .field("channel", &self.channel)
            .field("keys", &self.values.keys().collect::<Vec<_>>())
            .field("values", &"[REDACTED]")
            .finish()
    }
}

/// 从环境变量或 `QUETZALCOATL_HOME/secrets/<channel>.json` 读取凭据。
/// 环境变量名形如 `QUETZALCOATL_CHANNEL_TELEGRAM_TOKEN`。
pub fn load_credentials(
    home: &Path,
    channel: &str,
) -> Result<Option<ChannelCredentials>, ChannelError> {
    let env_prefix = format!(
        "QUETZALCOATL_CHANNEL_{}_",
        channel.to_uppercase().replace('-', "_")
    );
    let mut values = BTreeMap::new();
    for (key, value) in std::env::vars() {
        if let Some(rest) = key.strip_prefix(&env_prefix)
            && !rest.is_empty()
            && !value.is_empty()
        {
            values.insert(rest.to_lowercase(), value);
        }
    }
    let path = home.join("secrets").join(format!("{channel}.json"));
    if let Ok(raw) = std::fs::read_to_string(&path) {
        let parsed: BTreeMap<String, String> = serde_json::from_str(&raw)
            .map_err(|_| ChannelError::MissingCredential(String::from(channel)))?;
        values.extend(parsed);
    }
    if values.is_empty() {
        return Ok(None);
    }
    Ok(Some(ChannelCredentials::new(channel, values)))
}

/// 最近一次出站投递状态。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryHealth {
    pub ts_ms: u64,
    pub ok: bool,
    pub error: Option<String>,
}

/// 单通道健康状态。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelHealth {
    pub channel: String,
    pub display_name: String,
    pub enabled: bool,
    pub local_only: bool,
    pub requires_credentials: bool,
    pub bound_witness_epoch: Option<u64>,
    pub holder_device_id: Option<String>,
    pub last_delivery: Option<DeliveryHealth>,
}

/// 单 `witness_epoch` 长连接监管器。
pub struct ChannelSupervisor {
    drivers: BTreeMap<String, Arc<dyn ChannelDriver>>,
    enabled: BTreeSet<String>,
    bindings: BTreeMap<String, (u64, String)>,
    deliveries: BTreeMap<String, DeliveryHealth>,
}

impl ChannelSupervisor {
    #[must_use]
    pub fn new(drivers: BTreeMap<String, Arc<dyn ChannelDriver>>) -> Self {
        Self {
            drivers,
            enabled: BTreeSet::new(),
            bindings: BTreeMap::new(),
            deliveries: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn descriptors(&self) -> Vec<ChannelDescriptor> {
        self.drivers
            .values()
            .map(|d| d.descriptor().clone())
            .collect()
    }

    pub fn enable(&mut self, channel: &str) -> Result<(), ChannelError> {
        if !self.drivers.contains_key(channel) {
            return Err(ChannelError::NotEnabled(String::from(channel)));
        }
        self.enabled.insert(String::from(channel));
        Ok(())
    }

    pub fn disable(&mut self, channel: &str) -> Result<bool, ChannelError> {
        let removed = self.enabled.remove(channel);
        if let Some(driver) = self.drivers.get(channel) {
            driver.close();
        }
        self.bindings.remove(channel);
        Ok(removed)
    }

    #[must_use]
    pub fn is_enabled(&self, channel: &str) -> bool {
        self.enabled.contains(channel)
    }

    /// 将长连接所有权与 Router 租约对齐：
    /// - 持有者或 `witness_epoch` 变化时，先关闭旧连接再记录新持有者；
    /// - `holder` 为空（无租约）时关闭全部长连接；
    /// - 本地通道不参与联网持有。
    pub fn reconcile_lease(&mut self, witness_epoch: u64, holder: &str) -> Vec<String> {
        let mut moved = Vec::new();
        for channel in self.enabled.clone() {
            let Some(driver) = self.drivers.get(&channel) else {
                continue;
            };
            if !driver.descriptor().long_lived || driver.descriptor().local_only {
                continue;
            }
            if holder.trim().is_empty() {
                if self.bindings.remove(&channel).is_some() {
                    driver.close();
                    moved.push(channel);
                }
                continue;
            }
            let current = self.bindings.get(&channel);
            if current.is_some_and(|(epoch, owner)| *epoch == witness_epoch && owner == holder) {
                continue;
            }
            driver.close();
            self.bindings
                .insert(channel.clone(), (witness_epoch, String::from(holder)));
            moved.push(channel);
        }
        moved
    }

    #[must_use]
    pub fn health(&self) -> Vec<ChannelHealth> {
        self.drivers
            .values()
            .map(|driver| {
                let descriptor = driver.descriptor();
                let binding = self.bindings.get(&descriptor.id);
                ChannelHealth {
                    channel: descriptor.id.clone(),
                    display_name: descriptor.display_name.clone(),
                    enabled: self.enabled.contains(&descriptor.id),
                    local_only: descriptor.local_only,
                    requires_credentials: descriptor.requires_credentials,
                    bound_witness_epoch: binding.map(|(epoch, _)| *epoch),
                    holder_device_id: binding.map(|(_, holder)| holder.clone()),
                    last_delivery: self.deliveries.get(&descriptor.id).cloned(),
                }
            })
            .collect()
    }

    #[must_use]
    pub fn driver(&self, channel: &str) -> Option<&Arc<dyn ChannelDriver>> {
        self.drivers.get(channel)
    }

    /// 出站发送门禁：通道必须显式启用；长连接通道必须已有 witness_epoch 持有者。
    pub fn authorize_send(&self, channel: &str) -> Result<(), ChannelError> {
        let Some(driver) = self.drivers.get(channel) else {
            return Err(ChannelError::NotEnabled(String::from(channel)));
        };
        if !self.enabled.contains(channel) {
            return Err(ChannelError::NotEnabled(String::from(channel)));
        }
        let descriptor = driver.descriptor();
        if descriptor.long_lived && !descriptor.local_only && !self.bindings.contains_key(channel) {
            return Err(ChannelError::PermissionDenied(format!(
                "通道 {channel} 尚无 witness_epoch 持有者，拒绝外发"
            )));
        }
        Ok(())
    }

    /// 记录最近一次投递结果（错误文本绝不含正文或令牌）。
    pub fn record_delivery(&mut self, channel: &str, ts_ms: u64, ok: bool, error: Option<String>) {
        self.deliveries.insert(
            String::from(channel),
            DeliveryHealth {
                ts_ms,
                ok,
                error: error.map(|e| e.chars().take(200).collect()),
            },
        );
    }
}
