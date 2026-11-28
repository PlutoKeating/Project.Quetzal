//! 应急码：所有设备都丢了时，在新机器上把他找回来。
//!
//! `qz recovery-code` 生成一个应急码（里面含 Agent 编号与 128 位的秘密），请用户抄在安全的地方。
//! 之后每次同步，守护进程都把恢复包（设备身份、纪元钥匙、成员表、每个条目的钥匙、检索索引）
//! 用应急码封好（Argon2id 派生钥匙）交给 Hub，变了才交。根私钥不在里面：它由 Hub 的口令登录
//! （OPAQUE）取回。所以找回要两样东西：应急码与登录口令，Hub 只看得到密文。
//!
//! `qz recover` 在新机器上：用登录口令向 Hub 登录、取回恢复包、用应急码打开，写出身份与钥匙，
//! 再像配对接管那样等同步把他的海拉回来。

use std::fs;
use std::path::Path;

use quetzalcoatl_crypto::{hex_encode, open_with_passphrase, seal_with_passphrase};
use quetzalcoatl_fabric::{HubClient, HubClientConfig};
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use quetzalcoatl_spine::MaterializedStore;

use crate::daemon::{SharedDaemonCore, write_private_file};

const CODE_FILE: &str = "recovery/code.json";
const KIT_PURPOSE: &str = "quetzalcoatl-recovery-kit-v1";
const CODE_PREFIX: &str = "QZR";
/// RFC 4648 的 base32 字母表（大写，不易抄错的 0/1 不在其中）。
const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CodeState {
    code: String,
    /// 上次交给 Hub 的恢复包的摘要：变了才再交。
    #[serde(default)]
    uploaded_sha256: Option<String>,
}

fn load_state(qz_home: &Path) -> Option<CodeState> {
    fs::read(qz_home.join(CODE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
}

fn save_state(qz_home: &Path, state: &CodeState) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("无法写出应急码状态: {e}"),
    })?;
    write_private_file(&qz_home.join(CODE_FILE), &bytes)
}

fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[((buffer >> bits) & 31) as usize]));
        }
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[((buffer << (5 - bits)) & 31) as usize]));
    }
    out
}

fn unbase32(text: &str, len: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(len);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for ch in text.bytes() {
        let value = ALPHABET.iter().position(|a| *a == ch)? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    (out.len() == len).then_some(out)
}

/// 生成应急码：`QZR-` 之后是 Agent 编号与秘密，四个一组。
fn new_code(agent_id: AgentId) -> String {
    let mut secret = [0u8; 16];
    OsRng.fill_bytes(&mut secret);
    let body = format!(
        "{}{}",
        base32(uuid::Uuid::from(agent_id).as_bytes()),
        base32(&secret)
    );
    let groups: Vec<String> = body
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect();
    format!("{CODE_PREFIX}-{}", groups.join("-"))
}

/// 从应急码里读出 Agent 编号；顺带把它规整成生成时的样子（大小写、空格、横线都容忍）。
pub(crate) fn parse_code(code: &str) -> Result<(AgentId, String)> {
    let cleaned: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let body = cleaned
        .strip_prefix(CODE_PREFIX)
        .ok_or_else(|| invalid("应急码应以 QZR 开头"))?;
    if body.len() != 52 {
        return Err(invalid("应急码的长度不对：少抄或多抄了字"));
    }
    let agent_bytes = unbase32(&body[..26], 16).ok_or_else(|| invalid("应急码里有认不出的字"))?;
    unbase32(&body[26..], 16).ok_or_else(|| invalid("应急码里有认不出的字"))?;
    let agent =
        uuid::Uuid::from_slice(&agent_bytes).map_err(|_| invalid("应急码里的 Agent 编号不对"))?;
    let groups: Vec<String> = body
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect();
    Ok((
        AgentId::from(agent),
        format!("{CODE_PREFIX}-{}", groups.join("-")),
    ))
}

fn invalid(detail: &str) -> QuetzalcoatlError {
    QuetzalcoatlError::invalid_id("RecoveryCode", String::from(detail))
}

/// 应急码的现状（给 `qz recovery-code` 与诊断看，不含应急码本身）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryCodeStatus {
    pub has_code: bool,
    pub uploaded: bool,
    /// 只在刚生成时给出一次。
    pub code: Option<String>,
}

