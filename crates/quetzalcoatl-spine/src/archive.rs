use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::str::FromStr;

use quetzalcoatl_crypto::{
    PackCompartment, SealedPackfile, hex_decode_fixed, hex_encode, open_packfile,
};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::SpineEngine;
use crate::ledger::{SpineCheckpoint, SpineEvent, parse_events_jsonl};
use crate::store::{
    MaterializedMemory, MaterializedMessage, MaterializedRun, MaterializedStore, MaterializedThread,
};

/// ZIP 导出配置选项（可读 Markdown 树 + 可选 `.quetzalcoatl-spine/` 签名加密备份包）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZipExportOptions {
    pub include_spine_packs: bool,
}

impl Default for ZipExportOptions {
    fn default() -> Self {
        Self {
            include_spine_packs: true,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct SpineArchiveManifest {
    version: u32,
    agent_id: AgentId,
    device_pubkeys: BTreeMap<String, String>,
    pack_files: Vec<String>,
    tail_events: Vec<(SpineEvent, PackCompartment)>,
    checkpoints: Vec<SpineCheckpoint>,
    memories: Vec<MaterializedMemory>,
    threads: Vec<MaterializedThread>,
    messages: Vec<MaterializedMessage>,
    runs: Vec<MaterializedRun>,
    markdown_docs: Vec<(String, String)>,
}

fn validate_safe_rel_path(rel_path: &str) -> Result<()> {
    if rel_path.is_empty()
        || rel_path.starts_with('/')
        || rel_path.contains('\\')
        || rel_path.split('/').any(|seg| seg == "..")
    {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: format!("拒绝不安全的归档相对路径: {rel_path}"),
        });
    }
    Ok(())
}

fn write_zip_entry<W: Write + std::io::Seek>(
    writer: &mut ZipWriter<W>,
    rel_path: &str,
    bytes: &[u8],
) -> Result<()> {
    validate_safe_rel_path(rel_path)?;
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file(rel_path, opts)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建 ZIP 条目 {rel_path} 失败: {e}"),
        })?;
    writer
        .write_all(bytes)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("写入 ZIP 条目 {rel_path} 失败: {e}"),
        })?;
    Ok(())
}

