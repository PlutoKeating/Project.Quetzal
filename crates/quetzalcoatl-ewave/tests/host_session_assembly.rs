#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 宿主会话档位与召回地板。
//!
//! 送进用户自己的宿主会话的内容，和送进受管运行网关的内容不是一回事：
//! 用户会话里不能要求模型在每条回复末尾输出可见标签，稳定内容只在会话开始时送一次，
//! 每次提交只带「这一句话相关的往事」——没有相关往事时一个字都不带。

use std::collections::BTreeMap;
use std::error::Error;

use quetzalcoatl_crypto::AccountRootKey;
use quetzalcoatl_ewave::{
    AssemblyRequest, Authority, BudgetProfile, Conscience, ConscienceManifest, ContextAssembler,
    DisclosureNotice, FocusConfig, GraphOptions, InjectionSurface, MemoryEntry, MemoryKind,
    Mutability, ProtectedDirective, ProvenanceRecord, SerpentineGraph, ValueEntry,
};

type TestResult = Result<(), Box<dyn Error>>;

const BASE_MS: u64 = 1_795_400_000_000;

fn prov() -> ProvenanceRecord {
    ProvenanceRecord {
        written_by: String::from("owner"),
        at_ms: BASE_MS,
        source_event_ids: Vec::new(),
        model: None,
        supersedes: None,
    }
}

fn memory(id: &str, content: &str, triggers: &[&str], constant: bool) -> MemoryEntry {
    MemoryEntry {
        id: String::from(id),
        kind: MemoryKind::Fact,
        topic: None,
        content: String::from(content),
        about: Vec::new(),
        salience: 0.7,
        evidence_count: 1,
        constant,
        untrusted: false,
        muted: false,
        pressure_flags: Vec::new(),
        authority: Authority::Memory,
        mutability: Mutability::memory_free(),
        valid_from_ms: BASE_MS,
        invalid_at_ms: None,
        triggers: triggers.iter().map(|t| String::from(*t)).collect(),
        provenance: prov(),
    }
}

fn sample(memories: Vec<MemoryEntry>) -> Result<Conscience, Box<dyn Error>> {
    let root_key = AccountRootKey::from_bytes([0x51u8; 32]);
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
        identity: Vec::new(),
        values: vec![
            ValueEntry {
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
            },
            ValueEntry {
                id: String::from("pref-terse"),
                statement: String::from("他偏好先给结论再给理由。"),
                rationale: None,
                authority: Authority::UserPref,
                negotiable_in_conversation: true,
                examples: Vec::new(),
                mutability: Mutability::user_pref_default(),
                provenance: prov(),
                valid_from_ms: BASE_MS,
                invalid_at_ms: None,
            },
        ],
        relationships: Vec::new(),
        memories,
        focus: FocusConfig::default(),
        grants_given: Vec::new(),
        grants_received: Vec::new(),
        episodes: Vec::new(),
        peer_links: BTreeMap::new(),
        pending_disclosures: Vec::new(),
    })
}

fn host_request(query: Option<&str>) -> AssemblyRequest {
    let mut req = AssemblyRequest::new(BudgetProfile::Standard, BASE_MS + 60_000);
    req.surface = InjectionSurface::HostSession;
    req.query = query.map(String::from);
    req
}

#[test]
fn host_session_never_asks_the_model_to_print_a_visible_tag() -> TestResult {
    let conscience = sample(vec![memory(
        "mem-db",
        "数据库迁移方案定为先双写再切读，回滚窗口 48 小时。",
        &[],
        false,
    )])?;
    let graph = SerpentineGraph::new(GraphOptions::default())?;

    let host = ContextAssembler::assemble(&conscience, &graph, &host_request(Some("数据库迁移")))?;
    assert!(
        !host.pinned_system_tail.contains("ewave_check"),
        "宿主会话的核心段不得要求输出可见标签: {}",
        host.pinned_system_tail
    );
    assert!(
        !host.volatile_user_tail.contains("ewave_check"),
        "宿主会话的每轮内容不得带标签模板: {}",
        host.volatile_user_tail
    );
    assert!(
        host.pinned_system_tail.contains("self-core-integrity"),
        "核心价值仍在核心段里"
    );
    assert!(
        host.pinned_system_tail.contains("ANTI_MIND_VIRUS"),
        "免疫条款仍在核心段里"
    );

    // 受管运行的网关档位保持原样：仍要求标签，供驱动解析自检结果。
    let mut managed = AssemblyRequest::new(BudgetProfile::Standard, BASE_MS + 60_000);
    managed.query = Some(String::from("数据库迁移"));
    let managed = ContextAssembler::assemble(&conscience, &graph, &managed)?;
    assert!(managed.pinned_system_tail.contains("<ewave_check"));
    assert!(managed.volatile_user_tail.contains("<ewave_check"));
    Ok(())
}