impl SharedDaemonCore {
    /// 生成（或换掉）应急码。返回的应急码只在这一次给出。
    pub(crate) fn create_recovery_code(&self) -> Result<RecoveryCodeStatus> {
        let home = self.config.quetzalcoatl_home.clone();
        let agent_id = self
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("守护进程状态锁中毒"),
            })?
            .kernel
            .spine()
            .agent_id();
        let code = new_code(agent_id);
        save_state(
            &home,
            &CodeState {
                code: code.clone(),
                uploaded_sha256: None,
            },
        )?;
        let uploaded = self
            .fabric_runtime()
            .is_some_and(|runtime| runtime.upload_recovery_kit_now().unwrap_or(false));
        Ok(RecoveryCodeStatus {
            has_code: true,
            uploaded,
            code: Some(code),
        })
    }

    /// 应急码的现状。
    pub(crate) fn recovery_code_status(&self) -> RecoveryCodeStatus {
        let state = load_state(&self.config.quetzalcoatl_home);
        RecoveryCodeStatus {
            has_code: state.is_some(),
            uploaded: state.and_then(|s| s.uploaded_sha256).is_some(),
            code: None,
        }
    }

    /// 同步时调用：有应急码、恢复包变了，就封好交给 Hub。返回这次有没有交。
    pub(crate) fn upload_recovery_kit(
        &self,
        client: &HubClient,
        rt: &tokio::runtime::Runtime,
    ) -> Result<bool> {
        let home = self.config.quetzalcoatl_home.clone();
        let Some(mut state) = load_state(&home) else {
            return Ok(false);
        };
        let (agent_id, plaintext) = {
            let guard = self
                .state
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("守护进程状态锁中毒"),
                })?;
            let payload = crate::daemon::recovery_payload(
                &home,
                (
                    guard.kernel.spine(),
                    &guard.conscience,
                    &guard.graph,
                    &guard.persisted,
                ),
                String::new(),
            )?;
            let plaintext =
                serde_json::to_vec(&payload).map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("恢复包无法序列化: {e}"),
                })?;
            (guard.kernel.spine().agent_id(), plaintext)
        };
        let digest = {
            use sha2::Digest as _;
            hex_encode(&sha2::Sha256::digest(&plaintext))
        };
        if state.uploaded_sha256.as_deref() == Some(digest.as_str()) {
            return Ok(false);
        }
        let sealed = seal_with_passphrase(&state.code, KIT_PURPOSE, &plaintext)?;
        rt.block_on(client.put_recovery_kit(agent_id, &sealed))?;
        state.uploaded_sha256 = Some(digest);
        save_state(&home, &state)?;
        Ok(true)
    }
}

/// 找回的结果。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoverReport {
    pub agent_id: AgentId,
}

