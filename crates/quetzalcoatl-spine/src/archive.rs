use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use quetzalcoatl_crypto::{
    AccountRootKey, EpochKey, MemberOperation, PackCompartment, SealedManifestEnvelope,
    SealedPackfile, SignedMembershipChange, open_manifest_envelope, seal_manifest_envelope,
};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::SpineEngine;
use crate::ledger::{SpineCheckpoint, SpineEvent};
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

/// 密封在 `SealedManifestEnvelope` 密文内部的敏感脊柱清单负载（绝不以明文写入 `.quetzalcoatl-spine/manifest.json`）。
#[derive(Serialize, Deserialize)]
struct SpineArchiveManifestPayload {
    version: u32,
    agent_id: AgentId,
    membership_changes: Vec<SignedMembershipChange>,
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
        || rel_path.contains('\0')
        || rel_path
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
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
    export_zip_archive_with(engine, zip_path, options, &[])
}

/// 导出时另外放进几份文件（例如由良知整理出的可读文档、口令封存的恢复包）。
/// 路径与已有文件重名时，以这里给的为准。
pub fn export_zip_archive_with<S: MaterializedStore>(
    engine: &SpineEngine<S>,
    zip_path: &Path,
    options: ZipExportOptions,
    extra_files: &[(String, Vec<u8>)],
) -> Result<()> {
    for (rel_path, _) in extra_files {
        validate_safe_rel_path(rel_path)?;
    }
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

    for (rel_path, bytes) in extra_files {
        write_zip_entry(&mut writer, rel_path, bytes)?;
        written_paths.insert(rel_path.clone());
    }
    for (rel_path, content) in &docs {
        if written_paths.contains(rel_path) {
            continue;
        }
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
        let current_epoch = engine.epoch_ring().current_epoch();
        let current_epoch_key = engine.epoch_ring().current_epoch_key().ok_or_else(|| {
            QuetzalcoatlError::PermissionDenied {
                detail: String::from("导出加密归档需要当前活跃纪元密钥 EpochKey"),
            }
        })?;

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
        let payload = SpineArchiveManifestPayload {
            version: 2,
            agent_id: engine.agent_id(),
            membership_changes: engine.epoch_ring().membership_log().to_vec(),
            pack_files: pack_entry_names,
            tail_events,
            checkpoints: engine.store().list_checkpoints()?,
            memories,
            threads: engine.store().list_threads()?,
            messages: engine.store().list_messages(None)?,
            runs: engine.store().list_runs()?,
            markdown_docs: docs,
        };
        let payload_json =
            serde_json::to_vec(&payload).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("序列化归档清单明文失败: {e}"),
            })?;
        let sealed_envelope = seal_manifest_envelope(
            engine.agent_id(),
            current_epoch,
            current_epoch_key,
            &payload_json,
        )?;
        let envelope_bytes = serde_json::to_vec_pretty(&sealed_envelope).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化归档加密信封 manifest.json 失败: {e}"),
            }
        })?;
        write_zip_entry(
            &mut writer,
            ".quetzalcoatl-spine/manifest.json",
            &envelope_bytes,
        )?;
    }

    writer
        .finish()
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("收尾写入 ZIP 归档失败: {e}"),
        })?;
    Ok(())
}

