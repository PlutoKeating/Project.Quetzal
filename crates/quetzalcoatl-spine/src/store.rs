use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use quetzalcoatl_crypto::{PackCompartment, SealedPackfile, hex_decode_fixed, hex_encode};
use quetzalcoatl_types::{
    AgentId, ArtifactId, DeviceId, HlcTimestamp, QuetzalcoatlError, Result, RunId, ThreadId,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::ledger::{SpineCheckpoint, SpineEvent, SpineEventHeader};

/// 物化记忆条目。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterializedMemory {
    pub memory_id: String,
    pub category: String,
    pub authority: u8,
    pub content: String,
    pub updated_hlc: HlcTimestamp,
}

/// 物化会话线程记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterializedThread {
    pub thread_id: ThreadId,
    pub legacy_key: String,
    pub title: String,
    pub channel: String,
    pub created_ms: u64,
    pub updated_ms: u64,
    pub archived: bool,
}

/// 物化消息记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterializedMessage {
    pub message_id: String,
    pub thread_key: String,
    pub role: String,
    pub channel: String,
    pub body_origin: String,
    pub content: String,
    pub ts_ms: u64,
}

/// 物化 `Run` 执行断点记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterializedRun {
    pub run_id: RunId,
    pub mode: String,
    pub status: String,
    pub title: String,
    pub detail: String,
    pub updated_hlc: HlcTimestamp,
}

/// 事件头摘要（不含完整 payload）：供桌面快照/审计页按需读取最近 N 条。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpineEventHead {
    pub seq: u64,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub epoch: u64,
    pub hlc_hex: String,
    /// payload 前 512 字符，仅用于恢复 `payload.kind` 审计归类，绝不整段反序列化历史。
    pub payload_prefix: String,
}

/// 可随时由签名事件脊柱确定性重建的本地物化视图契约。
pub trait MaterializedStore {
    fn register_device_pubkey(
        &mut self,
        device_id: DeviceId,
        ed25519_pubkey: &[u8; 32],
    ) -> Result<()>;
    fn get_device_pubkey(&self, device_id: DeviceId) -> Result<Option<[u8; 32]>>;
    fn list_device_pubkeys(&self) -> Result<Vec<(DeviceId, [u8; 32])>>;

    fn append_spine_event(
        &mut self,
        event: &SpineEvent,
        compartment: PackCompartment,
    ) -> Result<()>;
    fn device_chain_head(&self, device_id: DeviceId) -> Result<Option<(u64, ArtifactId)>>;
    fn list_device_events(&self, device_id: DeviceId) -> Result<Vec<SpineEvent>>;
    fn list_all_events(&self) -> Result<Vec<(SpineEvent, PackCompartment)>>;
    /// 事件总数 + 最近 `limit` 条事件头：`COUNT(*)` + `ORDER BY seq DESC LIMIT n`，
    /// 绝不把整段历史 payload 载入内存（桌面端每次 hydrate 都会调用）。
    fn spine_event_count_and_heads(&self, limit: usize) -> Result<(u64, Vec<SpineEventHead>)>;
    fn list_all_unpacked_events(&self) -> Result<Vec<(SpineEvent, PackCompartment)>>;
    fn list_unpacked_events(
        &self,
        device_id: DeviceId,
        compartment: PackCompartment,
    ) -> Result<Vec<SpineEvent>>;
    fn mark_events_packed(
        &mut self,
        device_id: DeviceId,
        compartment: PackCompartment,
        first_seq: u64,
        last_seq: u64,
        pack_id: ArtifactId,
    ) -> Result<()>;

    fn commit_verified_event_batch(
        &mut self,
        device_pubkeys: &[(DeviceId, [u8; 32])],
        events: &[(SpineEvent, PackCompartment, Option<ArtifactId>)],
        packs: &[SealedPackfile],
    ) -> Result<()>;

    fn put_packfile(&mut self, pack: &SealedPackfile) -> Result<()>;
    fn list_packfiles(&self) -> Result<Vec<SealedPackfile>>;

    fn put_checkpoint(&mut self, checkpoint: &SpineCheckpoint) -> Result<()>;
    fn latest_checkpoint(&self) -> Result<Option<SpineCheckpoint>>;
    fn list_checkpoints(&self) -> Result<Vec<SpineCheckpoint>>;

    fn upsert_memory(&mut self, memory: &MaterializedMemory) -> Result<()>;
    /// 删除一条物化的记忆及其全文索引，并把腾出的页清零。不存在时不算错误。
    fn delete_memory(&mut self, memory_id: &str) -> Result<()>;
    fn list_memories(&self) -> Result<Vec<MaterializedMemory>>;
    fn search_memories_fts(&self, query: &str, limit: usize) -> Result<Vec<MaterializedMemory>>;

