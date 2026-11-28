//! 把你已有的东西带进来：笔记（Markdown、纯文本）、宿主的规则与记忆文件、各家对话导出包、角色卡；
//! 也可以登记一个只读的笔记目录，守护进程定时重读：新增的带进来、改了的接替、删了的抹除。
//!
//! 每次导入是一批，有自己的编号；整批可以撤回（撤回就是逐条抹除，真删）。
//! 导入的内容只作为普通往事，标明来源；不会成为他的核心或你的底线。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::daemon::{SharedDaemonCore, now_unix_ms};

const WRITTEN_BY: &str = "import";
/// 同一毫秒里的几批也要有不同的编号。
static BATCH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// 一批最多带进这么多条：再多就该先整理。
const MAX_PER_BATCH: usize = 5_000;
const MAX_CHUNK_CHARS: usize = 3_000;
const MIN_CHUNK_CHARS: usize = 12;
/// 单个文件超过这个大小就跳过。
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportReport {
    pub batch_id: String,
    pub files: usize,
    pub added: usize,
    pub skipped_files: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoReport {
    pub batch_id: String,
    pub erased: usize,
}

/// 一段要带进来的内容：话题（文件名或对话标题）与正文。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub topic: String,
    pub text: String,
    pub origin: String,
}

fn truncate(text: &str) -> String {
    if text.chars().count() > MAX_CHUNK_CHARS {
        text.chars().take(MAX_CHUNK_CHARS).collect::<String>() + "…"
    } else {
        String::from(text)
    }
}

/// Markdown 与纯文本：按标题切段，没有标题的按空行切段；太短的段合进下一段。
pub(crate) fn chunk_markdown(topic: &str, origin: &str, raw: &str) -> Vec<Chunk> {
    let body = raw
        .strip_prefix("---")
        .and_then(|rest| rest.split_once("\n---").map(|(_, after)| after))
        .unwrap_or(raw);
    let mut sections: Vec<String> = Vec::new();
    let mut current = String::new();
    let has_headings = body.lines().any(|line| line.starts_with('#'));
    for line in body.lines() {
        let boundary = if has_headings {
            line.starts_with('#')
        } else {
            line.trim().is_empty()
        };
        if boundary && current.trim().chars().count() >= MIN_CHUNK_CHARS {
            sections.push(current.trim().to_owned());
            current.clear();
        }
        if !(line.trim().is_empty() && current.is_empty()) {
            current.push_str(line);
            current.push('\n');
        }
    }
    if current.trim().chars().count() >= MIN_CHUNK_CHARS {
        sections.push(current.trim().to_owned());
    }
    sections
        .into_iter()
        .map(|text| Chunk {
            topic: String::from(topic),
            text: truncate(&text),
            origin: String::from(origin),
        })
        .collect()
}

/// 对话导出包（ChatGPT 的 conversations.json、Claude 的 conversations.json）：
/// 一段对话一条，只取用户自己说的话。
pub(crate) fn chunk_chat_export(origin: &str, raw: &str) -> Option<Vec<Chunk>> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let conversations = value.as_array()?;
    let mut out = Vec::new();
    for conversation in conversations {
        let title = conversation["title"]
            .as_str()
            .or_else(|| conversation["name"].as_str())
            .unwrap_or("对话")
            .trim()
            .to_owned();
        let mut said: Vec<String> = Vec::new();
        // Claude 导出：chat_messages[{sender, text}]
        if let Some(messages) = conversation["chat_messages"].as_array() {
            for message in messages {
                if message["sender"].as_str() == Some("human")
                    && let Some(text) = message["text"].as_str()
                {
                    said.push(text.trim().to_owned());
                }
            }
        }
        // ChatGPT 导出：mapping{id: {message: {author: {role}, content: {parts}}}}
        if let Some(mapping) = conversation["mapping"].as_object() {
            let mut entries: Vec<(f64, String)> = mapping
                .values()
                .filter_map(|node| {
                    let message = node.get("message")?;
                    if message["author"]["role"].as_str() != Some("user") {
                        return None;
                    }
                    let text = message["content"]["parts"]
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n");
                    let at = message["create_time"].as_f64().unwrap_or(0.0);
                    Some((at, text.trim().to_owned()))
                })
                .collect();
            entries.sort_by(|a, b| a.0.total_cmp(&b.0));
            said.extend(entries.into_iter().map(|(_, text)| text));
        }
        said.retain(|text| !text.is_empty());
        if said.is_empty() {
            continue;
        }
        out.push(Chunk {
            topic: title.clone(),
            text: truncate(&format!("对话「{title}」里我说过：\n{}", said.join("\n"))),
            origin: String::from(origin),
        });
    }
    Some(out)
}

