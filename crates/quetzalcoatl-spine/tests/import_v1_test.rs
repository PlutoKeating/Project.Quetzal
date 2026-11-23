use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, HlcTimestamp};
use rusqlite::Connection;

type TestResult = Result<(), Box<dyn Error>>;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn import_v1_soul_v14_and_two_multi_body_sqlite_dbs_is_strictly_idempotent() -> TestResult {
    let temp_dir = std::env::temp_dir().join(format!("qz_import_v1_test_{}", std::process::id()));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)?;
    }
    fs::create_dir_all(&temp_dir)?;

    let f_dir = fixtures_dir();
    let soul_v14 = f_dir.join("v1_soul_v14");
    let sample_sql = fs::read_to_string(f_dir.join("v1_quetzal_sample.sql"))?;

    // 构造两份来自不同 V1 身体（laptop 与 handset）的 quetzal.db：
    // 两者共享已同步的基础历史记录，且 handset_db 额外携带一条仅在手持端刚产生尚未复制回电脑的消息与会话，
    // 用于验证：1) 跨两份数据库重叠行自动去重；2) 双身体 2^32 编号段完整合入；3) 连续执行两次 import_v1 严格幂等零重复！
    let laptop_db = temp_dir.join("laptop_quetzal.db");
    let handset_db = temp_dir.join("handset_quetzal.db");

    {
        let conn_laptop = Connection::open(&laptop_db)?;
        conn_laptop.execute_batch(&sample_sql)?;
    }
    {
        let conn_handset = Connection::open(&handset_db)?;
        conn_handset.execute_batch(&sample_sql)?;
        conn_handset.execute_batch(
            "
            UPDATE kv SET v = '{\"prefix\":346685,\"at\":1790928200000}' WHERE k = 'store.ids';
            INSERT INTO sessions(id, title, channel, created, updated, archived)
              VALUES ('conv-mobile-03', '地铁通勤灵感记录', '移动端', 1790929000000, 1790929050000, 0);
            INSERT INTO messages(id, ts, role, channel, text, session, body, via)
              VALUES (1489000737013763, 1790929010000, 'user', '移动端', '记一下：离线状态下的非幂等公网消息必须暂存 Outbox。', 'conv-mobile-03', 'handset', 'handset');
            ",
        )?;
    }

    let agent_id = AgentId::from_str("018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f")?;
    let root_key = AccountRootKey::generate()?;
    let dev =
        DeviceIdentity::generate(DeviceId::from_str("01020304-0506-8708-890a-0b0c0d0e0f10")?)?;
    let ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev.public_record())?;
    let store = RusqliteWalStore::open(&temp_dir.join("v2_spine.sqlite"))?;

    let mut engine = SpineEngine::new(
        agent_id,
        dev.clone(),
        ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, dev.device_id().hlc_node_tag()),
        store,
    )?;

    let db_paths = vec![laptop_db, handset_db];

    // 第一次导入
    let report1 = engine.import_v1(&soul_v14, &db_paths, 1_795_400_010_000)?;
    assert!(report1.imported_events > 0);
    // MEMORY.md (3 段 §) + USER.md (2 段 §) + kv thought (1 条) = 至少 6 条物化记忆
    assert!(report1.memories_imported >= 6);
    // conv-arch-01 + conv-daily-02 + conv-mobile-03 = 3 个会话线程（跨两库自动合并去重）
    assert_eq!(report1.threads_imported, 3);
    // laptop 2 条 + handset 共享 2 条 + handset 独占 1 条 = 5 条消息（绝不因双库重叠翻倍为 9 条！）
    assert_eq!(report1.messages_imported, 5);
    assert_eq!(report1.skills_imported, 1);
    assert!(report1.docs_imported >= 4);
    assert!(report1.runs_imported >= 1);

    let events_after_1 = engine.store().list_all_events()?.len();
    let memories_after_1 = engine.store().list_memories()?.len();
    let threads_after_1 = engine.store().list_threads()?.len();
    let messages_after_1 = engine.store().list_messages(None)?.len();
    let runs_after_1 = engine.store().list_runs()?.len();
    let docs_after_1 = engine.store().list_markdown_docs()?.len();

    assert_eq!(threads_after_1, 3);
    assert_eq!(messages_after_1, 5);

    // 验证 FTS5 能检索到 V1 导入的灵魂记忆与跨身体消息
    let mem_hits = engine.store().search_memories_fts("哈希校验和", 10)?;
    assert_eq!(mem_hits.len(), 1);
    let msg_hits = engine.store().search_messages_fts("Outbox", 10)?;
    assert_eq!(msg_hits.len(), 1);

    // 第二次连续导入完全相同的 soul-v14 + 两份不同身体 quetzal.db -> 必须严格 100% 幂等无重复！
    let report2 = engine.import_v1(&soul_v14, &db_paths, 1_795_400_020_000)?;
    assert_eq!(report2.imported_events, 0);
    assert!(report2.skipped_duplicates > 0);
    assert_eq!(report2.memories_imported, 0);
    assert_eq!(report2.threads_imported, 0);
    assert_eq!(report2.messages_imported, 0);
    assert_eq!(report2.skills_imported, 0);
    assert_eq!(report2.docs_imported, 0);
    assert_eq!(report2.runs_imported, 0);

    assert_eq!(engine.store().list_all_events()?.len(), events_after_1);
    assert_eq!(engine.store().list_memories()?.len(), memories_after_1);
    assert_eq!(engine.store().list_threads()?.len(), threads_after_1);
    assert_eq!(engine.store().list_messages(None)?.len(), messages_after_1);
    assert_eq!(engine.store().list_runs()?.len(), runs_after_1);
    assert_eq!(engine.store().list_markdown_docs()?.len(), docs_after_1);

    fs::remove_dir_all(&temp_dir)?;
    Ok(())
}
