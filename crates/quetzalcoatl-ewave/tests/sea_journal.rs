#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 变更日志：良知由脊柱事件重放得到；正文不以明文进链；抹除是真删。

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing};
use quetzalcoatl_ewave::journal::{self, EntryKeyStore, SeaLayer, StoreEntryKeys};
use quetzalcoatl_ewave::{
    Authority, Conscience, ConscienceManifest, FocusConfig, IdentityBlock, MemoryEntry, MemoryKind,
    Mutability, ProtectedDirective, ProvenanceRecord, ValueEntry,
};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, HlcTimestamp};

type TestResult = Result<(), Box<dyn Error>>;

const BASE_MS: u64 = 1_795_400_000_000;

struct TempDbGuard(PathBuf);

impl Drop for TempDbGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn test_spine(tag: &str) -> Result<(SpineEngine<RusqliteWalStore>, TempDbGuard), Box<dyn Error>> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "qz_sea_journal_{tag}_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir)?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::from_bytes([0x42u8; 32]);
    let device = DeviceIdentity::from_seeds(DeviceId::new_v4(), [0x11u8; 32], [0x22u8; 32])?;
    let ring = EpochKeyRing::new_genesis(agent_id, &root_key, device.public_record())?;
    let store = RusqliteWalStore::open(&dir.join("spine.sqlite"))?;
    let spine = SpineEngine::new(
        agent_id,
        device,
        ring,
        HlcTimestamp::from_parts(BASE_MS, 0, 1),
        store,
    )?;
    Ok((spine, TempDbGuard(dir)))
}

fn prov() -> ProvenanceRecord {
    ProvenanceRecord {
        written_by: String::from("owner"),
        at_ms: BASE_MS,
        source_event_ids: Vec::new(),
        model: None,
        supersedes: None,
    }
}

fn memory(id: &str, content: &str) -> MemoryEntry {
    MemoryEntry {
        id: String::from(id),
        kind: MemoryKind::Fact,
        topic: None,
        content: String::from(content),
        about: Vec::new(),
        salience: 0.7,
        evidence_count: 1,
        constant: false,
        untrusted: false,
        muted: false,
        pressure_flags: Vec::new(),
        authority: Authority::Memory,
        mutability: Mutability::memory_free(),
        valid_from_ms: BASE_MS,
        invalid_at_ms: None,
        triggers: Vec::new(),
        provenance: prov(),
    }
}

fn sample() -> Result<Conscience, Box<dyn Error>> {
    let root_key = AccountRootKey::from_bytes([0x42u8; 32]);
    let root_directives: Vec<ProtectedDirective> = Vec::new();
    let operator_directives = vec![ProtectedDirective {
        id: String::from("operator-credentials"),
        authority: Authority::Operator,
        title: String::from("凭据不外泄"),
        content: String::from("不向任何对话、工具或外部通道泄露本机的登录凭据与密钥。"),
        created_at_ms: BASE_MS,
    }];
    let manifest = ConscienceManifest::sign_with_root(
        &root_key,
        &root_directives,
        &operator_directives,
        BASE_MS,
    )?;
    Ok(Conscience {
        schema_version: String::from("ewave-conscience/v1"),
        root_directives,
        operator_directives,
        manifest,
        identity: vec![IdentityBlock {
            id: String::from("name"),
            label: String::from("名字"),
            description: String::new(),
            value: String::from("青羽"),
            char_limit: 64,
            authority: Authority::SelfSoft,
            mutability: Mutability::self_soft_default(),
            pinned: true,
            provenance: prov(),
        }],
        values: vec![ValueEntry {
            id: String::from("self-core-integrity"),
            statement: String::from("尊重事实证据，诚实披露不确定性与立场差异。"),
            rationale: None,
            authority: Authority::SelfCore,
            negotiable_in_conversation: false,
            examples: Vec::new(),
            mutability: Mutability::self_core_default(),
            provenance: prov(),
            valid_from_ms: BASE_MS,
            invalid_at_ms: None,
        }],
        relationships: Vec::new(),
        memories: vec![
            memory("mem-allergy", "对青霉素过敏，就诊时必须主动说明。"),
            memory("mem-db", "数据库迁移方案定为先双写再切读。"),
        ],
        focus: FocusConfig::default(),
        grants_given: Vec::new(),
        grants_received: Vec::new(),
        episodes: Vec::new(),
        peer_links: BTreeMap::new(),
        pending_disclosures: Vec::new(),
    })
}

fn all_payloads(spine: &SpineEngine<RusqliteWalStore>) -> Result<String, Box<dyn Error>> {
    Ok(spine
        .store()
        .list_all_events()?
        .into_iter()
        .map(|(event, _)| event.payload_utf8)
        .collect::<Vec<_>>()
        .join("\n"))
}