/// 角色卡（Character Card V1/V2/V3 的 JSON）：设定、性格、场景各一条，只作为往事，不改他的核心。
pub(crate) fn chunk_character_card(origin: &str, value: &Value) -> Option<Vec<Chunk>> {
    let spec = value["spec"].as_str().unwrap_or_default();
    let data = if spec.starts_with("chara_card") {
        &value["data"]
    } else {
        value
    };
    let name = data["name"].as_str()?.trim();
    let has_card_fields = ["description", "personality", "scenario"]
        .iter()
        .any(|field| data[*field].is_string());
    if name.is_empty() || !has_card_fields {
        return None;
    }
    let mut out = Vec::new();
    for (field, label) in [
        ("description", "设定"),
        ("personality", "性格"),
        ("scenario", "场景"),
    ] {
        let text = data[field].as_str().unwrap_or_default().trim();
        if text.chars().count() >= MIN_CHUNK_CHARS {
            out.push(Chunk {
                topic: String::from(name),
                text: truncate(&format!("角色卡「{name}」的{label}：{text}")),
                origin: String::from(origin),
            });
        }
    }
    (!out.is_empty()).then_some(out)
}

/// PNG 角色卡：卡片 JSON 以 base64 放在 `chara`（V2）或 `ccv3`（V3）文本块里。
pub(crate) fn card_json_from_png(bytes: &[u8]) -> Option<Value> {
    use base64::Engine as _;
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    let mut rest = bytes.strip_prefix(SIGNATURE)?;
    let mut found: Option<Value> = None;
    while rest.len() >= 12 {
        let len = u32::from_be_bytes(rest.get(0..4)?.try_into().ok()?) as usize;
        let kind = rest.get(4..8)?;
        let data = rest.get(8..8 + len)?;
        if kind == b"tEXt"
            && let Some(zero) = data.iter().position(|b| *b == 0)
        {
            let (keyword, text) = (&data[..zero], &data[zero + 1..]);
            if keyword == b"ccv3" || (keyword == b"chara" && found.is_none()) {
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(text)
                    .ok()
                    .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
                if decoded.is_some() {
                    found = decoded;
                }
            }
        }
        rest = rest.get(12 + len..)?;
    }
    found
}

fn collect_files(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        children.sort();
        for child in children {
            let hidden = child
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'));
            if !hidden {
                collect_files(&child, out);
            }
        }
    } else if path.is_file() {
        out.push(path.to_path_buf());
    }
}

/// 把若干路径（文件或目录）读成要带进来的段落。
pub(crate) fn read_chunks(paths: &[PathBuf]) -> (Vec<Chunk>, usize, Vec<String>) {
    let mut files = Vec::new();
    for path in paths {
        collect_files(path, &mut files);
    }
    let mut chunks = Vec::new();
    let mut skipped = Vec::new();
    let mut read = 0usize;
    for file in files {
        let display = file.display().to_string();
        let ext = file
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let too_big = fs::metadata(&file).is_ok_and(|m| m.len() > MAX_FILE_BYTES);
        if too_big {
            skipped.push(display);
            continue;
        }
        if ext == "png" {
            match fs::read(&file)
                .ok()
                .and_then(|bytes| card_json_from_png(&bytes))
                .and_then(|card| chunk_character_card(&display, &card))
            {
                Some(mut found) => {
                    read += 1;
                    chunks.append(&mut found);
                }
                None => skipped.push(display),
            }
            continue;
        }
        let Ok(raw) = fs::read_to_string(&file) else {
            skipped.push(display);
            continue;
        };
        let topic = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("笔记")
            .to_owned();
        let parsed = match ext.as_str() {
            "md" | "markdown" | "txt" | "text" => Some(chunk_markdown(&topic, &display, &raw)),
            "json" => serde_json::from_str::<Value>(&raw)
                .ok()
                .and_then(|card| chunk_character_card(&display, &card))
                .or_else(|| chunk_chat_export(&display, &raw)),
            _ => None,
        };
        match parsed {
            Some(mut found) => {
                read += 1;
                chunks.append(&mut found);
            }
            None => skipped.push(display),
        }
    }
    (chunks, read, skipped)
}

fn source_tag(batch_id: &str) -> String {
    format!("import:{batch_id}")
}