pub fn export_zip_archive<S: MaterializedStore>(
    engine: &SpineEngine<S>,
    zip_path: &Path,
    options: ZipExportOptions,
) -> Result<()> {
    if let Some(parent) = zip_path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建 ZIP 导出父目录失败: {e}"),
        })?;
    }

    let file = File::create(zip_path).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("创建 ZIP 归档文件失败: {e}"),
    })?;
    let mut writer = ZipWriter::new(file);

    let docs = engine.store().list_markdown_docs()?;
    let mut written_paths = BTreeSet::new();

    for (rel_path, content) in &docs {
        write_zip_entry(&mut writer, rel_path, content.as_bytes())?;
        written_paths.insert(rel_path.clone());
    }

    if !written_paths.contains("SOUL.md") {
        let default_soul = format!(
            "# Quetzalcoatl Agent\n\n- Agent ID: `{}`\n",
            engine.agent_id()
        );
        write_zip_entry(&mut writer, "SOUL.md", default_soul.as_bytes())?;
        written_paths.insert(String::from("SOUL.md"));
    }

    if !written_paths.iter().any(|p| p.starts_with("conscience/")) {
        write_zip_entry(
            &mut writer,
            "conscience/README.md",
            b"# Conscience\n\nExported sovereign conscience anchor.\n",
        )?;
        written_paths.insert(String::from("conscience/README.md"));
    }

    let memories = engine.store().list_memories()?;
    if !written_paths.contains("memories/MEMORY.md") {
        let general_mems: Vec<&str> = memories
            .iter()
            .filter(|m| m.category != "user_pref")
            .map(|m| m.content.as_str())
            .collect();
        let mem_body = general_mems.join("\n§\n");
        write_zip_entry(&mut writer, "memories/MEMORY.md", mem_body.as_bytes())?;
        written_paths.insert(String::from("memories/MEMORY.md"));
    }
    if !written_paths.contains("memories/USER.md") {
        let user_mems: Vec<&str> = memories
            .iter()
            .filter(|m| m.category == "user_pref")
            .map(|m| m.content.as_str())
            .collect();
        let user_body = user_mems.join("\n§\n");
        write_zip_entry(&mut writer, "memories/USER.md", user_body.as_bytes())?;
        written_paths.insert(String::from("memories/USER.md"));
    }

    if !written_paths.iter().any(|p| p.starts_with("skills/")) {
        write_zip_entry(
            &mut writer,
            "skills/README.md",
            b"# Skills\n\nNo custom skills exported.\n",
        )?;
    }

    if options.include_spine_packs {
        let packs = engine.store().list_packfiles()?;
        let mut pack_entry_names = Vec::with_capacity(packs.len());

        for pack in &packs {
            let entry_name = format!(".quetzalcoatl-spine/packs/{}.qzp", pack.pack_id.to_hex());
            let pack_bytes = serde_json::to_vec_pretty(pack).map_err(|e| {
                QuetzalcoatlError::SerializationError {
                    detail: format!("序列化 Packfile 归档条目失败: {e}"),
                }
            })?;
            write_zip_entry(&mut writer, &entry_name, &pack_bytes)?;
            pack_entry_names.push(entry_name);
        }

        let tail_events = engine.store().list_all_unpacked_events()?;

        let mut device_pubkeys = BTreeMap::new();
        for (dev_id, pk) in engine.store().list_device_pubkeys()? {
            device_pubkeys.insert(dev_id.to_string(), hex_encode(&pk));
        }
        device_pubkeys.insert(
            engine.local_device().device_id().to_string(),
            hex_encode(engine.local_device().ed25519_public_key()),
        );

        let manifest = SpineArchiveManifest {
            version: 2,
            agent_id: engine.agent_id(),
            device_pubkeys,
            pack_files: pack_entry_names,
            tail_events,
            checkpoints: engine.store().list_checkpoints()?,
            memories,
            threads: engine.store().list_threads()?,
            messages: engine.store().list_messages(None)?,
            runs: engine.store().list_runs()?,
            markdown_docs: docs,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化归档 manifest.json 失败: {e}"),
            }
        })?;
        write_zip_entry(
            &mut writer,
            ".quetzalcoatl-spine/manifest.json",
            &manifest_bytes,
        )?;
    }

    writer
        .finish()
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("收尾写入 ZIP 归档失败: {e}"),
        })?;
    Ok(())
}

