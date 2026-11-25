use std::error::Error;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, EpochKeyRing, PackCompartment, hex_decode_fixed, open_packfile,
};
use quetzalcoatl_spine::{
    MaterializedMemory, MaterializedMessage, MaterializedRun, MaterializedStore,
    MaterializedThread, RusqliteWalStore, SpineEngine, SpineEvent, ZipExportOptions,
    encode_events_jsonl,
};
use quetzalcoatl_types::{
    AgentId, ArtifactId, DeviceId, Epoch, ErrorCode, HlcTimestamp, RunId, ThreadId,
};
use zip::ZipArchive;

type TestResult = Result<(), Box<dyn Error>>;

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("无法定位仓库根目录")?;
    Ok(root.to_path_buf())
}

fn temp_test_dir(tag: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "qz_spine_test_{}_{}_{}",
        tag,
        std::process::id(),
        UuidCounter::next()
    ));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

struct UuidCounter;
impl UuidCounter {
    fn next() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CNT: AtomicU64 = AtomicU64::new(1);
        CNT.fetch_add(1, Ordering::Relaxed)
    }
}

#[test]
fn spine_event_chain_matches_spec_vector_byte_for_byte() -> TestResult {
    let root = repo_root()?;
    let vec_json: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        root.join("spec/vectors/spine_pack_aad.json"),
    )?)?;

    let id_v = &vec_json["identity"];
    let agent_id = AgentId::from_str(id_v["agent_id"].as_str().ok_or("agent_id")?)?;
    let device_id = DeviceId::from_str(id_v["device_id"].as_str().ok_or("device_id")?)?;
    let ed_seed = hex_decode_fixed::<32>(
        "device_ed25519_seed",
        id_v["device_ed25519_seed_hex"].as_str().ok_or("ed_seed")?,
    )?;
    let dev = DeviceIdentity::from_seeds(device_id, ed_seed, [0x33u8; 32])?;
    assert_eq!(
        quetzalcoatl_crypto::hex_encode(dev.ed25519_public_key()),
        id_v["device_ed25519_pubkey_hex"].as_str().ok_or("ed_pub")?
    );

    let evs = vec_json["events"].as_array().ok_or("events")?;
    let hlc1 = HlcTimestamp::from_hex(evs[0]["hlc_u128_hex"].as_str().ok_or("hlc0")?)?;
    let payload1 = evs[0]["payload_utf8"].as_str().ok_or("p0")?;
    let ev1 = SpineEvent::sign_new(
        agent_id,
        &dev,
        Epoch::new(1),
        1,
        ArtifactId::ZERO,
        hlc1,
        payload1,
    )?;

    assert_eq!(
        ev1.header.to_canonical_json(),
        evs[0]["canonical_header_utf8"].as_str().ok_or("ch0")?
    );
    assert_eq!(
        ev1.header.payload_blake3.to_hex(),
        evs[0]["payload_blake3_hex"].as_str().ok_or("pb0")?
    );
    assert_eq!(
        ev1.event_blake3.to_hex(),
        evs[0]["event_blake3_hex"].as_str().ok_or("eb0")?
    );
    assert_eq!(ev1.sig_hex, evs[0]["ed25519_sig_hex"].as_str().ok_or("s0")?);
    ev1.verify(dev.ed25519_public_key())?;

    let hlc2 = HlcTimestamp::from_hex(evs[1]["hlc_u128_hex"].as_str().ok_or("hlc1")?)?;
    let payload2 = evs[1]["payload_utf8"].as_str().ok_or("p1")?;
    let ev2 = SpineEvent::sign_new(
        agent_id,
        &dev,
        Epoch::new(1),
        2,
        ev1.event_blake3,
        hlc2,
        payload2,
    )?;
    assert_eq!(
        ev2.header.to_canonical_json(),
        evs[1]["canonical_header_utf8"].as_str().ok_or("ch1")?
    );
    assert_eq!(
        ev2.event_blake3.to_hex(),
        evs[1]["event_blake3_hex"].as_str().ok_or("eb1")?
    );
    assert_eq!(ev2.sig_hex, evs[1]["ed25519_sig_hex"].as_str().ok_or("s1")?);
    ev2.verify(dev.ed25519_public_key())?;

    let jsonl = encode_events_jsonl(&[ev1, ev2])?;
    assert_eq!(
        jsonl,
        vec_json["packfile"]["uncompressed_jsonl_utf8"]
            .as_str()
            .ok_or("jsonl")?
    );

    Ok(())
}