/// 读出归档里的一个文件；没有这个文件时返回 `None`。
pub fn read_archive_entry(zip_path: &Path, name: &str) -> Result<Option<Vec<u8>>> {
    let file = File::open(zip_path).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("打开 ZIP 归档失败: {e}"),
    })?;
    let mut archive = ZipArchive::new(file).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("解析 ZIP 归档结构失败: {e}"),
    })?;
    let Ok(mut entry) = archive.by_name(name) else {
        return Ok(None);
    };
    let mut buf = Vec::new();
    entry
        .read_to_end(&mut buf)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取 ZIP 条目 {name} 失败: {e}"),
        })?;
    Ok(Some(buf))
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
        let envelope: SealedManifestEnvelope =
            serde_json::from_slice(manifest_raw).map_err(|e| {
                QuetzalcoatlError::IntegrityViolation {
                    detail: format!(
                        "归档 .quetzalcoatl-spine/manifest.json 不是合法的加密信封: {e}"
                    ),
                }
            })?;
        let manifest_epoch = Epoch::new(envelope.epoch);
        let manifest_key = engine
            .epoch_ring()
            .epoch_key(manifest_epoch)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!("缺少解密归档 manifest 所需的 EpochKey[{manifest_epoch}]"),
            })?
            .clone();

        let plain_manifest = open_manifest_envelope(engine.agent_id(), &envelope, &manifest_key)?;
        let manifest: SpineArchiveManifestPayload = serde_json::from_slice(&plain_manifest)
            .map_err(|e| QuetzalcoatlError::IntegrityViolation {
                detail: format!("解密后的归档清单 JSON 结构损坏: {e}"),
            })?;

        if manifest.version != 2 || manifest.agent_id != engine.agent_id() {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("解密后的归档清单 AgentId 或版本不匹配"),
            });
        }

        // 严格凭 AccountRootKey 根签名校验所有成员设备公钥（严禁采信未签名设备公钥表！）
        let root_vk = *engine.epoch_ring().root_verifying_key();
        let mut verified_pubkeys = BTreeMap::<DeviceId, [u8; 32]>::new();
        for (&dev_id, dev_rec) in engine.epoch_ring().active_devices() {
            verified_pubkeys.insert(dev_id, dev_rec.ed25519_pubkey);
        }
        for change in &manifest.membership_changes {
            if change.agent_id != engine.agent_id() {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("归档成员变更记录的 AgentId 与当前脊柱不一致"),
                });
            }
            AccountRootKey::verify_membership_change(&root_vk, change)?;
            if change.op == MemberOperation::AddDevice {
                verified_pubkeys.insert(change.device_id, change.ed25519_pubkey);
            }
        }

        // 校验全部 markdown_docs 相对路径安全性
        for (rel_path, _) in &manifest.markdown_docs {
            validate_safe_rel_path(rel_path)?;
        }

        let mut decoded_packs =
            Vec::<(SealedPackfile, EpochKey, [u8; 32])>::with_capacity(manifest.pack_files.len());
        for pack_entry in &manifest.pack_files {
            validate_safe_rel_path(pack_entry)?;
            let pack_raw =
                entries
                    .get(pack_entry)
                    .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                        detail: format!("归档清单引用的 Packfile 缺失: {pack_entry}"),
                    })?;
            let pack: SealedPackfile = serde_json::from_slice(pack_raw).map_err(|e| {
                QuetzalcoatlError::IntegrityViolation {
                    detail: format!("反序列化归档 Packfile {pack_entry} 失败: {e}"),
                }
            })?;
            let ep = Epoch::new(pack.aad.epoch);
            let ep_key = engine
                .epoch_ring()
                .epoch_key(ep)
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: format!("缺少解封归档 Packfile 所需的 EpochKey[{ep}]"),
                })?
                .clone();
            let sender_pk = *verified_pubkeys.get(&pack.aad.device_id).ok_or_else(|| {
                QuetzalcoatlError::IntegrityViolation {
                    detail: format!(
                        "归档 Packfile 设备 {} 未通过 AccountRootKey 根签名授权核验",
                        pack.aad.device_id
                    ),
                }
            })?;
            decoded_packs.push((pack, ep_key, sender_pk));
        }

        let mut tail_with_keys = Vec::<(SpineEvent, PackCompartment, [u8; 32])>::with_capacity(
            manifest.tail_events.len(),
        );
        for (ev, comp) in manifest.tail_events {
            let sender_pk = *verified_pubkeys.get(&ev.header.device_id).ok_or_else(|| {
                QuetzalcoatlError::IntegrityViolation {
                    detail: format!(
                        "归档尾部事件设备 {} 未通过 AccountRootKey 根签名授权核验",
                        ev.header.device_id
                    ),
                }
            })?;
            tail_with_keys.push((ev, comp, sender_pk));
        }

        let pack_refs: Vec<(&SealedPackfile, &EpochKey, &[u8; 32])> =
            decoded_packs.iter().map(|(p, k, pk)| (p, k, pk)).collect();
        let imported_events =
            engine.ingest_verified_batch(&pack_refs, &tail_with_keys, local_trusted_wall_ms)?;

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

        return Ok(imported_events.len());
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
