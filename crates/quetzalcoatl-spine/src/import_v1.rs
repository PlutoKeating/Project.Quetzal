use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::PackCompartment;
use quetzalcoatl_types::{ArtifactId, QuetzalcoatlError, Result, RunId, ThreadId};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::SpineEngine;
use crate::store::{
    MaterializedMemory, MaterializedMessage, MaterializedRun, MaterializedStore, MaterializedThread,
};

const V1_DEDUP_CONTEXT: &str = "quetzalcoatl/v2/import-v1-dedup-v1";
const V1_UUID_CONTEXT: &str = "quetzalcoatl/v2/import-v1-deterministic-uuid-v1";

/// V1 灵魂目录与多身体 SQLite 库单向幂等导入统计报告。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct V1ImportReport {
    pub imported_events: usize,
    pub skipped_duplicates: usize,
    pub memories_imported: usize,
    pub threads_imported: usize,
    pub messages_imported: usize,
    pub skills_imported: usize,
    pub docs_imported: usize,
    pub runs_imported: usize,
}

fn compute_v1_dedup_digest(kind: &str, key: &str, body: &[u8]) -> ArtifactId {
    let mut hasher = blake3::Hasher::new_derive_key(V1_DEDUP_CONTEXT);
    hasher.update(kind.as_bytes());
    hasher.update(&[0u8]);
    hasher.update(key.as_bytes());
    hasher.update(&[0u8]);
    hasher.update(body);
    ArtifactId::from_bytes(*hasher.finalize().as_bytes())
}

fn deterministic_uuid(namespace: &str, key: &str) -> Uuid {
    let mut hasher = blake3::Hasher::new_derive_key(V1_UUID_CONTEXT);
    hasher.update(namespace.as_bytes());
    hasher.update(&[0u8]);
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest.as_bytes()[0..16]);
    // RFC 9562 version 4 / variant 10xx 规范掩码保证合法 UUID 结构
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn collect_sorted_files(root: &Path, sub: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    let target = root.join(sub);
    if !target.exists() {
        return Ok(());
    }
    let mut dir_entries = Vec::new();
    for entry in fs::read_dir(&target).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("读取 V1 目录 {} 失败: {e}", target.display()),
    })? {
        let entry = entry.map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("遍历 V1 目录项失败: {e}"),
        })?;
        dir_entries.push(entry.path());
    }
    dir_entries.sort();

    for path in dir_entries {
        let rel = path
            .strip_prefix(root)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("计算 V1 相对路径失败: {e}"),
            })?;
        if path.is_dir() {
            collect_sorted_files(root, rel, out)?;
        } else if path.is_file() {
            let rel_slash = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel_slash, path));
        }
    }
    Ok(())
}

fn split_v1_section_blocks(raw: &str) -> Vec<String> {
    let normalized = raw.replace("\r\n", "\n");
    normalized
        .split("\n§\n")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn sqlite_table_exists(conn: &Connection, table_name: &str) -> Result<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1;",
            [table_name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("检查 V1 SQLite 表 {table_name} 失败: {e}"),
        })?;
    Ok(exists.is_some())
}

#[allow(clippy::cast_sign_loss)]
fn i64_nonneg_u64(v: i64) -> u64 {
    if v < 0 { 0 } else { v as u64 }
}

fn validate_safe_v1_doc_id(doc_id: &str) -> Result<()> {
    if doc_id.is_empty()
        || doc_id == "."
        || doc_id == ".."
        || doc_id.contains('/')
        || doc_id.contains('\\')
        || doc_id.contains("..")
        || doc_id.chars().any(char::is_control)
    {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: format!("拒绝包含路径分隔符或越界片段的 V1 canvas doc_id: {doc_id}"),
        });
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct MergedV1Session {
    title: String,
    channel: String,
    created: i64,
    updated: i64,
    archived: i64,
}

#[derive(Clone, Debug)]
struct LatestV1Canvas {
    ver_id: String,
    ts: i64,
    title: String,
    content: String,
}