#[test]
fn host_session_sends_stable_layers_once_and_nothing_when_nothing_is_relevant() -> TestResult {
    let conscience = sample(vec![memory(
        "mem-db",
        "数据库迁移方案定为先双写再切读，回滚窗口 48 小时。",
        &[],
        false,
    )])?;
    let graph = SerpentineGraph::new(GraphOptions::default())?;

    let unrelated = ContextAssembler::assemble(
        &conscience,
        &graph,
        &host_request(Some("帮我把这个函数改成异步的")),
    )?;
    assert!(
        unrelated.volatile_user_tail.is_empty(),
        "没有相关往事、没有披露时，每轮内容必须为空: {}",
        unrelated.volatile_user_tail
    );
    assert!(unrelated.inlined_recall_ids.is_empty());
    assert!(
        unrelated.pinned_system_tail.contains("pref-terse"),
        "关于我的偏好属于稳定内容，随核心段在会话开始时送一次"
    );
    assert!(
        !unrelated.pinned_system_tail.contains("FocusConfig"),
        "内部权重不进用户会话"
    );
    Ok(())
}

#[test]
fn empty_query_brings_no_memories_except_constant_ones() -> TestResult {
    let conscience = sample(vec![
        memory("mem-a", "去年冬天在成都住过三个月。", &[], false),
        memory("mem-b", "对青霉素过敏。", &[], true),
    ])?;
    let graph = SerpentineGraph::new(GraphOptions::default())?;

    for query in [None, Some("   ")] {
        let ctx = ContextAssembler::assemble(&conscience, &graph, &host_request(query))?;
        assert_eq!(
            ctx.inlined_recall_ids,
            vec![String::from("mem-b")],
            "问题为空时只带常驻记忆，不能把全部记忆都带上"
        );
        assert!(ctx.spilled_recall_ids.is_empty());
    }
    Ok(())
}

#[test]
fn a_natural_question_recalls_memories_that_share_only_some_of_its_words() -> TestResult {
    let conscience = sample(vec![
        memory(
            "mem-db",
            "数据库迁移方案定为先双写再切读，回滚窗口 48 小时。",
            &[],
            false,
        ),
        memory(
            "mem-latency",
            "The p99 latency budget for the checkout API is 180 ms.",
            &[],
            false,
        ),
        memory("mem-cat", "家里的猫叫栗子，三岁。", &[], false),
    ])?;
    let graph = SerpentineGraph::new(GraphOptions::default())?;

    let zh = ContextAssembler::assemble(
        &conscience,
        &graph,
        &host_request(Some("我们上次定的数据库迁移方案，回滚窗口是多久来着？")),
    )?;
    assert_eq!(
        zh.inlined_recall_ids,
        vec![String::from("mem-db")],
        "整句提问不在记忆正文里，也必须按共同的词召回；无关记忆不带"
    );
    assert!(zh.volatile_user_tail.contains("48 小时"));

    let en = ContextAssembler::assemble(
        &conscience,
        &graph,
        &host_request(Some("what was the latency budget we agreed for checkout?")),
    )?;
    assert_eq!(en.inlined_recall_ids, vec![String::from("mem-latency")]);
    Ok(())
}

#[test]
fn recall_is_capped_and_never_lists_the_whole_sea() -> TestResult {
    let mut memories = Vec::new();
    for idx in 0..60 {
        memories.push(memory(
            &format!("mem-{idx:02}"),
            &format!("发布流程记录第 {idx} 条：发布流程在周四上午进行。"),
            &[],
            false,
        ));
    }
    let conscience = sample(memories)?;
    let graph = SerpentineGraph::new(GraphOptions::default())?;

    let ctx = ContextAssembler::assemble(
        &conscience,
        &graph,
        &host_request(Some("发布流程是什么时候")),
    )?;
    assert!(
        ctx.inlined_recall_ids.len() <= 8,
        "单轮带入条数有上限，实际 {}",
        ctx.inlined_recall_ids.len()
    );
    assert!(
        ctx.spilled_recall_ids.len() <= 16,
        "溢出清单也有上限，不能把整片海的编号都列出来，实际 {}",
        ctx.spilled_recall_ids.len()
    );
    Ok(())
}

#[test]
fn pending_disclosure_reaches_the_host_session_turn() -> TestResult {
    let mut conscience = sample(Vec::new())?;
    conscience.pending_disclosures.push(DisclosureNotice {
        target_id: String::from("self-core-integrity"),
        summary: String::from("开始更看重先把话说清楚再动手"),
        source_episode_ids: vec![String::from("ep-1"), String::from("ep-2")],
        created_at_ms: BASE_MS,
    });
    let graph = SerpentineGraph::new(GraphOptions::default())?;
    let ctx = ContextAssembler::assemble(&conscience, &graph, &host_request(Some("随便聊聊")))?;
    assert!(
        ctx.volatile_user_tail
            .contains("开始更看重先把话说清楚再动手"),
        "他的核心有变化时，这一轮要带上披露"
    );
    Ok(())
}
