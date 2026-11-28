//! 把你已有的东西带进来：笔记（Markdown、纯文本）、宿主的规则与记忆文件、各家对话导出包。
//!
//! 每次导入是一批，有自己的编号；整批可以撤回（撤回就是逐条抹除，真删）。
//! 导入的内容只作为普通往事，标明来源；不会成为他的核心或你的底线。

use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::daemon::{SharedDaemonCore, now_unix_ms};

const WRITTEN_BY: &str = "import";
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
        let Ok(raw) = fs::read_to_string(&file) else {
            skipped.push(display);
            continue;
        };
        if too_big {
            skipped.push(display);
            continue;
        }
        let topic = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("笔记")
            .to_owned();
        let parsed = match ext.as_str() {
            "md" | "markdown" | "txt" | "text" => Some(chunk_markdown(&topic, &display, &raw)),
            "json" => chunk_chat_export(&display, &raw),
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
        let batch_id = format!("b{}", now_unix_ms());
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
    use super::{chunk_chat_export, chunk_markdown};

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