pub fn import_zip_archive<S: MaterializedStore>(
    engine: &mut SpineEngine<S>,
    zip_path: &Path,
    local_trusted_wall_ms: u64,
) -> Result<usize> {
    let file = File::open(zip_path).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("打开待导入 ZIP 归档失败: {e}"),
    })?;
    let mut archive = ZipArchive::new(file).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("解析 ZIP 归档结构失败: {e}"),
    })?;

    let mut entries = BTreeMap::<String, Vec<u8>>::new();
    for idx in 0..archive.len() {
        let mut zf = archive
            .by_index(idx)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 ZIP 第 {idx} 项失败: {e}"),
            })?;
        if zf.is_dir() {
            continue;
        }
        let name = zf
            .name()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("解码 ZIP 文件名 UTF-8 失败: {e}"),
            })?
            .into_owned();
        validate_safe_rel_path(&name)?;
        let mut buf = Vec::new();
        zf.read_to_end(&mut buf)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 ZIP 条目 {name} 内容失败: {e}"),
            })?;
        entries.insert(name, buf);
    }

    if let Some(manifest_raw) = entries.get(".quetzalcoatl-spine/manifest.json") {
        let manifest: SpineArchiveManifest = serde_json::from_slice(manifest_raw).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析 .quetzalcoatl-spine/manifest.json 失败: {e}"),
            }
        })?;
        if manifest.agent_id != engine.agent_id() {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "归档包 AgentId ({}) 与目标脊柱 AgentId ({}) 不一致",
                    manifest.agent_id,
                    engine.agent_id()
                ),
            });
        }

        let mut pubkeys = BTreeMap::<DeviceId, [u8; 32]>::new();
        for (dev_s, pk_hex) in &manifest.device_pubkeys {
            let dev_id = DeviceId::from_str(dev_s)?;
            let pk = hex_decode_fixed::<32>("manifest.device_pubkeys", pk_hex)?;
            engine.store_mut().register_device_pubkey(dev_id, &pk)?;
            pubkeys.insert(dev_id, pk);
        }

        let mut imported_events = 0usize;

        for pack_entry in &manifest.pack_files {
            let pack_raw =
                entries
                    .get(pack_entry)
                    .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                        detail: format!("manifest 引用的 Packfile 缺失: {pack_entry}"),
                    })?;
            let pack: SealedPackfile = serde_json::from_slice(pack_raw).map_err(|e| {
                QuetzalcoatlError::SerializationError {
                    detail: format!("反序列化归档 Packfile {pack_entry} 失败: {e}"),
                }
            })?;
            let epoch = Epoch::new(pack.aad.epoch);
            let epoch_key = engine
                .epoch_ring()
                .epoch_key(epoch)
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: format!("缺少解封归档 Packfile 所需的 EpochKey[{epoch}]"),
                })?
                .clone();
            let sender_pk = pubkeys.get(&pack.aad.device_id).ok_or_else(|| {
                QuetzalcoatlError::IntegrityViolation {
                    detail: format!("manifest 缺少设备 {} 的签名公钥", pack.aad.device_id),
                }
            })?;

            // 验证并解密 Packfile，支持同一设备跨 Core/ExternalChannel 分舱交叉序号收集后统一排序验链
            let plain_jsonl = open_packfile(&pack, &epoch_key)?;
            let jsonl_str = std::str::from_utf8(&plain_jsonl).map_err(|e| {
                QuetzalcoatlError::SerializationError {
                    detail: format!("Packfile 解压后不是合法 UTF-8 JSONL: {e}"),
                }
            })?;
            let decoded_events = parse_events_jsonl(jsonl_str)?;
            for ev in &decoded_events {
                ev.header.hlc.validate_drift(local_trusted_wall_ms)?;
                ev.verify(sender_pk)?;
            }
            engine.store_mut().put_packfile(&pack)?;
        }

        // 收集所有 Packfile 内事件与尾部未封包事件，按每台设备 (device_id, seq) 连续校验签名哈希链后写入
        let mut events_by_device =
            BTreeMap::<DeviceId, BTreeMap<u64, (SpineEvent, PackCompartment)>>::new();
        for pack_entry in &manifest.pack_files {
            if let Some(pack_raw) = entries.get(pack_entry) {
                let pack: SealedPackfile = serde_json::from_slice(pack_raw).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: format!("二次读取 Packfile 失败: {e}"),
                    }
                })?;
                let epoch_key = engine
                    .epoch_ring()
                    .epoch_key(Epoch::new(pack.aad.epoch))
                    .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                        detail: String::from("缺少归档纪元密钥"),
                    })?;
                let plain = open_packfile(&pack, epoch_key)?;
                let jsonl_s = std::str::from_utf8(&plain).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: format!("UTF-8 错误: {e}"),
                    }
                })?;
                for ev in parse_events_jsonl(jsonl_s)? {
                    events_by_device
                        .entry(ev.header.device_id)
                        .or_default()
                        .insert(ev.header.seq, (ev, pack.aad.compartment));
                }
            }
        }
        for (ev, comp) in manifest.tail_events {
            let sender_pk = pubkeys.get(&ev.header.device_id).ok_or_else(|| {
                QuetzalcoatlError::IntegrityViolation {
                    detail: format!("尾部事件缺少设备 {} 的签名公钥", ev.header.device_id),
                }
            })?;
            ev.header.hlc.validate_drift(local_trusted_wall_ms)?;
            ev.verify(sender_pk)?;
            events_by_device
                .entry(ev.header.device_id)
                .or_default()
                .insert(ev.header.seq, (ev, comp));
        }

        for (_dev_id, seq_map) in events_by_device {
            let mut ordered: Vec<(SpineEvent, PackCompartment)> = seq_map.into_values().collect();
            ordered.sort_by_key(|(e, _)| e.header.seq);
            for (ev, comp) in ordered {
                let pk = pubkeys.get(&ev.header.device_id).ok_or_else(|| {
                    QuetzalcoatlError::IntegrityViolation {
                        detail: String::from("缺少设备公钥"),
                    }
                })?;
                engine.ingest_remote_event(ev, comp, pk, local_trusted_wall_ms)?;
                imported_events += 1;
            }
        }

        for cp in &manifest.checkpoints {
            engine.store_mut().put_checkpoint(cp)?;
        }
        for mem in &manifest.memories {
            engine.store_mut().upsert_memory(mem)?;
        }
        for th in &manifest.threads {
            engine.store_mut().upsert_thread(th)?;
        }
        for msg in &manifest.messages {
            engine.store_mut().upsert_message(msg)?;
        }
        for run in &manifest.runs {
            engine.store_mut().upsert_run(run)?;
        }
        let hlc_now = engine.local_hlc();
        for (rel_path, content) in &manifest.markdown_docs {
            engine
                .store_mut()
                .upsert_markdown_doc(rel_path, content, hlc_now)?;
        }

        return Ok(imported_events);
    }

    // 纯可读 Markdown ZIP 导入模式（解析 memories/*.md 段落并生成签名脊柱事件）
    let mut imported = 0usize;
    for (name, bytes) in entries {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            if name == "memories/MEMORY.md" || name == "memories/USER.md" {
                let (category, authority) = if name == "memories/USER.md" {
                    ("user_pref", 40u8)
                } else {
                    ("memory", 30u8)
                };
                for seg in text
                    .replace("\r\n", "\n")
                    .split("\n§\n")
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let ev_json = serde_json::json!({
                        "kind": "memory.zip_import",
                        "category": category,
                        "authority": authority,
                        "content": seg,
                    });
                    let ev_str = serde_json::to_string(&ev_json).map_err(|e| {
                        QuetzalcoatlError::SerializationError {
                            detail: format!("序列化 Markdown 归档记忆失败: {e}"),
                        }
                    })?;
                    let ev = engine.append_event(
                        PackCompartment::Core,
                        &ev_str,
                        local_trusted_wall_ms,
                    )?;
                    engine.store_mut().upsert_memory(&MaterializedMemory {
                        memory_id: format!("zip-mem-{}", &ev.event_blake3.to_hex()[0..16]),
                        category: String::from(category),
                        authority,
                        content: seg.to_owned(),
                        updated_hlc: ev.header.hlc,
                    })?;
                    imported += 1;
                }
            } else {
                let ev_json = serde_json::json!({
                    "kind": "doc.zip_import",
                    "path": name,
                });
                let ev_str = serde_json::to_string(&ev_json).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: format!("序列化 Markdown 归档文档失败: {e}"),
                    }
                })?;
                let ev =
                    engine.append_event(PackCompartment::Core, &ev_str, local_trusted_wall_ms)?;
                engine
                    .store_mut()
                    .upsert_markdown_doc(&name, text, ev.header.hlc)?;
                imported += 1;
            }
        }
    }
    Ok(imported)
}