#[test]
fn a_baseline_and_later_changes_replay_to_exactly_the_same_conscience() -> TestResult {
    let (mut spine, _guard) = test_spine("replay")?;
    assert!(
        journal::replay(&mut spine)?.is_none(),
        "还没有事件时无可重放"
    );

    let baseline = sample()?;
    let seq = journal::commit(
        &mut spine,
        None,
        &baseline,
        "system",
        1,
        "收编为基线",
        BASE_MS,
    )?;
    assert!(seq.is_some());
    assert_eq!(journal::replay(&mut spine)?, Some(baseline.clone()));

    let mut changed = baseline.clone();
    changed
        .memories
        .push(memory("mem-cat", "家里的猫叫栗子，三岁。"));
    if let Some(first) = changed.memories.first_mut() {
        first.muted = true;
    }
    if let Some(db) = changed.memories.iter_mut().find(|m| m.id == "mem-db") {
        db.invalid_at_ms = Some(BASE_MS + 5_000);
    }
    changed.focus.floor_self = 0.55;
    let seq = journal::commit(
        &mut spine,
        Some(&baseline),
        &changed,
        "owner",
        1,
        "新增一条、静默一条、让一条过期",
        BASE_MS + 5_000,
    )?;
    assert!(seq.is_some());
    assert_eq!(journal::replay(&mut spine)?, Some(changed.clone()));

    let nothing = journal::commit(
        &mut spine,
        Some(&changed),
        &changed,
        "owner",
        1,
        "没有改动",
        BASE_MS + 6_000,
    )?;
    assert!(nothing.is_none(), "没有差异时不写事件");
    Ok(())
}

#[test]
fn entry_text_never_enters_the_signed_chain_in_the_clear() -> TestResult {
    let (mut spine, _guard) = test_spine("sealed")?;
    let baseline = sample()?;
    let _ = journal::commit(
        &mut spine,
        None,
        &baseline,
        "system",
        1,
        "收编为基线",
        BASE_MS,
    )?;
    let payloads = all_payloads(&spine)?;
    for secret in ["青霉素", "双写", "青羽", "诚实披露"] {
        assert!(
            !payloads.contains(secret),
            "事件正文里不得出现条目明文「{secret}」"
        );
    }
    assert!(
        payloads.contains("mem-allergy"),
        "条目编号是明文，供审计与重放定位"
    );
    assert!(
        payloads.contains("凭据不外泄"),
        "受保护条款不是可抹除的条目，照常明文签署"
    );
    Ok(())
}

#[test]
fn erasing_an_entry_destroys_its_key_and_every_earlier_version_with_it() -> TestResult {
    let (mut spine, _guard) = test_spine("erase")?;
    let baseline = sample()?;
    let _ = journal::commit(
        &mut spine,
        None,
        &baseline,
        "system",
        1,
        "收编为基线",
        BASE_MS,
    )?;

    // 先改一次，让链里有这一条的两个版本。
    let mut revised = baseline.clone();
    if let Some(allergy) = revised.memories.iter_mut().find(|m| m.id == "mem-allergy") {
        allergy.content = String::from("对青霉素与头孢都过敏。");
    }
    let _ = journal::commit(
        &mut spine,
        Some(&baseline),
        &revised,
        "owner",
        1,
        "纠正",
        BASE_MS + 1,
    )?;

    let mut erased = revised.clone();
    erased.memories.retain(|m| m.id != "mem-allergy");
    let _ = journal::commit(
        &mut spine,
        Some(&revised),
        &erased,
        "owner",
        1,
        "抹除",
        BASE_MS + 2,
    )?;

    assert!(
        StoreEntryKeys(spine.store_mut())
            .load_key(SeaLayer::Memory, "mem-allergy")?
            .is_none(),
        "抹除就是销毁这一条的钥匙"
    );
    assert!(
        StoreEntryKeys(spine.store_mut())
            .load_key(SeaLayer::Memory, "mem-db")?
            .is_some(),
        "别的条目的钥匙不受影响"
    );
    let replayed = journal::replay(&mut spine)?.ok_or("应能重放")?;
    assert_eq!(replayed, erased);
    assert!(replayed.memories.iter().all(|m| m.id != "mem-allergy"));
    Ok(())
}

#[test]
fn a_destroyed_key_alone_is_enough_for_replay_to_treat_the_entry_as_erased() -> TestResult {
    let (mut spine, _guard) = test_spine("crash")?;
    let baseline = sample()?;
    let _ = journal::commit(
        &mut spine,
        None,
        &baseline,
        "system",
        1,
        "收编为基线",
        BASE_MS,
    )?;

    // 模拟「钥匙已销毁、抹除事件还没来得及写」就崩溃。
    StoreEntryKeys(spine.store_mut()).destroy_key(SeaLayer::Memory, "mem-db")?;

    let replayed = journal::replay(&mut spine)?.ok_or("应能重放")?;
    assert!(
        replayed.memories.iter().all(|m| m.id != "mem-db"),
        "钥匙不在的条目重放时必须消失，不能报错也不能复活"
    );
    assert!(replayed.memories.iter().any(|m| m.id == "mem-allergy"));
    Ok(())
}