    fn upsert_thread(&mut self, thread: &MaterializedThread) -> Result<()>;
    fn list_threads(&self) -> Result<Vec<MaterializedThread>>;

    fn upsert_message(&mut self, message: &MaterializedMessage) -> Result<()>;
    fn list_messages(&self, thread_key: Option<&str>) -> Result<Vec<MaterializedMessage>>;
    fn search_messages_fts(&self, query: &str, limit: usize) -> Result<Vec<MaterializedMessage>>;

    fn upsert_run(&mut self, run: &MaterializedRun) -> Result<()>;
    fn list_runs(&self) -> Result<Vec<MaterializedRun>>;

    fn upsert_markdown_doc(
        &mut self,
        rel_path: &str,
        content: &str,
        updated_hlc: HlcTimestamp,
    ) -> Result<()>;
    fn list_markdown_docs(&self) -> Result<Vec<(String, String)>>;

    /// 不可导出的私有状态块（群组 MLS 私钥材料等）：仅存于本地脊柱库，绝不进入可读 ZIP 导出。
    fn put_private_blob(&mut self, blob_key: &str, payload_json: &str) -> Result<()>;
    fn get_private_blob(&self, blob_key: &str) -> Result<Option<String>>;
    /// 删除一个私有状态块，并要求存储把腾出的页清零：条目钥匙就放在这里，删除必须是真删。
    fn delete_private_blob(&mut self, blob_key: &str) -> Result<()>;

    fn has_v1_import_digest(&self, digest: &ArtifactId) -> Result<bool>;
    fn record_v1_import_digest(
        &mut self,
        digest: &ArtifactId,
        source_kind: &str,
        source_key: &str,
    ) -> Result<()>;
}

fn sql_err(err: rusqlite::Error) -> QuetzalcoatlError {
    QuetzalcoatlError::StorageError {
        detail: format!("SQLite 物化存储错误: {err}"),
    }
}

fn parse_compartment(s: &str) -> Result<PackCompartment> {
    match s {
        "core" => Ok(PackCompartment::Core),
        "external_channel" => Ok(PackCompartment::ExternalChannel),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知 PackCompartment 标签: {other}"),
        }),
    }
}

