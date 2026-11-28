//! 带走与恢复。
//!
//! 导出包里有三样东西：
//! 1. **人读得懂的海**（`海/*.md`）：他是谁、关于你、往事、底线。不靠任何软件也读得到。
//! 2. **签名的事件与物化视图**（`.quetzalcoatl-spine/`）：用纪元密钥加密，与原来逐条一致。
//! 3. **恢复包**（`.quetzalcoatl-recovery/bundle.json`）：身份、密钥与每个条目的钥匙，
//!    用本人口令封存。没有口令，这份导出只能读、不能恢复。
//!
//! 恢复只放进一个空目录：在新机器上以同一个身份继续，原来那台不再使用。

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use quetzalcoatl_crypto::{PassphraseSealed, open_with_passphrase, seal_with_passphrase};
use quetzalcoatl_ewave::journal::{self, SeaLayer, entry_key_blob_name};
use quetzalcoatl_ewave::{Authority, Conscience};
use quetzalcoatl_spine::{MaterializedStore, read_archive_entry};
use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::host_sessions::agent_name_of;
use crate::sea_ops::SEA_ACTOR_OWNER;

/// 恢复包在导出包里的位置。
pub const RECOVERY_BUNDLE_PATH: &str = ".quetzalcoatl-recovery/bundle.json";
const RECOVERY_PURPOSE: &str = "quetzalcoatl-recovery-bundle-v1";
const RECOVERY_VERSION: u32 = 1;

/// 恢复包的明文（只存在于内存里；落进导出包的是口令封存后的密文）。
#[derive(Serialize, Deserialize)]
pub(crate) struct RecoveryPayload {
    pub version: u32,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub root_key_hex: String,
    pub ed25519_seed_hex: String,
    pub xwing_seed_hex: String,
    pub epoch1_key_hex: String,
    /// 组网的成员表（新增设备与轮换后的纪元密钥）；单机时为空。
    pub membership_state_json: Option<String>,
    /// 每个条目的钥匙：私有状态块的名字与内容。
    pub entry_keys: Vec<(String, String)>,
    /// 本机的检索索引。
    pub graph_json_v2: String,
}

/// 恢复包在导出包里的样子。
#[derive(Serialize, Deserialize)]
struct RecoveryBundleFile {
    version: u32,
    agent_id: AgentId,
    sealed: PassphraseSealed,
}

/// 用口令封存恢复包，得到要放进导出包的文件内容。
pub(crate) fn seal_recovery_bundle(payload: &RecoveryPayload, passphrase: &str) -> Result<Vec<u8>> {
    let plaintext = serde_json::to_vec(payload).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("恢复包无法序列化: {e}"),
    })?;
    let file = RecoveryBundleFile {
        version: RECOVERY_VERSION,
        agent_id: payload.agent_id,
        sealed: seal_with_passphrase(passphrase, RECOVERY_PURPOSE, &plaintext)?,
    };
    serde_json::to_vec_pretty(&file).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("恢复包无法序列化: {e}"),
    })
}

/// 从导出包里取出并打开恢复包。
pub(crate) fn open_recovery_bundle(zip_path: &Path, passphrase: &str) -> Result<RecoveryPayload> {
    let raw = read_archive_entry(zip_path, RECOVERY_BUNDLE_PATH)?.ok_or_else(|| {
        QuetzalcoatlError::StorageError {
            detail: String::from(
                "这份导出里没有恢复包（导出时没有输入口令），只能阅读，不能恢复。",
            ),
        }
    })?;
    let file: RecoveryBundleFile =
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::IntegrityViolation {
            detail: format!("恢复包已损坏: {e}"),
        })?;
    if file.version != RECOVERY_VERSION {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: format!("不认识的恢复包版本 {}", file.version),
        });
    }
    let plaintext = open_with_passphrase(passphrase, RECOVERY_PURPOSE, &file.sealed)?;
    let payload: RecoveryPayload =
        serde_json::from_slice(&plaintext).map_err(|e| QuetzalcoatlError::IntegrityViolation {
            detail: format!("恢复包已损坏: {e}"),
        })?;
    if payload.agent_id != file.agent_id {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: String::from("恢复包里的身份与封面不一致"),
        });
    }
    Ok(payload)
}