impl SharedDaemonCore {
    /// 带进一批。返回批次编号，整批可以撤回。
    pub(crate) fn import_notes(&self, paths: &[PathBuf]) -> Result<ImportReport> {
        let (chunks, files, skipped_files) = read_chunks(paths);
        if chunks.len() > MAX_PER_BATCH {
            return Err(QuetzalcoatlError::StorageError {
                detail: format!(
                    "这一批有 {} 段，超过 {MAX_PER_BATCH} 段的上限：分几次带进来，或者先整理一下。",
                    chunks.len()
                ),
            });
        }
        let batch_id = format!(
            "b{}{:02}",
            now_unix_ms(),
            BATCH_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 100
        );
        let home = self.config.quetzalcoatl_home.clone();
        let epoch = self.sea_epoch();
        let mut guard = self
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("守护进程状态锁中毒"),
            })?;
        let mut added = 0usize;
        for chunk in &chunks {
            guard.remember_written_by(
                &home,
                &chunk.text,
                false,
                Some(&chunk.topic),
                &format!("{}:{}", source_tag(&batch_id), chunk.origin),
                WRITTEN_BY,
                epoch,
                now_unix_ms(),
            )?;
            added += 1;
        }
        Ok(ImportReport {
            batch_id,
            files,
            added,
            skipped_files,
        })
    }

    /// 撤回一批：这一批带进来的每一条都抹除（真删）。
    pub(crate) fn undo_import(&self, batch_id: &str) -> Result<UndoReport> {
        let home = self.config.quetzalcoatl_home.clone();
        let epoch = self.sea_epoch();
        let prefix = format!("{}:", source_tag(batch_id));
        let mut guard = self
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("守护进程状态锁中毒"),
            })?;
        let doomed: Vec<String> = guard
            .conscience
            .memories
            .iter()
            .filter(|m| {
                m.provenance
                    .source_event_ids
                    .iter()
                    .any(|s| s.starts_with(&prefix))
            })
            .map(|m| m.id.clone())
            .collect();
        for id in &doomed {
            guard.owner_erase(&home, id, epoch, now_unix_ms())?;
        }
        Ok(UndoReport {
            batch_id: String::from(batch_id),
            erased: doomed.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{card_json_from_png, chunk_character_card, chunk_chat_export, chunk_markdown};

    #[test]
    fn character_cards_come_in_as_plain_memories_from_json_and_png() {
        use base64::Engine as _;
        let card = serde_json::json!({
            "spec": "chara_card_v2",
            "data": {"name": "阿砚", "description": "在旧书店打工的研究生，熟悉每一本绝版书的位置。", "personality": "慢热，讲话很轻，但对书的事一点不含糊。", "first_mes": "欢迎光临。"}
        });
        let chunks = chunk_character_card("c.json", &card).unwrap_or_default();
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].text.starts_with("角色卡「阿砚」的设定"));
        assert!(
            !chunks.iter().any(|c| c.text.contains("欢迎光临")),
            "开场白不带进来"
        );
        assert!(chunk_character_card("x.json", &serde_json::json!({"name": "只有名字"})).is_none());

        // 手搓一张最小的 PNG：签名 + 一个 tEXt「chara」块 + IEND。
        let payload = base64::engine::general_purpose::STANDARD.encode(card.to_string());
        let mut text = b"chara\0".to_vec();
        text.extend_from_slice(payload.as_bytes());
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        for (kind, data) in [(&b"tEXt"[..], text.as_slice()), (&b"IEND"[..], &b""[..])] {
            png.extend_from_slice(&u32::try_from(data.len()).unwrap_or(0).to_be_bytes());
            png.extend_from_slice(kind);
            png.extend_from_slice(data);
            png.extend_from_slice(&[0, 0, 0, 0]);
        }
        let parsed = card_json_from_png(&png).unwrap_or_default();
        assert_eq!(parsed["data"]["name"], "阿砚");
        assert!(card_json_from_png(b"not a png").is_none());
    }

    #[test]
    fn markdown_is_split_by_headings_and_short_bits_are_merged() {
        let raw = "---\ntitle: x\n---\n# 发布\n发布日定在周四，发版前跑完全量门禁。\n# 杂\n好\n# 数据库\n迁移先在预发环境演练。";
        let chunks = chunk_markdown("项目笔记", "a.md", raw);
        assert_eq!(chunks.len(), 2, "{chunks:?}");
        assert!(chunks[0].text.contains("发布日定在周四"));
        assert!(chunks[1].text.contains("迁移先在预发环境演练"));
        assert!(!chunks.iter().any(|c| c.text.contains("title: x")));
    }

    #[test]
    fn chat_exports_keep_only_what_the_user_said() {
        let claude = r#"[{"name":"旅行","chat_messages":[{"sender":"human","text":"我十月去京都"},{"sender":"assistant","text":"好的"}]}]"#;
        let chunks = chunk_chat_export("c.json", claude).unwrap_or_default();
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].text.contains("我十月去京都"));
        assert!(!chunks[0].text.contains("好的"));
        let chatgpt = r#"[{"title":"代码","mapping":{"a":{"message":{"author":{"role":"user"},"create_time":1,"content":{"parts":["帮我看看这个函数"]}}},"b":{"message":{"author":{"role":"assistant"},"content":{"parts":["当然"]}}}}}]"#;
        let chunks = chunk_chat_export("g.json", chatgpt).unwrap_or_default();
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].text.contains("帮我看看这个函数"));
        assert!(!chunks[0].text.contains("当然"));
        assert!(chunk_chat_export("x.json", "{\"not\":\"a list\"}").is_none());
    }
}