/// 在一个空的家目录里，用应急码与登录口令把他找回来。守护进程不能在运行。
/// 之后 `qz up --fabric-hub <hub>`：同步会把他的海拉回来。
pub fn recover(
    qz_home: &Path,
    hub_url: &str,
    hub_ca_file: Option<&Path>,
    code: &str,
    pin: &str,
) -> Result<RecoverReport> {
    let occupied = [
        "identity/sovereign_state.json",
        "identity/keys.json",
        "spine/spine.sqlite",
    ]
    .iter()
    .any(|rel| qz_home.join(rel).exists());
    if occupied {
        return Err(QuetzalcoatlError::PermissionDenied {
            detail: format!(
                "{} 里已经有一片海。找回只放进一个空目录，以免覆盖现有的他。",
                qz_home.display()
            ),
        });
    }
    let (agent_id, code) = parse_code(code)?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("无法启动网络运行时: {e}"),
        })?;
    let custom_ca_certs_der = match hub_ca_file {
        Some(path) => {
            let raw = fs::read(path).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读不到 Hub 的证书 {}: {e}", path.display()),
            })?;
            quetzalcoatl_fabric::endpoint::parse_ca_certs_pem_or_der(&raw)?
        }
        None => Vec::new(),
    };
    let anon = HubClient::new(HubClientConfig {
        base_url: String::from(hub_url.trim_end_matches('/')),
        session_token: None,
        custom_ca_certs_der,
    })?;
    let (session, root) = rt
        .block_on(anon.login_opaque_pin_account(agent_id, pin.as_bytes()))
        .map_err(|err| match err {
            QuetzalcoatlError::IntegrityViolation { .. } => QuetzalcoatlError::CredentialRejected {
                detail: String::from("登录口令不对。"),
            },
            other => other,
        })?;
    let account = anon.with_session_token(session.session_token);
    let sealed = rt
        .block_on(account.get_recovery_kit(agent_id))?
        .ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from(
                "Hub 上没有这个他的恢复包：生成应急码之后，要等原来的设备同步过一次才有。",
            ),
        })?;
    let plaintext = open_with_passphrase(&code, KIT_PURPOSE, &sealed).map_err(|_| {
        QuetzalcoatlError::PermissionDenied {
            detail: String::from("应急码打不开这个恢复包：是不是换过应急码？"),
        }
    })?;
    let mut payload: crate::sea_archive::RecoveryPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("恢复包解析失败: {e}"),
        })?;
    payload.root_key_hex = hex_encode(root.as_bytes());

    crate::daemon::write_restored_identity(qz_home, &payload)?;
    if let Some(membership) = &payload.membership_state_json {
        write_private_file(
            &qz_home.join("fabric/membership_state.json"),
            membership.as_bytes(),
        )?;
    }
    {
        let (mut spine, _) = crate::daemon::open_restored_spine(qz_home)?;
        for (name, value) in &payload.entry_keys {
            spine.store_mut().put_private_blob(name, value)?;
        }
    }
    // 用找回的设备身份再登录一次，拿到绑定设备的会话，守护进程启动后就能同步。
    let (device_session, _) =
        rt.block_on(anon.login_opaque_pin(agent_id, payload.device_id, pin.as_bytes()))?;
    let session_file = serde_json::json!({
        "hub_url": hub_url.trim_end_matches('/'),
        "hub_ca_file": hub_ca_file.map(Path::to_path_buf),
        "relay_url": hub_url.trim_end_matches('/'),
        "qad_port": 7842,
        "session_token": device_session.session_token,
        "account_id": device_session.account_id,
        "agent_id": agent_id,
        "device_id": payload.device_id,
    });
    write_private_file(
        &qz_home.join("fabric/hub_session.json"),
        session_file.to_string().as_bytes(),
    )?;
    // 在同步把他的海拉回来之前，不收编任何出厂良知。
    write_private_file(&qz_home.join(crate::pair_adopt::ADOPTING_MARKER), b"1")?;
    // 应急码继续有效：这台设备接着维护 Hub 上的恢复包。
    save_state(
        qz_home,
        &CodeState {
            code,
            uploaded_sha256: None,
        },
    )?;
    Ok(RecoverReport { agent_id })
}

#[cfg(test)]
mod tests {
    use super::{new_code, parse_code};
    use quetzalcoatl_types::AgentId;

    #[test]
    fn a_code_carries_its_agent_and_survives_sloppy_copying() {
        let agent = AgentId::new_v4();
        let code = new_code(agent);
        assert!(code.starts_with("QZR-"));
        let (parsed, normalized) =
            parse_code(&code).unwrap_or_else(|_| (AgentId::new_v4(), String::new()));
        assert_eq!(parsed, agent);
        assert_eq!(normalized, code);
        let sloppy = code.to_lowercase().replace('-', " ");
        assert_eq!(parse_code(&sloppy).map(|(a, _)| a).ok(), Some(agent));
        assert!(parse_code(&code[..code.len() - 2]).is_err(), "少抄了字");
        assert!(parse_code("QZR-0000").is_err());
        assert_ne!(new_code(agent), code, "每次生成都不一样");
    }
}