fn emit_v1_event_once<S: MaterializedStore>(
    engine: &mut SpineEngine<S>,
    report: &mut V1ImportReport,
    dedup_kind: &str,
    dedup_key: &str,
    dedup_bytes: &[u8],
    payload_val: &serde_json::Value,
    local_wall_ms: u64,
) -> Result<Option<ArtifactId>> {
    let digest = compute_v1_dedup_digest(dedup_kind, dedup_key, dedup_bytes);
    if engine.store().has_v1_import_digest(&digest)? {
        report.skipped_duplicates += 1;
        return Ok(None);
    }
    let payload_utf8 =
        serde_json::to_string(payload_val).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("序列化 V1 导入事件 JSON 失败: {e}"),
        })?;
    engine.append_event(PackCompartment::Core, &payload_utf8, local_wall_ms)?;
    engine
        .store_mut()
        .record_v1_import_digest(&digest, dedup_kind, dedup_key)?;
    report.imported_events += 1;
    Ok(Some(digest))
}

pub fn run_import_v1<S: MaterializedStore>(
    engine: &mut SpineEngine<S>,
    soul_dir: &Path,
    db_paths: &[PathBuf],
    local_wall_ms: u64,
) -> Result<V1ImportReport> {
    if !soul_dir.is_dir() {
        return Err(QuetzalcoatlError::StorageError {
            detail: format!("V1 灵魂目录不存在: {}", soul_dir.display()),
        });
    }

    let spec_file = soul_dir.join(".soul-spec.json");
    if spec_file.is_file() {
        let raw_spec =
            fs::read_to_string(&spec_file).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 .soul-spec.json 失败: {e}"),
            })?;
        let spec_v: serde_json::Value =
            serde_json::from_str(&raw_spec).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("解析 .soul-spec.json 失败: {e}"),
            })?;
        if let Some(ver) = spec_v.get("version").and_then(serde_json::Value::as_u64)
            && !(1..=14).contains(&ver)
        {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!("不支持的灵魂规范版本 v{ver}（仅支持 v1–v14）"),
            });
        }
    }

    let mut report = V1ImportReport::default();

    // 1. agent.json
    let agent_json_path = soul_dir.join("agent.json");
    if agent_json_path.is_file() {
        let raw =
            fs::read_to_string(&agent_json_path).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 V1 agent.json 失败: {e}"),
            })?;
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("解析 V1 agent.json 失败: {e}"),
            })?;
        let ev_payload = serde_json::json!({
            "kind": "v1.agent_profile",
            "profile": parsed,
        });
        let _ = emit_v1_event_once(
            engine,
            &mut report,
            "soul.agent_json",
            "agent.json",
            raw.as_bytes(),
            &ev_payload,
            local_wall_ms,
        )?;
    }

    // 2. SOUL.md
    let soul_md_path = soul_dir.join("SOUL.md");
    if soul_md_path.is_file() {
        let raw =
            fs::read_to_string(&soul_md_path).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 V1 SOUL.md 失败: {e}"),
            })?;
        // 自述会成为良知里的一个条目，而条目正文不以明文进签名链（否则抹除就不是真删）：
        // 事件只记摘要，正文在可删除的物化视图里，并由变更日志封存后入链。
        let ev_payload = serde_json::json!({
            "kind": "conscience.v1_soul",
            "path": "SOUL.md",
            "content_blake3": blake3::hash(raw.as_bytes()).to_hex().to_string(),
        });
        if emit_v1_event_once(
            engine,
            &mut report,
            "soul.doc",
            "SOUL.md",
            raw.as_bytes(),
            &ev_payload,
            local_wall_ms,
        )?
        .is_some()
        {
            let hlc = engine.local_hlc();
            engine
                .store_mut()
                .upsert_markdown_doc("SOUL.md", &raw, hlc)?;
            report.docs_imported += 1;
        }
    }

    // 3. memories/MEMORY.md & memories/USER.md（按 `\n§\n` 切分幂等导入）
    for (rel_file, category, authority) in [
        ("memories/MEMORY.md", "memory", 30u8),
        ("memories/USER.md", "user_pref", 40u8),
    ] {
        let p = soul_dir.join(rel_file);
        if p.is_file() {
            let raw = fs::read_to_string(&p).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 V1 {rel_file} 失败: {e}"),
            })?;
            for block in split_v1_section_blocks(&raw) {
                // 同上：记忆正文不以明文进签名链，事件只记摘要。
                let ev_payload = serde_json::json!({
                    "kind": "memory.v1_import",
                    "category": category,
                    "authority": authority,
                    "content_blake3": blake3::hash(block.as_bytes()).to_hex().to_string(),
                });
                if let Some(digest) = emit_v1_event_once(
                    engine,
                    &mut report,
                    "soul.memory_block",
                    category,
                    block.as_bytes(),
                    &ev_payload,
                    local_wall_ms,
                )? {
                    let hlc = engine.local_hlc();
                    engine.store_mut().upsert_memory(&MaterializedMemory {
                        memory_id: format!("v1-mem-{}", &digest.to_hex()[0..16]),
                        category: String::from(category),
                        authority,
                        content: block,
                        updated_hlc: hlc,
                    })?;
                    report.memories_imported += 1;
                }
            }
        }
    }

    // 4. bodies/*.json
    let mut body_files = Vec::new();
    collect_sorted_files(soul_dir, Path::new("bodies"), &mut body_files)?;
    for (rel, full) in body_files {
        if !rel.ends_with(".json") {
            continue;
        }
        let raw = fs::read_to_string(&full).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取 V1 {rel} 失败: {e}"),
        })?;
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or(serde_json::Value::String(raw.clone()));
        let ev_payload = serde_json::json!({
            "kind": "v1.body_record",
            "path": rel,
            "record": parsed,
        });
        let _ = emit_v1_event_once(
            engine,
            &mut report,
            "soul.body",
            &rel,
            raw.as_bytes(),
            &ev_payload,
            local_wall_ms,
        )?;
    }

    // 5. skills/**/SKILL.md
    let mut skill_files = Vec::new();
    collect_sorted_files(soul_dir, Path::new("skills"), &mut skill_files)?;
    for (rel, full) in skill_files {
        if !rel.ends_with("SKILL.md") {
            continue;
        }
        let raw = fs::read_to_string(&full).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取 V1 技能 {rel} 失败: {e}"),
        })?;
        let ev_payload = serde_json::json!({
            "kind": "skill.v1_import",
            "authority": 50,
            "path": rel,
            "content": raw,
        });
        if emit_v1_event_once(
            engine,
            &mut report,
            "soul.skill",
            &rel,
            raw.as_bytes(),
            &ev_payload,
            local_wall_ms,
        )?
        .is_some()
        {
            let hlc = engine.local_hlc();
            engine.store_mut().upsert_markdown_doc(&rel, &raw, hlc)?;
            report.skills_imported += 1;
        }
    }

    // 6. journal/**/*.md & notes/**/*.md
    for dir_name in ["journal", "notes"] {
        let mut md_files = Vec::new();
        collect_sorted_files(soul_dir, Path::new(dir_name), &mut md_files)?;
        for (rel, full) in md_files {
            if !rel.ends_with(".md") {
                continue;
            }
            let raw = fs::read_to_string(&full).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 V1 文档 {rel} 失败: {e}"),
            })?;
            let ev_payload = serde_json::json!({
                "kind": "doc.v1_import",
                "authority": 30,
                "path": rel,
                "content": raw,
            });
            if emit_v1_event_once(
                engine,
                &mut report,
                "soul.markdown",
                &rel,
                raw.as_bytes(),
                &ev_payload,
                local_wall_ms,
            )?
            .is_some()
            {
                let hlc = engine.local_hlc();
                engine.store_mut().upsert_markdown_doc(&rel, &raw, hlc)?;
                report.docs_imported += 1;
            }
        }
    }

    // 7. 多身体 SQLite quetzal.db 库幂等合并导入
    // 先跨全部数据库聚合收敛 sessions（按最大 updated 取最新状态）与 canvas_docs（每个 doc_id 仅保留最大 ts 最新修订版）
    let mut merged_sessions = BTreeMap::<String, MergedV1Session>::new();
    let mut latest_canvas_by_doc = BTreeMap::<String, LatestV1Canvas>::new();

    for db_path in db_paths {
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("只读打开 V1 SQLite 库 {} 失败: {e}", db_path.display()),
        })?;

        if sqlite_table_exists(&conn, "sessions")? {
            let mut stmt = conn
                .prepare(
                    "SELECT id, COALESCE(title, ''), COALESCE(channel, ''),
                            COALESCE(created, 0), COALESCE(updated, 0), COALESCE(archived, 0)
                     FROM sessions ORDER BY created ASC, id ASC;",
                )
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("查询 V1 sessions 失败: {e}"),
                })?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                    ))
                })
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("遍历 V1 sessions 失败: {e}"),
                })?;
            for row in rows {
                let (sid, title, channel, created, updated, archived) =
                    row.map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("读取 V1 session 行失败: {e}"),
                    })?;
                merged_sessions
                    .entry(sid)
                    .and_modify(|cur| {
                        if created > 0 && (cur.created <= 0 || created < cur.created) {
                            cur.created = created;
                        }
                        if (updated, &title, archived) > (cur.updated, &cur.title, cur.archived) {
                            cur.title.clone_from(&title);
                            cur.channel.clone_from(&channel);
                            cur.updated = updated;
                            cur.archived = archived;
                        }
                    })
                    .or_insert(MergedV1Session {
                        title,
                        channel,
                        created,
                        updated,
                        archived,
                    });
            }
        }

        if sqlite_table_exists(&conn, "canvas_docs")?
            && sqlite_table_exists(&conn, "canvas_versions")?
        {
            let mut stmt = conn
                .prepare(
                    "SELECT d.id, COALESCE(d.title, ''), COALESCE(v.id, ''),
                            COALESCE(v.ts, 0), COALESCE(v.content, '')
                     FROM canvas_docs d
                     JOIN canvas_versions v ON v.doc = d.id
                     WHERE COALESCE(d.deleted, 0) = 0;",
                )
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("查询 V1 canvas_docs 失败: {e}"),
                })?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("遍历 V1 canvas_docs 失败: {e}"),
                })?;
            for row in rows {
                let (doc_id, title, ver_id, ts, content) =
                    row.map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("读取 V1 canvas 行失败: {e}"),
                    })?;
                validate_safe_v1_doc_id(&doc_id)?;
                latest_canvas_by_doc
                    .entry(doc_id)
                    .and_modify(|cur| {
                        if (ts, &ver_id) > (cur.ts, &cur.ver_id) {
                            cur.ver_id.clone_from(&ver_id);
                            cur.ts = ts;
                            cur.title.clone_from(&title);
                            cur.content.clone_from(&content);
                        }
                    })
                    .or_insert(LatestV1Canvas {
                        ver_id,
                        ts,
                        title,
                        content,
                    });
            }
        }
    }

    for (sid, sess) in merged_sessions {
        let ev_payload = serde_json::json!({
            "kind": "thread.v1_import",
            "session_id": sid,
            "title": sess.title,
            "channel": sess.channel,
            "created": sess.created,
            "updated": sess.updated,
            "archived": sess.archived != 0,
        });
        let canonical_session = format!(
            "{sid}\0{}\0{}\0{}\0{}",
            sess.title, sess.channel, sess.updated, sess.archived
        );
        if emit_v1_event_once(
            engine,
            &mut report,
            "db.session",
            &sid,
            canonical_session.as_bytes(),
            &ev_payload,
            local_wall_ms,
        )?
        .is_some()
        {
            let tid = ThreadId::from_uuid(deterministic_uuid("v1.thread", &sid));
            engine.store_mut().upsert_thread(&MaterializedThread {
                thread_id: tid,
                legacy_key: sid,
                title: sess.title,
                channel: sess.channel,
                created_ms: i64_nonneg_u64(sess.created),
                updated_ms: i64_nonneg_u64(sess.updated),
                archived: sess.archived != 0,
            })?;
            report.threads_imported += 1;
        }
    }

    for db_path in db_paths {
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("只读打开 V1 SQLite 库 {} 失败: {e}", db_path.display()),
        })?;

        if sqlite_table_exists(&conn, "messages")? {
            let mut stmt = conn
                .prepare(
                    "SELECT id, COALESCE(ts, 0), COALESCE(role, ''), COALESCE(channel, ''),
                            COALESCE(text, ''), COALESCE(session, 'default'), COALESCE(body, 'unknown')
                     FROM messages ORDER BY ts ASC, id ASC;",
                )
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("查询 V1 messages 失败: {e}"),
                })?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                    ))
                })
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("遍历 V1 messages 失败: {e}"),
                })?;
            let mut msg_items = Vec::new();
            for row in rows {
                msg_items.push(row.map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("读取 V1 message 行失败: {e}"),
                })?);
            }
            for (mid, ts, role, channel, text, session, body) in msg_items {
                let msg_key = format!("v1-msg-{mid}");
                let canonical_msg = format!("{mid}\0{ts}\0{role}\0{session}\0{body}\0{text}");
                let ev_payload = serde_json::json!({
                    "kind": "message.v1_import",
                    "v1_id": mid,
                    "ts": ts,
                    "role": role,
                    "channel": channel,
                    "session": session,
                    "body": body,
                    "text": text,
                });
                if emit_v1_event_once(
                    engine,
                    &mut report,
                    "db.message",
                    &msg_key,
                    canonical_msg.as_bytes(),
                    &ev_payload,
                    local_wall_ms,
                )?
                .is_some()
                {
                    engine.store_mut().upsert_message(&MaterializedMessage {
                        message_id: msg_key,
                        thread_key: session,
                        role,
                        channel,
                        body_origin: body,
                        content: text,
                        ts_ms: i64_nonneg_u64(ts),
                    })?;
                    report.messages_imported += 1;
                }
            }
        }

        if sqlite_table_exists(&conn, "timeline")? {
            let mut stmt = conn
                .prepare(
                    "SELECT id, COALESCE(ts, 0), COALESCE(kind, ''), COALESCE(title, ''),
                            COALESCE(detail, ''), COALESCE(body, '')
                     FROM timeline ORDER BY ts ASC, id ASC;",
                )
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("查询 V1 timeline 失败: {e}"),
                })?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                })
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("遍历 V1 timeline 失败: {e}"),
                })?;
            let mut tl_items = Vec::new();
            for row in rows {
                tl_items.push(row.map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("读取 V1 timeline 行失败: {e}"),
                })?);
            }
            for (tid, ts, kind, title, detail, body) in tl_items {
                let tl_key = format!("v1-tl-{tid}");
                let canonical = format!("{tid}\0{ts}\0{kind}\0{body}\0{title}\0{detail}");
                let ev_payload = serde_json::json!({
                    "kind": "timeline.v1_import",
                    "v1_id": tid,
                    "ts": ts,
                    "entry_kind": kind,
                    "title": title,
                    "detail": detail,
                    "body": body,
                });
                let _ = emit_v1_event_once(
                    engine,
                    &mut report,
                    "db.timeline",
                    &tl_key,
                    canonical.as_bytes(),
                    &ev_payload,
                    local_wall_ms,
                )?;
            }
        }

        if sqlite_table_exists(&conn, "kv")? {
            let mut stmt = conn
                .prepare("SELECT k, COALESCE(v, '') FROM kv ORDER BY k ASC;")
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("查询 V1 kv 失败: {e}"),
                })?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("遍历 V1 kv 失败: {e}"),
                })?;
            let mut kv_items = Vec::new();
            for row in rows {
                kv_items.push(row.map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("读取 V1 kv 行失败: {e}"),
                })?);
            }

            for (k, v) in kv_items {
                match k.as_str() {
                    "thought" => {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&v)
                            && let Some(text) =
                                parsed.get("text").and_then(serde_json::Value::as_str)
                            && !text.trim().is_empty()
                        {
                            let ev_payload = serde_json::json!({
                                "kind": "memory.v1_thought",
                                "authority": 30,
                                "content": text,
                            });
                            if let Some(digest) = emit_v1_event_once(
                                engine,
                                &mut report,
                                "db.kv.thought",
                                "thought",
                                text.as_bytes(),
                                &ev_payload,
                                local_wall_ms,
                            )? {
                                let hlc = engine.local_hlc();
                                engine.store_mut().upsert_memory(&MaterializedMemory {
                                    memory_id: format!("v1-thought-{}", &digest.to_hex()[0..16]),
                                    category: String::from("thought"),
                                    authority: 30,
                                    content: text.to_owned(),
                                    updated_hlc: hlc,
                                })?;
                                report.memories_imported += 1;
                            }
                        }
                    }
                    "goals" => {
                        if let Ok(serde_json::Value::Array(goals)) = serde_json::from_str(&v) {
                            for goal in goals {
                                let gid = goal
                                    .get("id")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("unknown");
                                let title = goal
                                    .get("title")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("");
                                let detail = goal
                                    .get("detail")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("");
                                let status = goal
                                    .get("status")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("open");
                                let canonical = format!("{gid}\0{title}\0{detail}\0{status}");
                                let ev_payload = serde_json::json!({
                                    "kind": "run.v1_goal",
                                    "goal": goal,
                                });
                                if emit_v1_event_once(
                                    engine,
                                    &mut report,
                                    "db.kv.goal",
                                    gid,
                                    canonical.as_bytes(),
                                    &ev_payload,
                                    local_wall_ms,
                                )?
                                .is_some()
                                {
                                    let hlc = engine.local_hlc();
                                    let run_id =
                                        RunId::from_uuid(deterministic_uuid("v1.goal", gid));
                                    engine.store_mut().upsert_run(&MaterializedRun {
                                        run_id,
                                        mode: String::from("commit"),
                                        status: status.to_owned(),
                                        title: title.to_owned(),
                                        detail: detail.to_owned(),
                                        updated_hlc: hlc,
                                    })?;
                                    report.runs_imported += 1;
                                }
                            }
                        }
                    }
                    "projects" => {
                        if let Ok(serde_json::Value::Array(projects)) = serde_json::from_str(&v) {
                            for proj in projects {
                                let pid = proj
                                    .get("id")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("unknown");
                                let raw_proj = serde_json::to_string(&proj).unwrap_or_default();
                                let ev_payload = serde_json::json!({
                                    "kind": "project.v1_import",
                                    "project": proj,
                                });
                                let _ = emit_v1_event_once(
                                    engine,
                                    &mut report,
                                    "db.kv.project",
                                    pid,
                                    raw_proj.as_bytes(),
                                    &ev_payload,
                                    local_wall_ms,
                                )?;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    for (doc_id, canvas) in latest_canvas_by_doc {
        let rel = format!("notes/canvas/{doc_id}.md");
        let ev_payload = serde_json::json!({
            "kind": "canvas.v1_import",
            "doc_id": doc_id,
            "version_id": canvas.ver_id,
            "ts": canvas.ts,
            "title": canvas.title,
            "content": canvas.content,
        });
        let canonical_canvas = format!(
            "{}\0{}\0{}\0{}",
            canvas.ver_id, canvas.ts, canvas.title, canvas.content
        );
        if emit_v1_event_once(
            engine,
            &mut report,
            "db.canvas",
            &doc_id,
            canonical_canvas.as_bytes(),
            &ev_payload,
            local_wall_ms,
        )?
        .is_some()
        {
            let hlc = engine.local_hlc();
            engine
                .store_mut()
                .upsert_markdown_doc(&rel, &canvas.content, hlc)?;
            report.docs_imported += 1;
        }
    }

    Ok(report)
}
