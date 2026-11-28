//! SayIt 自动流入：你在 SayIt 里说过、整理过的记录，按修订号增量拉下来，一条记录成为一条往事。
//!
//! - 只读拉取；唯一的写是在「合并并落盘」之后上报游标，SayIt 据此在记录上显示「已入海」。
//! - 记录改了：旧的那条往事抹除，新的接替（历史在 SayIt 那边）。
//! - 记录删了，或移出了令牌的项目范围：对应的往事抹除，不可恢复。

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use quetzalcoatl_fabric::sayit::{SAYIT_BASE_URL, SayItClient, SayItRecord};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::daemon::{SharedDaemonCore, now_unix_ms, write_private_file};

const STATE_FILE: &str = "sayit/connection.json";
/// 写下这类往事的来源标记（治理面据此显示「SayIt」）。
const WRITTEN_BY: &str = "sayit";
const PAGE: u32 = 200;
const MAX_TEXT_CHARS: usize = 3_800;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct SayItConnection {
    pub base_url: String,
    pub token: String,
    pub consumer_id: String,
    pub account: String,
    #[serde(default)]
    pub cursor: u64,
    /// SayIt 记录编号 → 往事编号。
    #[serde(default)]
    pub records: BTreeMap<String, String>,
}

pub(crate) fn load(qz_home: &Path) -> Option<SayItConnection> {
    fs::read(qz_home.join(STATE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
}

fn save(qz_home: &Path, state: &SayItConnection) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("无法写出 SayIt 连接: {e}"),
    })?;
    write_private_file(&qz_home.join(STATE_FILE), &bytes)
}

/// 去掉 YAML 头，标题放在第一行，过长的截断。
pub(crate) fn record_text(record: &SayItRecord) -> Option<String> {
    let markdown = record.markdown.as_deref().unwrap_or_default();
    let body = markdown
        .strip_prefix("---")
        .and_then(|rest| rest.split_once("\n---").map(|(_, after)| after))
        .unwrap_or(markdown)
        .trim();
    let title = record.title.as_deref().unwrap_or_default().trim();
    let mut text = if body.starts_with('#') || title.is_empty() {
        String::from(body)
    } else {
        format!("{title}\n{body}")
    };
    if text.chars().count() > MAX_TEXT_CHARS {
        text = text.chars().take(MAX_TEXT_CHARS).collect::<String>() + "…";
    }
    let text = text.trim().to_owned();
    (!text.is_empty()).then_some(text)
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("无法启动 SayIt 拉取: {e}"),
        })
}

/// 一次拉取的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SayItPullReport {
    pub connected: bool,
    pub added: usize,
    pub updated: usize,
    pub erased: usize,
    pub cursor: u64,
}

/// 接上 SayIt：核对令牌，记下连接（令牌只存在本机，0600）。
pub fn connect(qz_home: &Path, base_url: Option<&str>, token: &str) -> Result<String> {
    let base_url = base_url.unwrap_or(SAYIT_BASE_URL);
    let client = SayItClient::new(base_url, token)?;
    let me = runtime()?.block_on(client.me())?;
    let device = hostname_tag();
    let mut state = load(qz_home).unwrap_or_default();
    state.base_url = String::from(base_url);
    state.token = String::from(token.trim());
    state.consumer_id = format!("quetzalcoatl:{device}");
    state.account = me.account.clone();
    save(qz_home, &state)?;
    Ok(me.account)
}

/// 断开：删掉本机的令牌与游标。已经流入的往事留着（要删就在治理面里抹除）。
pub fn disconnect(qz_home: &Path) -> Result<()> {
    let path = qz_home.join(STATE_FILE);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("无法删除 SayIt 连接: {e}"),
        })?;
    }
    Ok(())
}

fn hostname_tag() -> String {
    fs::read_to_string("/etc/hostname")
        .ok()
        .map(|h| {
            h.trim()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .take(40)
                .collect::<String>()
        })
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| String::from("device"))
}

impl SharedDaemonCore {
    /// 拉一次：取到最新为止，逐条合进海里，落盘之后再上报游标。
    pub(crate) fn pull_sayit(&self) -> Result<SayItPullReport> {
        let home = self.config.quetzalcoatl_home.clone();
        let Some(mut state) = load(&home) else {
            return Ok(SayItPullReport::default());
        };
        let client = SayItClient::new(&state.base_url, &state.token)?;
        let rt = runtime()?;
        let mut report = SayItPullReport {
            connected: true,
            ..SayItPullReport::default()
        };
        loop {
            let page = rt.block_on(client.records(state.cursor, PAGE))?;
            if !page.records.is_empty() {
                let epoch = self.sea_epoch();
                let mut guard = self
                    .state
                    .lock()
                    .map_err(|_| QuetzalcoatlError::StorageError {
                        detail: String::from("守护进程状态锁中毒"),
                    })?;
                for record in &page.records {
                    let previous = state.records.get(&record.id).cloned();
                    if let Some(old) = &previous {
                        // 改了或删了：旧的那条抹除。
                        if guard.conscience.memories.iter().any(|m| &m.id == old) {
                            guard.owner_erase(&home, old, epoch, now_unix_ms())?;
                        }
                        state.records.remove(&record.id);
                        if record.deleted {
                            report.erased += 1;
                        }
                    }
                    if record.deleted {
                        continue;
                    }
                    let Some(text) = record_text(record) else {
                        continue;
                    };
                    let written = guard.remember_written_by(
                        &home,
                        &text,
                        false,
                        record.title.as_deref(),
                        &format!("sayit:{}", record.id),
                        WRITTEN_BY,
                        epoch,
                        now_unix_ms(),
                    )?;
                    state.records.insert(record.id.clone(), written.id);
                    if previous.is_some() {
                        report.updated += 1;
                    } else {
                        report.added += 1;
                    }
                }
            }
            let advanced = page.next > state.cursor;
            if advanced {
                state.cursor = page.next;
            }
            // 先落盘，再上报游标。
            save(&home, &state)?;
            if advanced {
                let _ = rt.block_on(client.put_cursor(&state.consumer_id, state.cursor));
            }
            if !page.more || !advanced {
                break;
            }
        }
        report.cursor = state.cursor;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::record_text;
    use quetzalcoatl_fabric::sayit::SayItRecord;

    #[test]
    fn the_yaml_header_is_dropped_and_the_title_kept() {
        let record = SayItRecord {
            id: String::from("s_1"),
            rev: 3,
            deleted: false,
            title: Some(String::from("周末咖啡车出摊")),
            captured_at: None,
            markdown: Some(String::from(
                "---\nid: \"s_1\"\ntitle: \"周末咖啡车出摊\"\n---\n# 周末咖啡车出摊\n周六上午九点在河边。",
            )),
        };
        let text = record_text(&record).unwrap_or_default();
        assert!(text.starts_with("# 周末咖啡车出摊"), "{text}");
        assert!(!text.contains("id:"), "{text}");
        assert!(text.contains("周六上午九点在河边"));
    }
}