/// 登记的只读笔记目录：每个文件一批，记下它的摘要与批次编号。
const SOURCES_FILE: &str = "imports/sources.json";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct WatchedFile {
    sha256: String,
    batch_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct WatchedSource {
    #[serde(default)]
    files: std::collections::BTreeMap<String, WatchedFile>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SourcesLedger {
    #[serde(default)]
    sources: std::collections::BTreeMap<String, WatchedSource>,
}

fn load_sources(qz_home: &Path) -> SourcesLedger {
    fs::read(qz_home.join(SOURCES_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_sources(qz_home: &Path, ledger: &SourcesLedger) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(ledger).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("无法写出笔记来源: {e}"),
    })?;
    crate::daemon::write_private_file(&qz_home.join(SOURCES_FILE), &bytes)
}

/// 一次重读的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchReport {
    pub sources: Vec<String>,
    pub added: usize,
    pub updated: usize,
    pub erased: usize,
}

fn digest(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    quetzalcoatl_crypto::hex_encode(&sha2::Sha256::digest(bytes))
}

impl SharedDaemonCore {
    /// 登记（或取消登记）一个只读笔记目录，并立即重读一次。取消登记时已经带进来的留着。
    pub(crate) fn watch_notes(&self, path: Option<&Path>, stop: bool) -> Result<WatchReport> {
        let home = self.config.quetzalcoatl_home.clone();
        if let Some(path) = path {
            let key = path.to_string_lossy().into_owned();
            let mut ledger = load_sources(&home);
            if stop {
                ledger.sources.remove(&key);
            } else {
                if !path.is_dir() {
                    return Err(QuetzalcoatlError::StorageError {
                        detail: format!("{key} 不是一个目录"),
                    });
                }
                ledger.sources.entry(key).or_default();
            }
            save_sources(&home, &ledger)?;
        }
        self.sync_watched_notes()
    }

    /// 重读每个登记的目录：新文件带进来，改了的旧批次抹除、新内容接替，删了的抹除。
    pub(crate) fn sync_watched_notes(&self) -> Result<WatchReport> {
        let home = self.config.quetzalcoatl_home.clone();
        let mut ledger = load_sources(&home);
        let mut report = WatchReport {
            sources: ledger.sources.keys().cloned().collect(),
            ..WatchReport::default()
        };
        for (root, source) in &mut ledger.sources {
            let mut files = Vec::new();
            collect_files(Path::new(root), &mut files);
            let mut seen = BTreeSet::new();
            for file in files {
                let key = file.to_string_lossy().into_owned();
                let Ok(bytes) = fs::read(&file) else {
                    continue;
                };
                let sha = digest(&bytes);
                seen.insert(key.clone());
                let previous = source.files.get(&key).cloned();
                if previous.as_ref().is_some_and(|p| p.sha256 == sha) {
                    continue;
                }
                if let Some(old) = &previous {
                    self.undo_import(&old.batch_id)?;
                }
                let imported = self.import_notes(std::slice::from_ref(&file))?;
                if imported.added == 0 {
                    source.files.remove(&key);
                    continue;
                }
                source.files.insert(
                    key,
                    WatchedFile {
                        sha256: sha,
                        batch_id: imported.batch_id,
                    },
                );
                if previous.is_some() {
                    report.updated += 1;
                } else {
                    report.added += 1;
                }
            }
            let gone: Vec<String> = source
                .files
                .keys()
                .filter(|key| !seen.contains(*key))
                .cloned()
                .collect();
            for key in gone {
                if let Some(old) = source.files.remove(&key) {
                    self.undo_import(&old.batch_id)?;
                    report.erased += 1;
                }
            }
        }
        save_sources(&home, &ledger)?;
        Ok(report)
    }
}