/// 良知里每个条目的钥匙（还在的那些）。
pub(crate) fn collect_entry_keys<S: MaterializedStore>(
    store: &S,
    conscience: &Conscience,
) -> Result<Vec<(String, String)>> {
    let mut names: Vec<String> = Vec::new();
    names.extend(
        conscience
            .identity
            .iter()
            .map(|e| entry_key_blob_name(SeaLayer::Identity, &e.id)),
    );
    names.extend(
        conscience
            .values
            .iter()
            .map(|e| entry_key_blob_name(SeaLayer::Value, &e.id)),
    );
    names.extend(
        conscience
            .relationships
            .iter()
            .map(|e| entry_key_blob_name(SeaLayer::Relationship, &e.id)),
    );
    names.extend(
        conscience
            .memories
            .iter()
            .map(|e| entry_key_blob_name(SeaLayer::Memory, &e.id)),
    );
    names.extend(
        conscience
            .episodes
            .iter()
            .map(|e| entry_key_blob_name(SeaLayer::Episode, &e.id)),
    );
    names.sort();
    names.dedup();
    let mut keys = Vec::new();
    for name in names {
        if let Some(value) = store.get_private_blob(&name)? {
            keys.push((name, value));
        }
    }
    Ok(keys)
}

fn day(ms: u64) -> String {
    crate::host_sessions::format_day_utc(ms)
}

/// 由良知整理出人读得懂的几份文档。
#[must_use]
pub(crate) fn readable_sea_files(conscience: &Conscience) -> Vec<(String, Vec<u8>)> {
    let name = agent_name_of(conscience);
    let mut files = Vec::new();

    let mut readme = String::new();
    let _ = writeln!(readme, "# {name} 的海\n");
    let _ = writeln!(
        readme,
        "这是一份导出。下面几份文档不靠任何软件也读得懂：\n\n\
         - `他.md`：他是谁、他看重什么。\n\
         - `关于你.md`：他对你的了解。\n\
         - `往事.md`：他记得的事，最新的在前。\n\
         - `底线.md`：你亲手签下的底线，以及部署约束。\n\n\
         要在另一台机器上把他原样恢复，用 `qz import <这份导出>`，并输入导出时的口令。"
    );
    files.push((String::from("海/README.md"), readme.into_bytes()));

    let mut him = String::new();
    let _ = writeln!(him, "# {name}\n");
    for block in &conscience.identity {
        let _ = writeln!(him, "## {}\n\n{}\n", block.label, block.value);
    }
    let active_values = conscience
        .values
        .iter()
        .filter(|v| v.invalid_at_ms.is_none());
    let core: Vec<_> = active_values
        .clone()
        .filter(|v| v.authority == Authority::SelfCore)
        .collect();
    if !core.is_empty() {
        let _ = writeln!(him, "## 他看重的\n");
        for value in core {
            let _ = writeln!(
                him,
                "- {}（自 {} 起）",
                value.statement,
                day(value.valid_from_ms)
            );
        }
        let _ = writeln!(him);
    }
    let soft: Vec<_> = active_values
        .filter(|v| v.authority == Authority::SelfSoft)
        .collect();
    if !soft.is_empty() {
        let _ = writeln!(him, "## 性情\n");
        for value in soft {
            let _ = writeln!(him, "- {}", value.statement);
        }
        let _ = writeln!(him);
    }
    files.push((String::from("海/他.md"), him.into_bytes()));

    let active_memories = conscience
        .memories
        .iter()
        .filter(|m| m.invalid_at_ms.is_none());
    let mut you = String::from("# 关于你\n\n");
    for memory in active_memories
        .clone()
        .filter(|m| m.authority == Authority::UserPref || m.about.iter().any(|a| a == "user"))
    {
        let mark = if memory.provenance.written_by == SEA_ACTOR_OWNER {
            "（你说的）"
        } else {
            ""
        };
        let _ = writeln!(you, "- {}{mark}", memory.content);
    }
    files.push((String::from("海/关于你.md"), you.into_bytes()));

    let mut past = String::from("# 往事\n\n");
    let mut ordered: Vec<_> = active_memories.collect();
    ordered.sort_by_key(|m| std::cmp::Reverse(m.valid_from_ms));
    for memory in ordered {
        let mut notes = Vec::new();
        if memory.muted {
            notes.push("不主动提");
        }
        if memory.untrusted {
            notes.push("只作参考");
        }
        let notes = if notes.is_empty() {
            String::new()
        } else {
            format!("（{}）", notes.join("，"))
        };
        let _ = writeln!(
            past,
            "- {} · {}{notes}",
            day(memory.valid_from_ms),
            memory.content
        );
    }
    files.push((String::from("海/往事.md"), past.into_bytes()));

    let mut baseline = String::from("# 底线\n\n");
    if conscience.root_directives.is_empty() {
        let _ = writeln!(baseline, "还没有签署。\n");
    } else {
        let _ = writeln!(
            baseline,
            "自 {} 起生效，由你亲手签署。\n",
            day(conscience.manifest.root_signed_at_ms)
        );
        for (index, directive) in conscience.root_directives.iter().enumerate() {
            let _ = writeln!(
                baseline,
                "{}. **{}** {}",
                index + 1,
                directive.title,
                directive.content
            );
        }
        let _ = writeln!(baseline);
    }
    if !conscience.operator_directives.is_empty() {
        let _ = writeln!(baseline, "## 部署约束\n");
        for directive in &conscience.operator_directives {
            let _ = writeln!(baseline, "- **{}** {}", directive.title, directive.content);
        }
    }
    files.push((String::from("海/底线.md"), baseline.into_bytes()));
    files
}