#[test]
fn tampering_pack_ciphertext_dek_or_aad_returns_integrity_violation() -> TestResult {
    let dir = temp_test_dir("tamper")?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let dev_a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let dev_b = DeviceIdentity::generate(DeviceId::new_v4())?;
    let mut ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev_a.public_record())?;
    ring.add_device(&root_key, dev_b.public_record())?;

    let store_a = RusqliteWalStore::open(&dir.join("a.sqlite"))?;
    let mut engine_a = SpineEngine::new(
        agent_id,
        dev_a.clone(),
        ring.clone(),
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev_a.device_id().hlc_node_tag()),
        store_a,
    )?;

    engine_a.append_event(
        PackCompartment::Core,
        "{\"kind\":\"memory.observe\",\"authority\":30,\"summary\":\"防篡改测试事件\"}",
        1_795_400_000_100,
    )?;
    let packs = engine_a.seal_checkpoint(None, 1_795_400_000_200)?;
    assert_eq!(packs.len(), 1);
    let pack = &packs[0];
    let epoch_key = ring.current_epoch_key().ok_or("缺少当前纪元密钥")?.clone();

    // 1. 篡改密文任意字节 -> IntegrityViolation
    let mut bad_ct = pack.clone();
    bad_ct.ciphertext[0] ^= 0x01;
    assert_eq!(
        open_packfile(&bad_ct, &epoch_key)
            .err()
            .ok_or("密文篡改未报错")?
            .code(),
        ErrorCode::IntegrityViolation
    );

    // 2. 篡改 AAD 任意字节 -> IntegrityViolation
    let mut bad_aad = pack.clone();
    bad_aad.aad_utf8 = bad_aad.aad_utf8.replace("\"v\":2", "\"v\":3");
    assert_eq!(
        open_packfile(&bad_aad, &epoch_key)
            .err()
            .ok_or("AAD 篡改未报错")?
            .code(),
        ErrorCode::IntegrityViolation
    );

    // 3. 远端 SpineEngine 合入篡改 Packfile 同样报错且不落库
    let store_b = RusqliteWalStore::open(&dir.join("b.sqlite"))?;
    let mut engine_b = SpineEngine::new(
        agent_id,
        dev_b.clone(),
        ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev_b.device_id().hlc_node_tag()),
        store_b,
    )?;
    let err_ingest = engine_b
        .ingest_remote_packfile(
            &bad_ct,
            &epoch_key,
            dev_a.ed25519_public_key(),
            1_795_400_000_300,
        )
        .err()
        .ok_or("合入篡改 Packfile 必须报错")?;
    assert_eq!(err_ingest.code(), ErrorCode::IntegrityViolation);
    assert!(engine_b.store().list_all_events()?.is_empty());

    fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn future_10m_hlc_event_is_rejected_without_advancing_local_hlc() -> TestResult {
    let dir = temp_test_dir("drift")?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let local_dev = DeviceIdentity::generate(DeviceId::new_v4())?;
    let remote_dev = DeviceIdentity::generate(DeviceId::new_v4())?;

    let mut ring = EpochKeyRing::new_genesis(agent_id, &root_key, local_dev.public_record())?;
    ring.add_device(&root_key, remote_dev.public_record())?;

    let local_now_ms: u64 = 1_795_400_000_000;
    let initial_hlc =
        HlcTimestamp::from_parts(local_now_ms, 3, local_dev.device_id().hlc_node_tag());
    let store = RusqliteWalStore::open(&dir.join("spine.sqlite"))?;
    let mut engine = SpineEngine::new(agent_id, local_dev, ring, initial_hlc, store)?;

    // 构造 +10m (600_000 ms > 300_000 ms) 未来偏置时钟签名事件（防坑规范 #10）
    let poisoned_hlc = HlcTimestamp::from_parts(
        local_now_ms + 10 * 60 * 1_000,
        0,
        remote_dev.device_id().hlc_node_tag(),
    );
    let poisoned_ev = SpineEvent::sign_new(
        agent_id,
        &remote_dev,
        Epoch::new(1),
        1,
        ArtifactId::ZERO,
        poisoned_hlc,
        "{\"kind\":\"memory.observe\",\"summary\":\"未来时钟投毒尝试\"}",
    )?;

    let err = engine
        .ingest_remote_event(
            poisoned_ev,
            PackCompartment::Core,
            remote_dev.ed25519_public_key(),
            local_now_ms,
        )
        .err()
        .ok_or("+10m 未来 HLC 事件必须被拒收")?;
    assert_eq!(err.code(), ErrorCode::ClockDriftExceeded);
    // 关键断言：本机 HLC 绝不能被推高，数据库也绝不能落盘该事件！
    assert_eq!(engine.local_hlc(), initial_hlc);
    assert!(
        engine
            .store()
            .list_device_events(remote_dev.device_id())?
            .is_empty()
    );

    fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn compartment_isolation_auto_pack_500_wal_fts5_and_zip_roundtrip() -> TestResult {
    let dir = temp_test_dir("roundtrip")?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let dev = DeviceIdentity::generate(DeviceId::new_v4())?;
    let ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev.public_record())?;

    let store = RusqliteWalStore::open(&dir.join("spine.sqlite"))?;
    assert_eq!(store.journal_mode()?.to_lowercase(), "wal");

    let mut engine = SpineEngine::new(
        agent_id,
        dev.clone(),
        ring.clone(),
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev.device_id().hlc_node_tag()),
        store,
    )?;

    // 验证满 500 条事件自动打包 + Core / ExternalChannel 分舱打包（防坑规范 #9）
    for i in 0..500 {
        engine.append_event(
            PackCompartment::Core,
            &format!("{{\"kind\":\"trace.step\",\"idx\":{i}}}"),
            1_795_400_000_000 + i,
        )?;
    }
    assert_eq!(engine.store().list_packfiles()?.len(), 1);
    assert_eq!(
        engine.store().list_packfiles()?[0].aad.compartment,
        PackCompartment::Core
    );

    engine.append_event(
        PackCompartment::Core,
        "{\"kind\":\"conscience.update\",\"authority\":50}",
        1_795_400_001_000,
    )?;
    engine.append_event(
        PackCompartment::ExternalChannel,
        "{\"kind\":\"channel.inbound\",\"channel\":\"feishu\",\"text\":\"不可信外部入站消息\"}",
        1_795_400_001_001,
    )?;
    let run_id = RunId::new_v4();
    let checkpoint_packs = engine.seal_checkpoint(Some(run_id), 1_795_400_001_100)?;
    assert_eq!(checkpoint_packs.len(), 2);
    assert!(
        checkpoint_packs
            .iter()
            .any(|p| p.aad.compartment == PackCompartment::Core)
    );
    assert!(
        checkpoint_packs
            .iter()
            .any(|p| p.aad.compartment == PackCompartment::ExternalChannel)
    );
    assert!(engine.store().latest_checkpoint()?.is_some());

    // 物化表与 FTS5 检索测试
    let hlc_now = engine.local_hlc();
    engine.store_mut().upsert_memory(&MaterializedMemory {
        memory_id: String::from("mem-001"),
        category: String::from("memory"),
        authority: 30,
        content: String::from("羽蛇神单写者脊柱采用 zstd 1MiB 窗口压缩与分桶填充"),
        updated_hlc: hlc_now,
    })?;
    let fts_mems = engine.store().search_memories_fts("分桶填充", 10)?;
    assert_eq!(fts_mems.len(), 1);
    assert_eq!(fts_mems[0].memory_id, "mem-001");

    let th_id = ThreadId::new_v4();
    engine.store_mut().upsert_thread(&MaterializedThread {
        thread_id: th_id,
        legacy_key: String::from("th-main"),
        title: String::from("架构回归会话"),
        channel: String::from("local"),
        created_ms: 1_795_400_000_000,
        updated_ms: 1_795_400_001_000,
        archived: false,
    })?;
    engine.store_mut().upsert_message(&MaterializedMessage {
        message_id: String::from("msg-001"),
        thread_key: String::from("th-main"),
        role: String::from("user"),
        channel: String::from("local"),
        body_origin: String::from("desktop"),
        content: String::from("请验证洁净室客观校验器防奖励作弊机制"),
        ts_ms: 1_795_400_001_050,
    })?;
    let fts_msgs = engine.store().search_messages_fts("洁净室客观校验器", 10)?;
    assert_eq!(fts_msgs.len(), 1);
    assert_eq!(fts_msgs[0].message_id, "msg-001");

    engine.store_mut().upsert_run(&MaterializedRun {
        run_id,
        mode: String::from("commit"),
        status: String::from("verified"),
        title: String::from("Task 1.2 校验"),
        detail: String::from("通过全部测试向量"),
        updated_hlc: hlc_now,
    })?;

    engine
        .store_mut()
        .upsert_markdown_doc("SOUL.md", "# 羽蛇\n\n忠于内在价值坐标。\n", hlc_now)?;
    engine.store_mut().upsert_markdown_doc(
        "conscience/SELF_CORE.md",
        "# 核心价值\n\n诚实、审慎、可验证。\n",
        hlc_now,
    )?;
    engine.store_mut().upsert_markdown_doc(
        "skills/hello-tool/SKILL.md",
        "# hello-tool\n\n合成技能说明。\n",
        hlc_now,
    )?;

    // 双模 ZIP 导出与无损导入往返
    let zip_path = dir.join("export_bundle.zip");
    engine.export_zip(
        &zip_path,
        ZipExportOptions {
            include_spine_packs: true,
        },
    )?;
    assert!(zip_path.is_file());

    {
        let zf = File::open(&zip_path)?;
        let mut archive = ZipArchive::new(zf)?;
        let mut names = Vec::new();
        for idx in 0..archive.len() {
            names.push(archive.by_index(idx)?.name()?.into_owned());
        }
        assert!(names.iter().any(|n| n == "SOUL.md"));
        assert!(names.iter().any(|n| n.starts_with("conscience/")));
        assert!(names.iter().any(|n| n.starts_with("memories/")));
        assert!(names.iter().any(|n| n.starts_with("skills/")));
        assert!(
            names
                .iter()
                .any(|n| n == ".quetzalcoatl-spine/manifest.json")
        );
        assert!(
            names
                .iter()
                .any(|n| n.starts_with(".quetzalcoatl-spine/packs/"))
        );
    }

    let dev2 = DeviceIdentity::generate(DeviceId::new_v4())?;
    let mut ring2 = ring;
    ring2.add_device(&root_key, dev2.public_record())?;
    let store2 = RusqliteWalStore::open(&dir.join("restored.sqlite"))?;
    let mut restored_engine = SpineEngine::new(
        agent_id,
        dev2.clone(),
        ring2,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev2.device_id().hlc_node_tag()),
        store2,
    )?;

    let imported_count = restored_engine.import_zip(&zip_path, 1_795_400_002_000)?;
    assert_eq!(imported_count, 502);
    assert_eq!(restored_engine.store().list_all_events()?.len(), 502);
    assert_eq!(restored_engine.store().list_memories()?.len(), 1);
    assert!(
        restored_engine
            .store()
            .list_markdown_docs()?
            .iter()
            .any(|(p, _)| p == "SOUL.md")
    );

    // 验证纯可读 Markdown 导出模式（include_spine_packs = false）不含加密包且可导入至全新 Agent
    let md_zip_path = dir.join("markdown_only.zip");
    engine.export_zip(
        &md_zip_path,
        ZipExportOptions {
            include_spine_packs: false,
        },
    )?;
    {
        let zf = File::open(&md_zip_path)?;
        let mut archive = ZipArchive::new(zf)?;
        let mut md_names = Vec::new();
        for idx in 0..archive.len() {
            md_names.push(archive.by_index(idx)?.name()?.into_owned());
        }
        assert!(md_names.iter().any(|n| n == "SOUL.md"));
        assert!(
            !md_names
                .iter()
                .any(|n| n.starts_with(".quetzalcoatl-spine/"))
        );
    }

    let fresh_agent = AgentId::new_v4();
    let fresh_root = AccountRootKey::generate()?;
    let fresh_dev = DeviceIdentity::generate(DeviceId::new_v4())?;
    let fresh_ring =
        EpochKeyRing::new_genesis(fresh_agent, &fresh_root, fresh_dev.public_record())?;
    let mut md_engine = SpineEngine::new(
        fresh_agent,
        fresh_dev.clone(),
        fresh_ring,
        HlcTimestamp::from_parts(1_795_400_005_000, 0, fresh_dev.device_id().hlc_node_tag()),
        RusqliteWalStore::open(&dir.join("md_restored.sqlite"))?,
    )?;
    let md_imported = md_engine.import_zip(&md_zip_path, 1_795_400_006_000)?;
    assert!(md_imported >= 4);
    assert_eq!(md_engine.store().list_memories()?.len(), 1);

    fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn interleaved_compartments_partial_pack_preserves_unpacked_events_on_zip_roundtrip() -> TestResult
{
    let dir = temp_test_dir("interleaved")?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let dev_a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let dev_b = DeviceIdentity::generate(DeviceId::new_v4())?;
    let mut ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev_a.public_record())?;
    ring.add_device(&root_key, dev_b.public_record())?;

    let mut engine_a = SpineEngine::new(
        agent_id,
        dev_a.clone(),
        ring.clone(),
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev_a.device_id().hlc_node_tag()),
        RusqliteWalStore::open(&dir.join("interleaved_a.sqlite"))?,
    )?;
    // 设阈值为 2：seq=1 (Core), seq=2 (ExternalChannel), seq=3 (Core -> 触发 Core 单独封包，此时 seq=2 仍未封包！)
    engine_a.set_auto_pack_threshold(2);
    engine_a.append_event(PackCompartment::Core, "{\"step\":1}", 1_795_400_000_010)?;
    engine_a.append_event(
        PackCompartment::ExternalChannel,
        "{\"inbound\":\"mid-unpacked\"}",
        1_795_400_000_020,
    )?;
    engine_a.append_event(PackCompartment::Core, "{\"step\":3}", 1_795_400_000_030)?;

    assert_eq!(engine_a.store().list_packfiles()?.len(), 1);
    assert_eq!(
        engine_a.store().list_all_unpacked_events()?.len(),
        1,
        "夹在 Core first_seq..=last_seq 中间的未封包 ExternalChannel 事件不得被误标为已封包"
    );

    let zip_path = dir.join("interleaved.zip");
    engine_a.export_zip(
        &zip_path,
        ZipExportOptions {
            include_spine_packs: true,
        },
    )?;

    let mut engine_b = SpineEngine::new(
        agent_id,
        dev_b.clone(),
        ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev_b.device_id().hlc_node_tag()),
        RusqliteWalStore::open(&dir.join("interleaved_b.sqlite"))?,
    )?;
    let restored = engine_b.import_zip(&zip_path, 1_795_400_000_500)?;
    assert_eq!(restored, 3);
    assert_eq!(engine_b.store().list_all_events()?.len(), 3);
    // 已在 Packfile 内的 seq=1 与 seq=3 恢复后必须保留各自的 pack_id，仅未封包的 seq=2 处于 unpacked 状态！
    assert_eq!(
        engine_b.store().list_all_unpacked_events()?.len(),
        1,
        "从 ZIP 恢复后，已封包事件的 pack_id 不得丢失退化为 NULL"
    );

    fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn zip_manifest_is_encrypted_authenticated_and_rejects_rogue_device_or_tampering() -> TestResult {
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let dir = temp_test_dir("manifest_sec")?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let dev_a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let dev_b = DeviceIdentity::generate(DeviceId::new_v4())?;
    let mut ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev_a.public_record())?;
    ring.add_device(&root_key, dev_b.public_record())?;

    let mut engine_a = SpineEngine::new(
        agent_id,
        dev_a.clone(),
        ring.clone(),
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev_a.device_id().hlc_node_tag()),
        RusqliteWalStore::open(&dir.join("sec_a.sqlite"))?,
    )?;

    engine_a.append_event(
        PackCompartment::Core,
        "{\"kind\":\"memory.observe\",\"secret\":\"TAIL_SECRET_PAYLOAD_8821\"}",
        1_795_400_000_100,
    )?;
    engine_a.store_mut().upsert_message(&MaterializedMessage {
        message_id: String::from("msg-sec-1"),
        thread_key: String::from("th-sec"),
        role: String::from("user"),
        channel: String::from("local"),
        body_origin: String::from("laptop"),
        content: String::from("ULTRA_SECRET_TRANSCRIPT_9941"),
        ts_ms: 1_795_400_000_110,
    })?;
    let hlc_a = engine_a.local_hlc();
    engine_a.store_mut().upsert_memory(&MaterializedMemory {
        memory_id: String::from("mem-sec-1"),
        category: String::from("memory"),
        authority: 30,
        content: String::from("CORE_MEMORY_SECRET_7731"),
        updated_hlc: hlc_a,
    })?;

    let zip_path = dir.join("backup_sec.zip");
    engine_a.export_zip(
        &zip_path,
        ZipExportOptions {
            include_spine_packs: true,
        },
    )?;

    // 1. 断言 .quetzalcoatl-spine/manifest.json 已用 EpochKey 加密密封，不含任何敏感明文字段！
    let mut all_entries = Vec::<(String, Vec<u8>)>::new();
    let manifest_text = {
        let zf = File::open(&zip_path)?;
        let mut archive = ZipArchive::new(zf)?;
        let mut found_manifest = String::new();
        for idx in 0..archive.len() {
            let mut item = archive.by_index(idx)?;
            let name = item.name()?.into_owned();
            let mut buf = Vec::new();
            item.read_to_end(&mut buf)?;
            if name == ".quetzalcoatl-spine/manifest.json" {
                found_manifest = String::from_utf8(buf.clone())?;
            }
            all_entries.push((name, buf));
        }
        found_manifest
    };
    assert!(!manifest_text.is_empty());
    for forbidden_plaintext in [
        "TAIL_SECRET_PAYLOAD_8821",
        "ULTRA_SECRET_TRANSCRIPT_9941",
        "CORE_MEMORY_SECRET_7731",
        "\"tail_events\"",
        "\"messages\"",
        "\"device_pubkeys\"",
    ] {
        assert!(
            !manifest_text.contains(forbidden_plaintext),
            ".quetzalcoatl-spine/manifest.json 严禁明文暴露敏感脊柱状态: {forbidden_plaintext}"
        );
    }

    // 2. 构造篡改 manifest.json（注入未授权流氓设备或翻转密文字节）的恶意 ZIP，验证导入返回 IntegrityViolation
    let rogue_dev = DeviceIdentity::generate(DeviceId::new_v4())?;
    let forged_zip_path = dir.join("forged_manifest.zip");
    {
        let out = File::create(&forged_zip_path)?;
        let mut writer = ZipWriter::new(out);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, bytes) in &all_entries {
            writer.start_file(name.as_str(), opts)?;
            if name == ".quetzalcoatl-spine/manifest.json" {
                let mut v: serde_json::Value = serde_json::from_slice(bytes)?;
                if let Some(ct_hex) = v
                    .get("ciphertext_hex")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                {
                    let mut raw = quetzalcoatl_crypto::hex_decode("ct", &ct_hex)?;
                    if let Some(b) = raw.first_mut() {
                        *b ^= 0xff;
                    }
                    v["ciphertext_hex"] =
                        serde_json::Value::String(quetzalcoatl_crypto::hex_encode(&raw));
                } else {
                    // 若未加密，模拟攻击者直接向明文 manifest 塞入 rogue_dev 公钥与伪造高权限良知文档
                    v["device_pubkeys"][rogue_dev.device_id().to_string()] =
                        serde_json::Value::String(quetzalcoatl_crypto::hex_encode(
                            rogue_dev.ed25519_public_key(),
                        ));
                }
                writer.write_all(&serde_json::to_vec(&v)?)?;
            } else {
                writer.write_all(bytes)?;
            }
        }
        writer.finish()?;
    }

    let mut target_engine = SpineEngine::new(
        agent_id,
        dev_b.clone(),
        ring.clone(),
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev_b.device_id().hlc_node_tag()),
        RusqliteWalStore::open(&dir.join("sec_b.sqlite"))?,
    )?;
    let tamper_err = target_engine
        .import_zip(&forged_zip_path, 1_795_400_000_500)
        .err()
        .ok_or("篡改 manifest.json 密文必须报错")?;
    assert_eq!(tamper_err.code(), ErrorCode::IntegrityViolation);

    // 3. 即使攻击者持有旧 EpochKey 重密封了合法 AEAD 信封，只要没有 AccountRootKey 根私钥，
    //    伪造成员设备变更签名或注入越界 markdown_docs 路径（如 ../escape.md）仍必须被拦截！
    let fake_root = AccountRootKey::generate()?;
    let forged_membership = fake_root.sign_membership_change(
        agent_id,
        Epoch::new(1),
        quetzalcoatl_crypto::MemberOperation::AddDevice,
        &rogue_dev.public_record(),
    )?;
    let rogue_ev = SpineEvent::sign_new(
        agent_id,
        &rogue_dev,
        Epoch::new(1),
        1,
        ArtifactId::ZERO,
        HlcTimestamp::from_parts(1_795_400_000_200, 0, rogue_dev.device_id().hlc_node_tag()),
        "{\"kind\":\"conscience.poison\"}",
    )?;
    let epoch_key = ring.current_epoch_key().ok_or("缺少当前纪元密钥")?.clone();

    for (zip_name, forged_payload) in [
        (
            "forged_rogue_member.zip",
            serde_json::json!({
                "version": 2,
                "agent_id": agent_id,
                "membership_changes": [forged_membership],
                "pack_files": [],
                "tail_events": [[rogue_ev, "core"]],
                "checkpoints": [],
                "memories": [],
                "threads": [],
                "messages": [],
                "runs": [],
                "markdown_docs": []
            }),
        ),
        (
            "forged_doc_traversal.zip",
            serde_json::json!({
                "version": 2,
                "agent_id": agent_id,
                "membership_changes": [],
                "pack_files": [],
                "tail_events": [],
                "checkpoints": [],
                "memories": [],
                "threads": [],
                "messages": [],
                "runs": [],
                "markdown_docs": [["../escape.md", "pwned"]]
            }),
        ),
    ] {
        let p = dir.join(zip_name);
        let env = quetzalcoatl_crypto::seal_manifest_envelope(
            agent_id,
            Epoch::new(1),
            &epoch_key,
            &serde_json::to_vec(&forged_payload)?,
        )?;
        let out = File::create(&p)?;
        let mut writer = ZipWriter::new(out);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer.start_file(".quetzalcoatl-spine/manifest.json", opts)?;
        writer.write_all(&serde_json::to_vec(&env)?)?;
        writer.finish()?;

        let err = target_engine
            .import_zip(&p, 1_795_400_000_500)
            .err()
            .ok_or("伪造根签名成员变更或越界路径必须报错")?;
        assert_eq!(err.code(), ErrorCode::IntegrityViolation);
    }

    // 4. 验证合法未篡改的加密备份包无损恢复全部事件、消息与记忆！
    let restored_events = target_engine.import_zip(&zip_path, 1_795_400_000_600)?;
    assert_eq!(restored_events, 1);
    assert_eq!(target_engine.store().list_messages(None)?.len(), 1);
    assert_eq!(target_engine.store().list_memories()?.len(), 1);

    fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn batch_ingest_interleaved_packs_marks_pack_id_and_broken_chain_is_atomic() -> TestResult {
    let dir = temp_test_dir("batch_atomic")?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let dev_a = DeviceIdentity::generate(DeviceId::new_v4())?;
    let dev_b = DeviceIdentity::generate(DeviceId::new_v4())?;
    let dev_rogue_chain = DeviceIdentity::generate(DeviceId::new_v4())?;
    let mut ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev_a.public_record())?;
    ring.add_device(&root_key, dev_b.public_record())?;
    ring.add_device(&root_key, dev_rogue_chain.public_record())?;

    let mut engine_a = SpineEngine::new(
        agent_id,
        dev_a.clone(),
        ring.clone(),
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev_a.device_id().hlc_node_tag()),
        RusqliteWalStore::open(&dir.join("atomic_a.sqlite"))?,
    )?;
    // 交错写入 seq=1(Core), seq=2(ExternalChannel), seq=3(Core)，然后 seal_checkpoint 生成 2 个交错 Packfiles
    engine_a.append_event(PackCompartment::Core, "{\"n\":1}", 1_795_400_000_010)?;
    engine_a.append_event(
        PackCompartment::ExternalChannel,
        "{\"n\":2}",
        1_795_400_000_020,
    )?;
    engine_a.append_event(PackCompartment::Core, "{\"n\":3}", 1_795_400_000_030)?;
    let packs = engine_a.seal_checkpoint(None, 1_795_400_000_040)?;
    assert_eq!(packs.len(), 2);

    let epoch_key = ring.current_epoch_key().ok_or("缺少当前纪元密钥")?.clone();

    let mut engine_b = SpineEngine::new(
        agent_id,
        dev_b.clone(),
        ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev_b.device_id().hlc_node_tag()),
        RusqliteWalStore::open(&dir.join("atomic_b.sqlite"))?,
    )?;

    // Part A: 批量原子合入交错分舱 Packfiles，验证 3 条事件全部合入且 pack_id 均非 NULL（unpacked == 0）
    let ingested = engine_b.ingest_remote_packfiles(
        &packs,
        &epoch_key,
        dev_a.ed25519_public_key(),
        1_795_400_000_100,
    )?;
    assert_eq!(ingested.len(), 3);
    assert_eq!(engine_b.store().list_all_events()?.len(), 3);
    assert!(
        engine_b.store().list_all_unpacked_events()?.is_empty(),
        "经 Packfile 合入的事件必须标记其所属 pack_id，不得遗留为未封包事件"
    );

    // Part B: 构造包内第 2 条事件 prev_blake3 断裂的 Packfile，验证整包原子拒收、SQLite 零残留、HLC 不推进
    let hlc_ev1 = HlcTimestamp::from_parts(
        1_795_400_000_200,
        0,
        dev_rogue_chain.device_id().hlc_node_tag(),
    );
    let hlc_ev2 = HlcTimestamp::from_parts(
        1_795_400_000_210,
        0,
        dev_rogue_chain.device_id().hlc_node_tag(),
    );
    let good_ev1 = SpineEvent::sign_new(
        agent_id,
        &dev_rogue_chain,
        Epoch::new(1),
        1,
        ArtifactId::ZERO,
        hlc_ev1,
        "{\"step\":\"ok-1\"}",
    )?;
    let broken_ev2 = SpineEvent::sign_new(
        agent_id,
        &dev_rogue_chain,
        Epoch::new(1),
        2,
        ArtifactId::from_bytes([0xee; 32]), // 错误的 prev_blake3！
        hlc_ev2,
        "{\"step\":\"broken-2\"}",
    )?;
    let broken_jsonl = encode_events_jsonl(&[good_ev1, broken_ev2])?;
    let broken_pack = quetzalcoatl_crypto::seal_packfile(
        agent_id,
        dev_rogue_chain.device_id(),
        PackCompartment::Core,
        Epoch::new(1),
        &epoch_key,
        1,
        2,
        hlc_ev1,
        hlc_ev2,
        broken_jsonl.as_bytes(),
    )?;

    let hlc_before = engine_b.local_hlc();
    let events_before = engine_b.store().list_all_events()?.len();

    let broken_err = engine_b
        .ingest_remote_packfile(
            &broken_pack,
            &epoch_key,
            dev_rogue_chain.ed25519_public_key(),
            1_795_400_000_300,
        )
        .err()
        .ok_or("包内哈希链断裂必须报错")?;
    assert_eq!(broken_err.code(), ErrorCode::IntegrityViolation);
    assert_eq!(
        engine_b.local_hlc(),
        hlc_before,
        "原子校验失败不得推进本机 HLC"
    );
    assert_eq!(
        engine_b.store().list_all_events()?.len(),
        events_before,
        "原子校验失败不得把第 1 条事件残留在 SQLite 中"
    );
    assert!(
        engine_b
            .store()
            .list_device_events(dev_rogue_chain.device_id())?
            .is_empty()
    );

    fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn event_head_summary_returns_count_and_last_n_without_full_history() -> TestResult {
    let dir = temp_test_dir("event_heads")?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::generate()?;
    let dev = DeviceIdentity::generate(DeviceId::new_v4())?;
    let ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev.public_record())?;
    let mut engine = SpineEngine::new(
        agent_id,
        dev.clone(),
        ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev.device_id().hlc_node_tag()),
        RusqliteWalStore::open(&dir.join("heads.sqlite"))?,
    )?;
    engine.set_auto_pack_threshold(1_000_000);
    for index in 1..=40u64 {
        engine.append_event(
            PackCompartment::Core,
            &format!("{{\"kind\":\"step\",\"n\":{index}}}"),
            1_795_400_000_000u64.saturating_add(index.saturating_mul(10)),
        )?;
    }

    let (count, heads) = engine.store().spine_event_count_and_heads(6)?;
    assert_eq!(count, 40, "COUNT(*) 必须覆盖完整历史");
    assert_eq!(heads.len(), 6, "只返回最近的 6 条事件头");
    assert_eq!(
        heads.iter().map(|head| head.seq).collect::<Vec<_>>(),
        vec![40, 39, 38, 37, 36, 35],
        "事件头必须按 seq 倒序且只含最近 N 条"
    );
    assert!(
        heads
            .iter()
            .all(|head| head.payload_prefix.contains("\"kind\":\"step\"")),
        "payload 只取前缀，但足以还原审计归类"
    );
    assert!(heads.iter().all(|head| !head.hlc_hex.is_empty()));

    fs::remove_dir_all(&dir)?;
    Ok(())
}