fn escape_fts_phrase(query: &str) -> String {
    let escaped = query.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// 基于 `rusqlite` `journal_mode = WAL` + `FTS5 trigram` 的本地物化存储实现。
pub struct RusqliteWalStore {
    conn: Connection,
}

impl RusqliteWalStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("创建脊柱数据库目录失败: {e}"),
            })?;
        }

        let conn = Connection::open(path).map_err(sql_err)?;
        conn.busy_timeout(Duration::from_millis(5_000))
            .map_err(sql_err)?;
        let _: String = conn
            .query_row("PRAGMA journal_mode = WAL;", [], |row| row.get(0))
            .map_err(sql_err)?;
        conn.execute_batch(
            "
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS device_keys (
                device_id TEXT PRIMARY KEY,
                ed25519_pubkey_hex TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS spine_events (
                device_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                epoch INTEGER NOT NULL,
                hlc_be BLOB NOT NULL,
                hlc_hex TEXT NOT NULL,
                prev_blake3 TEXT NOT NULL,
                payload_blake3 TEXT NOT NULL,
                event_blake3 TEXT NOT NULL,
                sig_hex TEXT NOT NULL,
                payload_utf8 TEXT NOT NULL,
                compartment TEXT NOT NULL,
                pack_id TEXT,
                PRIMARY KEY (device_id, seq)
            );
            CREATE INDEX IF NOT EXISTS idx_spine_events_hlc ON spine_events(hlc_be);
            CREATE INDEX IF NOT EXISTS idx_spine_events_unpacked ON spine_events(device_id, compartment, pack_id, seq);

            CREATE TABLE IF NOT EXISTS packfiles (
                pack_id TEXT PRIMARY KEY,
                compartment TEXT NOT NULL,
                epoch INTEGER NOT NULL,
                device_id TEXT NOT NULL,
                first_seq INTEGER NOT NULL,
                last_seq INTEGER NOT NULL,
                pack_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS checkpoints (
                idx INTEGER PRIMARY KEY AUTOINCREMENT,
                checkpoint_id TEXT NOT NULL UNIQUE,
                hlc_hex TEXT NOT NULL,
                checkpoint_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memories (
                memory_id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                authority INTEGER NOT NULL,
                content TEXT NOT NULL,
                updated_hlc_hex TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                memory_id UNINDEXED,
                category,
                content,
                tokenize = 'trigram'
            );

            CREATE TABLE IF NOT EXISTS threads (
                legacy_key TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                title TEXT NOT NULL,
                channel TEXT NOT NULL,
                created_ms INTEGER NOT NULL,
                updated_ms INTEGER NOT NULL,
                archived INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                message_id TEXT PRIMARY KEY,
                thread_key TEXT NOT NULL,
                role TEXT NOT NULL,
                channel TEXT NOT NULL,
                body_origin TEXT NOT NULL,
                content TEXT NOT NULL,
                ts_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_key, ts_ms);

            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                message_id UNINDEXED,
                thread_key UNINDEXED,
                role,
                content,
                tokenize = 'trigram'
            );

            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                status TEXT NOT NULL,
                title TEXT NOT NULL,
                detail TEXT NOT NULL,
                updated_hlc_hex TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS private_blobs (
                blob_key TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_hlc_hex TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS markdown_docs (
                rel_path TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                updated_hlc_hex TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS v1_import_dedup (
                digest_hex TEXT PRIMARY KEY,
                source_kind TEXT NOT NULL,
                source_key TEXT NOT NULL
            );
            ",
        )
        .map_err(sql_err)?;

        Ok(Self { conn })
    }

    pub fn journal_mode(&self) -> Result<String> {
        self.conn
            .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
            .map_err(sql_err)
    }
}

#[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
fn u64_to_i64(v: u64) -> i64 {
    v as i64
}

#[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
fn i64_to_u64(v: i64) -> u64 {
    v as u64
}

fn row_to_spine_event(row: &rusqlite::Row<'_>) -> Result<(SpineEvent, PackCompartment)> {
    let device_str: String = row.get(0).map_err(sql_err)?;
    let seq_i64: i64 = row.get(1).map_err(sql_err)?;
    let agent_str: String = row.get(2).map_err(sql_err)?;
    let epoch_i64: i64 = row.get(3).map_err(sql_err)?;
    let hlc_hex: String = row.get(4).map_err(sql_err)?;
    let prev_hex: String = row.get(5).map_err(sql_err)?;
    let payload_b3_hex: String = row.get(6).map_err(sql_err)?;
    let event_b3_hex: String = row.get(7).map_err(sql_err)?;
    let sig_hex: String = row.get(8).map_err(sql_err)?;
    let payload_utf8: String = row.get(9).map_err(sql_err)?;
    let comp_str: String = row.get(10).map_err(sql_err)?;

    let header = SpineEventHeader {
        agent_id: AgentId::from_str(&agent_str)?,
        device_id: DeviceId::from_str(&device_str)?,
        epoch: i64_to_u64(epoch_i64),
        hlc: HlcTimestamp::from_hex(&hlc_hex)?,
        payload_blake3: ArtifactId::from_hex(&payload_b3_hex)?,
        prev_blake3: ArtifactId::from_hex(&prev_hex)?,
        seq: i64_to_u64(seq_i64),
    };
    let ev = SpineEvent {
        header,
        event_blake3: ArtifactId::from_hex(&event_b3_hex)?,
        sig_hex,
        payload_utf8,
    };
    Ok((ev, parse_compartment(&comp_str)?))
}

impl MaterializedStore for RusqliteWalStore {
    fn register_device_pubkey(
        &mut self,
        device_id: DeviceId,
        ed25519_pubkey: &[u8; 32],
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO device_keys (device_id, ed25519_pubkey_hex) VALUES (?1, ?2)
                 ON CONFLICT(device_id) DO UPDATE SET ed25519_pubkey_hex = excluded.ed25519_pubkey_hex;",
                params![device_id.to_string(), hex_encode(ed25519_pubkey)],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn get_device_pubkey(&self, device_id: DeviceId) -> Result<Option<[u8; 32]>> {
        let opt_hex: Option<String> = self
            .conn
            .query_row(
                "SELECT ed25519_pubkey_hex FROM device_keys WHERE device_id = ?1;",
                params![device_id.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        opt_hex
            .map(|h| hex_decode_fixed::<32>("device_ed25519_pubkey", &h))
            .transpose()
    }

    fn list_device_pubkeys(&self) -> Result<Vec<(DeviceId, [u8; 32])>> {
        let mut stmt = self
            .conn
            .prepare("SELECT device_id, ed25519_pubkey_hex FROM device_keys ORDER BY device_id;")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for item in rows {
            let (id_s, pk_hex) = item.map_err(sql_err)?;
            out.push((
                DeviceId::from_str(&id_s)?,
                hex_decode_fixed::<32>("device_ed25519_pubkey", &pk_hex)?,
            ));
        }
        Ok(out)
    }

    fn append_spine_event(
        &mut self,
        event: &SpineEvent,
        compartment: PackCompartment,
    ) -> Result<()> {
        let hlc_be = event.header.hlc.to_be_bytes();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO spine_events (
                    device_id, seq, agent_id, epoch, hlc_be, hlc_hex,
                    prev_blake3, payload_blake3, event_blake3, sig_hex, payload_utf8, compartment, pack_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL);",
                params![
                    event.header.device_id.to_string(),
                    u64_to_i64(event.header.seq),
                    event.header.agent_id.to_string(),
                    u64_to_i64(event.header.epoch),
                    hlc_be.as_slice(),
                    event.header.hlc.to_hex(),
                    event.header.prev_blake3.to_hex(),
                    event.header.payload_blake3.to_hex(),
                    event.event_blake3.to_hex(),
                    &event.sig_hex,
                    &event.payload_utf8,
                    compartment.as_str(),
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn device_chain_head(&self, device_id: DeviceId) -> Result<Option<(u64, ArtifactId)>> {
        let row: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT seq, event_blake3 FROM spine_events WHERE device_id = ?1 ORDER BY seq DESC LIMIT 1;",
                params![device_id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql_err)?;
        match row {
            Some((seq_i, eb_hex)) => Ok(Some((i64_to_u64(seq_i), ArtifactId::from_hex(&eb_hex)?))),
            None => Ok(None),
        }
    }

    fn list_device_events(&self, device_id: DeviceId) -> Result<Vec<SpineEvent>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT device_id, seq, agent_id, epoch, hlc_hex, prev_blake3, payload_blake3,
                        event_blake3, sig_hex, payload_utf8, compartment
                 FROM spine_events WHERE device_id = ?1 ORDER BY seq ASC;",
            )
            .map_err(sql_err)?;
        let mut rows = stmt
            .query(params![device_id.to_string()])
            .map_err(sql_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(sql_err)? {
            let (ev, _) = row_to_spine_event(row)?;
            out.push(ev);
        }
        Ok(out)
    }

    fn spine_event_count_and_heads(&self, limit: usize) -> Result<(u64, Vec<SpineEventHead>)> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM spine_events;", [], |row| row.get(0))
            .map_err(sql_err)?;
        let limit_i64 = i64::try_from(limit).unwrap_or(i64::MAX);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT seq, agent_id, device_id, epoch, hlc_hex, substr(payload_utf8, 1, 512)
                 FROM spine_events ORDER BY seq DESC LIMIT ?1;",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([limit_i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(sql_err)?;
        let mut heads = Vec::new();
        for row in rows {
            let (seq, agent, device, epoch, hlc_hex, payload_prefix) = row.map_err(sql_err)?;
            heads.push(SpineEventHead {
                seq: i64_to_u64(seq),
                agent_id: AgentId::from_str(&agent)?,
                device_id: DeviceId::from_str(&device)?,
                epoch: i64_to_u64(epoch),
                hlc_hex,
                payload_prefix,
            });
        }
        Ok((i64_to_u64(count), heads))
    }

    fn list_all_events(&self) -> Result<Vec<(SpineEvent, PackCompartment)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT device_id, seq, agent_id, epoch, hlc_hex, prev_blake3, payload_blake3,
                        event_blake3, sig_hex, payload_utf8, compartment
                 FROM spine_events ORDER BY hlc_be ASC, device_id ASC, seq ASC;",
            )
            .map_err(sql_err)?;
        let mut rows = stmt.query([]).map_err(sql_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(sql_err)? {
            out.push(row_to_spine_event(row)?);
        }
        Ok(out)
    }

    fn list_all_unpacked_events(&self) -> Result<Vec<(SpineEvent, PackCompartment)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT device_id, seq, agent_id, epoch, hlc_hex, prev_blake3, payload_blake3,
                        event_blake3, sig_hex, payload_utf8, compartment
                 FROM spine_events WHERE pack_id IS NULL
                 ORDER BY device_id ASC, seq ASC;",
            )
            .map_err(sql_err)?;
        let mut rows = stmt.query([]).map_err(sql_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(sql_err)? {
            out.push(row_to_spine_event(row)?);
        }
        Ok(out)
    }

    fn list_unpacked_events(
        &self,
        device_id: DeviceId,
        compartment: PackCompartment,
    ) -> Result<Vec<SpineEvent>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT device_id, seq, agent_id, epoch, hlc_hex, prev_blake3, payload_blake3,
                        event_blake3, sig_hex, payload_utf8, compartment
                 FROM spine_events
                 WHERE device_id = ?1 AND compartment = ?2 AND pack_id IS NULL
                 ORDER BY seq ASC;",
            )
            .map_err(sql_err)?;
        let mut rows = stmt
            .query(params![device_id.to_string(), compartment.as_str()])
            .map_err(sql_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(sql_err)? {
            let (ev, _) = row_to_spine_event(row)?;
            out.push(ev);
        }
        Ok(out)
    }

    fn mark_events_packed(
        &mut self,
        device_id: DeviceId,
        compartment: PackCompartment,
        first_seq: u64,
        last_seq: u64,
        pack_id: ArtifactId,
    ) -> Result<()> {
        self.conn
            .execute(
                "UPDATE spine_events SET pack_id = ?1
                 WHERE device_id = ?2 AND compartment = ?3 AND pack_id IS NULL AND seq >= ?4 AND seq <= ?5;",
                params![
                    pack_id.to_hex(),
                    device_id.to_string(),
                    compartment.as_str(),
                    u64_to_i64(first_seq),
                    u64_to_i64(last_seq),
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn commit_verified_event_batch(
        &mut self,
        device_pubkeys: &[(DeviceId, [u8; 32])],
        events: &[(SpineEvent, PackCompartment, Option<ArtifactId>)],
        packs: &[SealedPackfile],
    ) -> Result<()> {
        let mut pack_jsons = Vec::with_capacity(packs.len());
        for pack in packs {
            let json =
                serde_json::to_string(pack).map_err(|e| QuetzalcoatlError::SerializationError {
                    detail: format!("序列化 SealedPackfile 失败: {e}"),
                })?;
            pack_jsons.push((pack, json));
        }

        let tx = self.conn.transaction().map_err(sql_err)?;
        for (dev_id, pk) in device_pubkeys {
            tx.execute(
                "INSERT INTO device_keys (device_id, ed25519_pubkey_hex) VALUES (?1, ?2)
                 ON CONFLICT(device_id) DO UPDATE SET ed25519_pubkey_hex = excluded.ed25519_pubkey_hex;",
                params![dev_id.to_string(), hex_encode(pk)],
            )
            .map_err(sql_err)?;
        }

        for (event, compartment, opt_pack_id) in events {
            let hlc_be = event.header.hlc.to_be_bytes();
            let pack_id_hex = opt_pack_id.map(|id| id.to_hex());
            tx.execute(
                "INSERT INTO spine_events (
                    device_id, seq, agent_id, epoch, hlc_be, hlc_hex,
                    prev_blake3, payload_blake3, event_blake3, sig_hex, payload_utf8, compartment, pack_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                ON CONFLICT(device_id, seq) DO UPDATE SET
                    pack_id = COALESCE(spine_events.pack_id, excluded.pack_id);",
                params![
                    event.header.device_id.to_string(),
                    u64_to_i64(event.header.seq),
                    event.header.agent_id.to_string(),
                    u64_to_i64(event.header.epoch),
                    hlc_be.as_slice(),
                    event.header.hlc.to_hex(),
                    event.header.prev_blake3.to_hex(),
                    event.header.payload_blake3.to_hex(),
                    event.event_blake3.to_hex(),
                    &event.sig_hex,
                    &event.payload_utf8,
                    compartment.as_str(),
                    pack_id_hex,
                ],
            )
            .map_err(sql_err)?;
        }

        for (pack, json) in pack_jsons {
            tx.execute(
                "INSERT OR REPLACE INTO packfiles (
                    pack_id, compartment, epoch, device_id, first_seq, last_seq, pack_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
                params![
                    pack.pack_id.to_hex(),
                    pack.aad.compartment.as_str(),
                    u64_to_i64(pack.aad.epoch),
                    pack.aad.device_id.to_string(),
                    u64_to_i64(pack.aad.first_seq),
                    u64_to_i64(pack.aad.last_seq),
                    json,
                ],
            )
            .map_err(sql_err)?;
        }

        tx.commit().map_err(sql_err)?;
        Ok(())
    }

    fn put_packfile(&mut self, pack: &SealedPackfile) -> Result<()> {
        let json =
            serde_json::to_string(pack).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("序列化 SealedPackfile 失败: {e}"),
            })?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO packfiles (
                    pack_id, compartment, epoch, device_id, first_seq, last_seq, pack_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
                params![
                    pack.pack_id.to_hex(),
                    pack.aad.compartment.as_str(),
                    u64_to_i64(pack.aad.epoch),
                    pack.aad.device_id.to_string(),
                    u64_to_i64(pack.aad.first_seq),
                    u64_to_i64(pack.aad.last_seq),
                    json,
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn list_packfiles(&self) -> Result<Vec<SealedPackfile>> {
        let mut stmt = self
            .conn
            .prepare("SELECT pack_json FROM packfiles ORDER BY first_seq ASC, pack_id ASC;")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for item in rows {
            let raw = item.map_err(sql_err)?;
            let pack: SealedPackfile =
                serde_json::from_str(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                    detail: format!("反序列化 SealedPackfile 失败: {e}"),
                })?;
            out.push(pack);
        }
        Ok(out)
    }

    fn put_checkpoint(&mut self, checkpoint: &SpineCheckpoint) -> Result<()> {
        let json = serde_json::to_string(checkpoint).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化 SpineCheckpoint 失败: {e}"),
            }
        })?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO checkpoints (checkpoint_id, hlc_hex, checkpoint_json)
                 VALUES (?1, ?2, ?3);",
                params![
                    checkpoint.checkpoint_id.to_hex(),
                    checkpoint.hlc.to_hex(),
                    json
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn latest_checkpoint(&self) -> Result<Option<SpineCheckpoint>> {
        let opt_json: Option<String> = self
            .conn
            .query_row(
                "SELECT checkpoint_json FROM checkpoints ORDER BY idx DESC LIMIT 1;",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        opt_json
            .map(|raw| {
                serde_json::from_str(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                    detail: format!("反序列化 SpineCheckpoint 失败: {e}"),
                })
            })
            .transpose()
    }

    fn list_checkpoints(&self) -> Result<Vec<SpineCheckpoint>> {
        let mut stmt = self
            .conn
            .prepare("SELECT checkpoint_json FROM checkpoints ORDER BY idx ASC;")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for item in rows {
            let raw = item.map_err(sql_err)?;
            let cp: SpineCheckpoint =
                serde_json::from_str(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
                    detail: format!("反序列化 SpineCheckpoint 失败: {e}"),
                })?;
            out.push(cp);
        }
        Ok(out)
    }

    fn upsert_memory(&mut self, memory: &MaterializedMemory) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        tx.execute(
            "INSERT INTO memories (memory_id, category, authority, content, updated_hlc_hex)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(memory_id) DO UPDATE SET
                category = excluded.category,
                authority = excluded.authority,
                content = excluded.content,
                updated_hlc_hex = excluded.updated_hlc_hex;",
            params![
                &memory.memory_id,
                &memory.category,
                i64::from(memory.authority),
                &memory.content,
                memory.updated_hlc.to_hex(),
            ],
        )
        .map_err(sql_err)?;
        tx.execute(
            "DELETE FROM memories_fts WHERE memory_id = ?1;",
            params![&memory.memory_id],
        )
        .map_err(sql_err)?;
        tx.execute(
            "INSERT INTO memories_fts (memory_id, category, content) VALUES (?1, ?2, ?3);",
            params![&memory.memory_id, &memory.category, &memory.content],
        )
        .map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
        Ok(())
    }

    fn list_memories(&self) -> Result<Vec<MaterializedMemory>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT memory_id, category, authority, content, updated_hlc_hex
                 FROM memories ORDER BY memory_id ASC;",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u8>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for item in rows {
            let (memory_id, category, authority, content, hlc_hex) = item.map_err(sql_err)?;
            out.push(MaterializedMemory {
                memory_id,
                category,
                authority,
                content,
                updated_hlc: HlcTimestamp::from_hex(&hlc_hex)?,
            });
        }
        Ok(out)
    }

    fn delete_memory(&mut self, memory_id: &str) -> Result<()> {
        self.conn
            .pragma_update(None, "secure_delete", "ON")
            .map_err(sql_err)?;
        let tx = self.conn.transaction().map_err(sql_err)?;
        tx.execute(
            "DELETE FROM memories_fts WHERE memory_id = ?1;",
            params![memory_id],
        )
        .map_err(sql_err)?;
        tx.execute(
            "DELETE FROM memories WHERE memory_id = ?1;",
            params![memory_id],
        )
        .map_err(sql_err)?;
        tx.commit().map_err(sql_err)
    }

    fn search_memories_fts(&self, query: &str, limit: usize) -> Result<Vec<MaterializedMemory>> {
        let trimmed = query.trim();
        if trimmed.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let lim = u64_to_i64(limit as u64);
        let mut out = Vec::new();

        if trimmed.chars().count() >= 3 {
            let fts_q = escape_fts_phrase(trimmed);
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT m.memory_id, m.category, m.authority, m.content, m.updated_hlc_hex
                     FROM memories_fts f
                     JOIN memories m ON m.memory_id = f.memory_id
                     WHERE memories_fts MATCH ?1
                     ORDER BY rank
                     LIMIT ?2;",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![fts_q, lim], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, u8>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })
                .map_err(sql_err)?;
            for item in rows {
                let (memory_id, category, authority, content, hlc_hex) = item.map_err(sql_err)?;
                out.push(MaterializedMemory {
                    memory_id,
                    category,
                    authority,
                    content,
                    updated_hlc: HlcTimestamp::from_hex(&hlc_hex)?,
                });
            }
        } else {
            let like_pat = format!("%{trimmed}%");
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT memory_id, category, authority, content, updated_hlc_hex
                     FROM memories WHERE content LIKE ?1 ORDER BY memory_id ASC LIMIT ?2;",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![like_pat, lim], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, u8>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })
                .map_err(sql_err)?;
            for item in rows {
                let (memory_id, category, authority, content, hlc_hex) = item.map_err(sql_err)?;
                out.push(MaterializedMemory {
                    memory_id,
                    category,
                    authority,
                    content,
                    updated_hlc: HlcTimestamp::from_hex(&hlc_hex)?,
                });
            }
        }
        Ok(out)
    }

    fn upsert_thread(&mut self, thread: &MaterializedThread) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO threads (legacy_key, thread_id, title, channel, created_ms, updated_ms, archived)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(legacy_key) DO UPDATE SET
                    title = CASE WHEN excluded.updated_ms >= threads.updated_ms THEN excluded.title ELSE threads.title END,
                    channel = CASE WHEN excluded.updated_ms >= threads.updated_ms THEN excluded.channel ELSE threads.channel END,
                    created_ms = CASE
                        WHEN excluded.created_ms > 0 AND (threads.created_ms = 0 OR excluded.created_ms < threads.created_ms)
                        THEN excluded.created_ms
                        ELSE threads.created_ms
                    END,
                    archived = CASE WHEN excluded.updated_ms >= threads.updated_ms THEN excluded.archived ELSE threads.archived END,
                    updated_ms = MAX(threads.updated_ms, excluded.updated_ms);",
                params![
                    &thread.legacy_key,
                    thread.thread_id.to_string(),
                    &thread.title,
                    &thread.channel,
                    u64_to_i64(thread.created_ms),
                    u64_to_i64(thread.updated_ms),
                    i64::from(thread.archived),
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn list_threads(&self) -> Result<Vec<MaterializedThread>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT legacy_key, thread_id, title, channel, created_ms, updated_ms, archived
                 FROM threads ORDER BY created_ms ASC, legacy_key ASC;",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for item in rows {
            let (legacy_key, tid_str, title, channel, c_ms, u_ms, arch) = item.map_err(sql_err)?;
            out.push(MaterializedThread {
                thread_id: ThreadId::from_str(&tid_str)?,
                legacy_key,
                title,
                channel,
                created_ms: i64_to_u64(c_ms),
                updated_ms: i64_to_u64(u_ms),
                archived: arch != 0,
            });
        }
        Ok(out)
    }

    fn upsert_message(&mut self, message: &MaterializedMessage) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        tx.execute(
            "INSERT INTO messages (message_id, thread_key, role, channel, body_origin, content, ts_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(message_id) DO UPDATE SET
                content = excluded.content,
                ts_ms = excluded.ts_ms;",
            params![
                &message.message_id,
                &message.thread_key,
                &message.role,
                &message.channel,
                &message.body_origin,
                &message.content,
                u64_to_i64(message.ts_ms),
            ],
        )
        .map_err(sql_err)?;
        tx.execute(
            "DELETE FROM messages_fts WHERE message_id = ?1;",
            params![&message.message_id],
        )
        .map_err(sql_err)?;
        tx.execute(
            "INSERT INTO messages_fts (message_id, thread_key, role, content)
             VALUES (?1, ?2, ?3, ?4);",
            params![
                &message.message_id,
                &message.thread_key,
                &message.role,
                &message.content
            ],
        )
        .map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
        Ok(())
    }

    fn list_messages(&self, thread_key: Option<&str>) -> Result<Vec<MaterializedMessage>> {
        let mut out = Vec::new();
        if let Some(tk) = thread_key {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT message_id, thread_key, role, channel, body_origin, content, ts_ms
                     FROM messages WHERE thread_key = ?1 ORDER BY ts_ms ASC, message_id ASC;",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![tk], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                })
                .map_err(sql_err)?;
            for item in rows {
                let (message_id, thread_key, role, channel, body_origin, content, ts) =
                    item.map_err(sql_err)?;
                out.push(MaterializedMessage {
                    message_id,
                    thread_key,
                    role,
                    channel,
                    body_origin,
                    content,
                    ts_ms: i64_to_u64(ts),
                });
            }
        } else {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT message_id, thread_key, role, channel, body_origin, content, ts_ms
                     FROM messages ORDER BY ts_ms ASC, message_id ASC;",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                })
                .map_err(sql_err)?;
            for item in rows {
                let (message_id, thread_key, role, channel, body_origin, content, ts) =
                    item.map_err(sql_err)?;
                out.push(MaterializedMessage {
                    message_id,
                    thread_key,
                    role,
                    channel,
                    body_origin,
                    content,
                    ts_ms: i64_to_u64(ts),
                });
            }
        }
        Ok(out)
    }

    fn search_messages_fts(&self, query: &str, limit: usize) -> Result<Vec<MaterializedMessage>> {
        let trimmed = query.trim();
        if trimmed.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let lim = u64_to_i64(limit as u64);
        let mut out = Vec::new();
        if trimmed.chars().count() >= 3 {
            let fts_q = escape_fts_phrase(trimmed);
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT m.message_id, m.thread_key, m.role, m.channel, m.body_origin, m.content, m.ts_ms
                     FROM messages_fts f
                     JOIN messages m ON m.message_id = f.message_id
                     WHERE messages_fts MATCH ?1
                     ORDER BY rank
                     LIMIT ?2;",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![fts_q, lim], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                })
                .map_err(sql_err)?;
            for item in rows {
                let (message_id, thread_key, role, channel, body_origin, content, ts) =
                    item.map_err(sql_err)?;
                out.push(MaterializedMessage {
                    message_id,
                    thread_key,
                    role,
                    channel,
                    body_origin,
                    content,
                    ts_ms: i64_to_u64(ts),
                });
            }
        } else {
            let like_pat = format!("%{trimmed}%");
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT message_id, thread_key, role, channel, body_origin, content, ts_ms
                     FROM messages WHERE content LIKE ?1 ORDER BY ts_ms ASC LIMIT ?2;",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![like_pat, lim], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                })
                .map_err(sql_err)?;
            for item in rows {
                let (message_id, thread_key, role, channel, body_origin, content, ts) =
                    item.map_err(sql_err)?;
                out.push(MaterializedMessage {
                    message_id,
                    thread_key,
                    role,
                    channel,
                    body_origin,
                    content,
                    ts_ms: i64_to_u64(ts),
                });
            }
        }
        Ok(out)
    }

    fn upsert_run(&mut self, run: &MaterializedRun) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO runs (run_id, mode, status, title, detail, updated_hlc_hex)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(run_id) DO UPDATE SET
                    mode = excluded.mode,
                    status = excluded.status,
                    title = excluded.title,
                    detail = excluded.detail,
                    updated_hlc_hex = excluded.updated_hlc_hex;",
                params![
                    run.run_id.to_string(),
                    &run.mode,
                    &run.status,
                    &run.title,
                    &run.detail,
                    run.updated_hlc.to_hex(),
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn list_runs(&self) -> Result<Vec<MaterializedRun>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT run_id, mode, status, title, detail, updated_hlc_hex
                 FROM runs ORDER BY run_id ASC;",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for item in rows {
            let (rid, mode, status, title, detail, hlc_hex) = item.map_err(sql_err)?;
            out.push(MaterializedRun {
                run_id: RunId::from_str(&rid)?,
                mode,
                status,
                title,
                detail,
                updated_hlc: HlcTimestamp::from_hex(&hlc_hex)?,
            });
        }
        Ok(out)
    }

    fn upsert_markdown_doc(
        &mut self,
        rel_path: &str,
        content: &str,
        updated_hlc: HlcTimestamp,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO markdown_docs (rel_path, content, updated_hlc_hex)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(rel_path) DO UPDATE SET
                    content = excluded.content,
                    updated_hlc_hex = excluded.updated_hlc_hex;",
                params![rel_path, content, updated_hlc.to_hex()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn put_private_blob(&mut self, blob_key: &str, payload_json: &str) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO private_blobs (blob_key, payload_json, updated_hlc_hex)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(blob_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_hlc_hex = excluded.updated_hlc_hex;",
                params![
                    blob_key,
                    payload_json,
                    HlcTimestamp::from_parts(0, 0, 0).to_hex()
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn delete_private_blob(&mut self, blob_key: &str) -> Result<()> {
        self.conn
            .pragma_update(None, "secure_delete", "ON")
            .map_err(sql_err)?;
        self.conn
            .execute(
                "DELETE FROM private_blobs WHERE blob_key = ?1;",
                params![blob_key],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn get_private_blob(&self, blob_key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT payload_json FROM private_blobs WHERE blob_key = ?1;")
            .map_err(sql_err)?;
        let mut rows = stmt.query(params![blob_key]).map_err(sql_err)?;
        match rows.next().map_err(sql_err)? {
            Some(row) => Ok(Some(row.get::<_, String>(0).map_err(sql_err)?)),
            None => Ok(None),
        }
    }

    fn list_markdown_docs(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT rel_path, content FROM markdown_docs ORDER BY rel_path ASC;")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item.map_err(sql_err)?);
        }
        Ok(out)
    }

    fn has_v1_import_digest(&self, digest: &ArtifactId) -> Result<bool> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM v1_import_dedup WHERE digest_hex = ?1;",
                params![digest.to_hex()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        Ok(found.is_some())
    }

    fn record_v1_import_digest(
        &mut self,
        digest: &ArtifactId,
        source_kind: &str,
        source_key: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO v1_import_dedup (digest_hex, source_kind, source_key)
                 VALUES (?1, ?2, ?3);",
                params![digest.to_hex(), source_kind, source_key],
            )
            .map_err(sql_err)?;
        Ok(())
    }
}