/// 恢复的结果。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreReport {
    pub agent_name: String,
    pub events_imported: usize,
    pub memories: usize,
}

/// 把一份导出恢复进一个空的家目录。守护进程不能在运行。
pub fn restore_from_archive(
    qz_home: &Path,
    zip_path: &Path,
    passphrase: &str,
) -> Result<RestoreReport> {
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
                "{} 里已经有一片海。恢复只放进一个空目录，以免覆盖现有的他。",
                qz_home.display()
            ),
        });
    }
    let payload = open_recovery_bundle(zip_path, passphrase)?;
    crate::daemon::write_restored_identity(qz_home, &payload)?;
    if let Some(membership) = &payload.membership_state_json {
        crate::daemon::write_private_file(
            &qz_home.join("fabric/membership_state.json"),
            membership.as_bytes(),
        )?;
    }
    let (mut spine, _) = crate::daemon::open_restored_spine(qz_home)?;
    crate::daemon::seal_restored_root(qz_home, spine.epoch_ring(), passphrase)?;
    let events_imported = spine.import_zip(zip_path, crate::daemon::now_unix_ms())?;
    for (name, value) in &payload.entry_keys {
        spine.store_mut().put_private_blob(name, value)?;
    }
    let conscience =
        journal::replay(&mut spine)?.ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
            detail: String::from("导出包里没有他的变更记录，无法恢复。"),
        })?;
    conscience.verify_signature_and_hashes()?;
    let memories = conscience
        .memories
        .iter()
        .filter(|m| m.invalid_at_ms.is_none())
        .count();
    Ok(RestoreReport {
        agent_name: agent_name_of(&conscience),
        events_imported,
        memories,
    })
}

/// 读出一个家目录里的身份与密钥，供导出恢复包使用。
pub(crate) fn read_membership_state(qz_home: &Path) -> Option<String> {
    fs::read_to_string(qz_home.join("fabric/membership_state.json")).ok()
}
