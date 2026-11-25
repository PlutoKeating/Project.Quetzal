#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 五大标杆领域包契约：磁盘装载、JCS 规范化、监护人信封外发门禁与领域包 ID 校验。

use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use quetzalcoatl_domains::{DomainPackId, DomainPackRegistry, FLAGSHIP_DOMAIN_IDS, GuardianKey};
use quetzalcoatl_kernel::HeartScheduler;

type TestResult = Result<(), Box<dyn Error>>;

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(PathBuf::from)
        .ok_or("无法定位仓库根目录")?)
}

fn on_disk_registry() -> Result<DomainPackRegistry, Box<dyn Error>> {
    let mut registry = DomainPackRegistry::new(DomainPackId::parse("personal-companion")?);
    for key in quetzalcoatl_domains::builtin_guardian_keys() {
        registry.trust_guardian(key);
    }
    let domains_dir = repo_root()?.join("packages/domains");
    let installed = registry.load_dir(&domains_dir)?;
    assert_eq!(installed.len(), 5, "磁盘上必须恰有五大领域包");
    Ok(registry)
}

#[test]
fn every_flagship_pack_loads_from_disk_verifies_and_documents_itself() -> TestResult {
    let root = repo_root()?;
    let registry = on_disk_registry()?;

    let ids: Vec<String> = registry
        .ids()
        .into_iter()
        .map(|i| i.as_str().to_owned())
        .collect();
    assert_eq!(ids, FLAGSHIP_DOMAIN_IDS.to_vec());
    assert_eq!(registry.verify_all()?, 5);

    for id in FLAGSHIP_DOMAIN_IDS {
        let pack_id = DomainPackId::parse(id)?;
        let pack = registry.get(&pack_id)?;
        assert_eq!(pack.schema, quetzalcoatl_domains::DOMAIN_PACK_SCHEMA);
        assert_eq!(pack.id, id);
        assert!(!pack.locales.is_empty());
        assert!(!pack.role_tool_whitelist.is_empty());
        assert!(!pack.verifier_rules.is_empty());

        // 四档种子良知齐备
        let tiers: BTreeSet<&str> = pack
            .conscience_seed
            .entries
            .iter()
            .map(|e| e.tier.as_str())
            .collect();
        for tier in ["ROOT", "OPERATOR", "SELF_CORE", "SELF_SOFT"] {
            assert!(tiers.contains(tier), "{id} 缺少 {tier} 档种子良知");
        }

        // 每条可执行校验规则都锚定到监护人签名固定的良知条目
        for rule in &pack.verifier_rules {
            let entry = pack
                .conscience_seed
                .entry(rule.directive_id())
                .ok_or_else(|| format!("{id} 规则锚点不存在: {}", rule.directive_id()))?;
            assert_eq!(
                entry.source,
                quetzalcoatl_domains::SeedSource::Guardian,
                "{id} 规则锚点必须来自监护人签名"
            );
        }

        // 安全信封：签名、不可变字段、紧急性自洽
        let envelope = pack.envelope();
        assert_eq!(envelope.payload.pack_id, id);
        assert!(!envelope.payload.immutable_fields.is_empty());
        assert!(
            envelope
                .payload
                .immutable_fields
                .iter()
                .any(|f| f.starts_with("outbound."))
        );
        assert!(
            envelope
                .payload
                .immutable_fields
                .iter()
                .any(|f| f.starts_with("emergency."))
        );
        if envelope.payload.emergency.enabled {
            assert!(
                !envelope.payload.emergency.contacts.is_empty(),
                "{id} 启用紧急告警却未配置联系人"
            );
            assert!(
                envelope.payload.emergency.bypass_sleep_inhibition,
                "{id} 启用紧急告警必须同时声明睡眠抑制穿透"
            );
            assert!(
                envelope.payload.emergency.allow_local_alert_under_partition,
                "{id} 启用紧急告警必须允许断网分区本地告警"
            );
        }

        // README 必须真实存在并说明拒绝行为与启用方式
        let readme = fs::read_to_string(root.join("packages/domains").join(id).join("README.md"))?;
        assert!(
            readme.contains("## 它拒绝什么"),
            "{id} README 缺少拒绝行为章节"
        );
        assert!(
            readme.contains("## 如何启用"),
            "{id} README 缺少启用方式章节"
        );
        assert!(
            readme.contains(&pack.display_name) || readme.contains(id),
            "{id} README 必须提到领域包"
        );

        // 真实映射为 eWave 权威等级
        let directives = pack.conscience_seed.to_protected_directives()?;
        assert_eq!(directives.len(), pack.conscience_seed.entries.len());
        for directive in &directives {
            assert_eq!(directive.created_at_ms, 0);
        }
    }
    Ok(())
}

#[test]
fn embedded_pack_documents_are_byte_identical_to_disk_sources() -> TestResult {
    let root = repo_root()?;
    let embedded = quetzalcoatl_domains::builtin_pack_json();
    assert_eq!(embedded.len(), 5);
    for (id, content) in embedded {
        let disk = fs::read_to_string(root.join("packages/domains").join(id).join("pack.json"))?;
        assert_eq!(
            content, &disk,
            "内置领域包 {id} 与磁盘 pack.json 漂移：请重新运行 `cargo run -p quetzalcoatl-domains --example sign_domain_packs`"
        );
        assert!(
            content.contains("\"digestHex\": \""),
            "内置领域包 {id} 缺少签名摘要"
        );
    }
    Ok(())
}

#[test]
fn whitespace_and_key_order_do_not_change_the_signed_digest() -> TestResult {
    // 1. JCS 键序与空白无关
    let a = quetzalcoatl_domains::canonicalize_json_str(r#"{ "b": 2, "a": 1 }"#)?;
    let b = quetzalcoatl_domains::canonicalize_json_str(r#"{"a":1,"b":2}"#)?;
    assert_eq!(a, b);
    assert_eq!(a, r#"{"a":1,"b":2}"#);

    // RFC 8785 按 UTF-16 码元序：大写字母 < 小写字母 < 带重音字符
    let sorted = quetzalcoatl_domains::canonicalize_json_str(r#"{"é":3,"a":2,"B":1}"#)?;
    assert_eq!(sorted, r#"{"B":1,"a":2,"é":3}"#);

    // 最短转义
    let escaped = quetzalcoatl_domains::canonicalize_json_value(&serde_json::json!({
        "t": "line\nbreak\t\"quote\"\\"
    }))?;
    assert_eq!(escaped, r#"{"t":"line\nbreak\t\"quote\"\\"}"#);

    // 浮点数一律拒绝
    let float_err = quetzalcoatl_domains::canonicalize_json_str(r#"{"micros": 1.5}"#)
        .err()
        .ok_or("JCS 必须拒绝浮点数")?;
    assert_eq!(float_err.code().as_str(), "SERIALIZATION_ERROR");

    // 2. 磁盘 pack.json 增加无意义空白后仍然通过监护人签名校验
    let raw =
        fs::read_to_string(repo_root()?.join("packages/domains/eldercare-guardian/pack.json"))?;
    let whitespace_reshaped = raw.replace("\n  ", "\n        ");
    assert_ne!(raw, whitespace_reshaped);
    let mut registry = DomainPackRegistry::new(DomainPackId::parse("personal-companion")?);
    for key in quetzalcoatl_domains::builtin_guardian_keys() {
        registry.trust_guardian(key);
    }
    registry.install_json(&whitespace_reshaped)?;
    Ok(())
}

#[test]
fn routine_outbound_obeys_quiet_hours_channel_caps_budget_and_partition_queue() -> TestResult {
    let registry = on_disk_registry()?;
    let companion = registry.get(&DomainPackId::parse("personal-companion")?)?;
    let mut supervisor = quetzalcoatl_domains::SafetySupervisor::new(companion);
    let mut heart = HeartScheduler::new(7, 0.05, quetzalcoatl_kernel::SleepPhase::Awake);
    let witnessed = quetzalcoatl_kernel::LeasePosture::Witnessed {
        witness_epoch: quetzalcoatl_types::Epoch::new(1),
    };

    // 静默时段 22:00-07:00 内一律抑制
    let quiet = supervisor.route_outbound(
        &routine("telegram", "深夜推销式问候"),
        &mut heart,
        23.0,
        witnessed,
        1_795_400_000_000,
        0,
    )?;
    assert_eq!(
        quiet.outcome,
        quetzalcoatl_domains::OutboundOutcome::Suppressed(
            quetzalcoatl_domains::SuppressionReason::QuietHours
        )
    );

    // 每通道每小时 4 条：第 5 条被抑制
    let base = 1_795_400_000_000;
    for offset in 0..4u64 {
        let decision = supervisor.route_outbound(
            &routine("telegram", "正常问候"),
            &mut heart,
            10.0,
            witnessed,
            base + offset * 1_000,
            0,
        )?;
        assert_eq!(
            decision.outcome,
            quetzalcoatl_domains::OutboundOutcome::Delivered
        );
    }
    let capped = supervisor.route_outbound(
        &routine("telegram", "第 5 条"),
        &mut heart,
        10.0,
        witnessed,
        base + 4_000,
        0,
    )?;
    assert_eq!(
        capped.outcome,
        quetzalcoatl_domains::OutboundOutcome::Suppressed(
            quetzalcoatl_domains::SuppressionReason::ChannelFrequencyCap
        )
    );
    // 窗口滑过 1 小时后恢复
    let recovered = supervisor.route_outbound(
        &routine("telegram", "一小时后"),
        &mut heart,
        10.0,
        witnessed,
        base + 3_600_001,
        0,
    )?;
    assert_eq!(
        recovered.outcome,
        quetzalcoatl_domains::OutboundOutcome::Delivered
    );

    // 预算硬上限 2_000_000 微单位
    let mut budget_supervisor = quetzalcoatl_domains::SafetySupervisor::new(companion);
    let first = budget_supervisor.route_outbound(
        &routine("telegram", "昂贵的一次外发"),
        &mut heart,
        10.0,
        witnessed,
        base,
        1_500_000,
    )?;
    assert_eq!(
        first.outcome,
        quetzalcoatl_domains::OutboundOutcome::Delivered
    );
    let over_budget = budget_supervisor.route_outbound(
        &routine("telegram", "超预算外发"),
        &mut heart,
        10.0,
        witnessed,
        base + 1,
        600_000,
    )?;
    assert_eq!(
        over_budget.outcome,
        quetzalcoatl_domains::OutboundOutcome::Suppressed(
            quetzalcoatl_domains::SuppressionReason::BudgetCeilingExhausted
        )
    );
    assert_eq!(budget_supervisor.budget_spent_micros(), 1_500_000);

    // 断网分区下非幂等公网例行外发进入 Outbox 语义（本层直接抑制）
    let mut partition_supervisor = quetzalcoatl_domains::SafetySupervisor::new(companion);
    let partitioned = partition_supervisor.route_outbound(
        &quetzalcoatl_domains::OutboundRequest {
            kind: quetzalcoatl_domains::OutboundKind::RoutineMessage,
            channel_id: String::from("telegram"),
            recipient_ids: vec![String::from("contact:companion-self")],
            text: String::from("离线待发"),
            is_non_idempotent_public: true,
        },
        &mut heart,
        10.0,
        quetzalcoatl_kernel::LeasePosture::PartitionLocal,
        base,
        0,
    )?;
    assert_eq!(
        partitioned.outcome,
        quetzalcoatl_domains::OutboundOutcome::Suppressed(
            quetzalcoatl_domains::SuppressionReason::PartitionLocalPublicQueue
        )
    );
    Ok(())
}

#[test]
fn unknown_channel_and_oversized_recipient_lists_are_permission_denied() -> TestResult {
    let registry = on_disk_registry()?;
    let companion = registry.get(&DomainPackId::parse("personal-companion")?)?;
    let mut supervisor = quetzalcoatl_domains::SafetySupervisor::new(companion);
    let mut heart = HeartScheduler::new(11, 0.05, quetzalcoatl_kernel::SleepPhase::Awake);
    let witnessed = quetzalcoatl_kernel::LeasePosture::Witnessed {
        witness_epoch: quetzalcoatl_types::Epoch::new(1),
    };

    let unknown = supervisor
        .route_outbound(
            &routine("carrier-pigeon", "未登记通道"),
            &mut heart,
            10.0,
            witnessed,
            1_795_400_000_000,
            0,
        )
        .err()
        .ok_or("未登记通道必须被拒绝")?;
    assert_eq!(unknown.code().as_str(), "PERMISSION_DENIED");

    let oversized = supervisor
        .route_outbound(
            &quetzalcoatl_domains::OutboundRequest {
                kind: quetzalcoatl_domains::OutboundKind::RoutineMessage,
                channel_id: String::from("telegram"),
                recipient_ids: vec![
                    String::from("contact:a"),
                    String::from("contact:b"),
                    String::from("contact:c"),
                ],
                text: String::from("群发"),
                is_non_idempotent_public: false,
            },
            &mut heart,
            10.0,
            witnessed,
            1_795_400_000_000,
            0,
        )
        .err()
        .ok_or("超过信封收件人上限必须被拒绝")?;
    assert_eq!(oversized.code().as_str(), "PERMISSION_DENIED");
    Ok(())
}

#[test]
fn domain_pack_id_rejects_ambiguous_forms() -> TestResult {
    for bad in [
        "",
        "A",
        "Personal-Companion",
        "-abc",
        "abc-",
        "a--b",
        "has space",
        "x",
    ] {
        let err = DomainPackId::parse(bad)
            .err()
            .ok_or_else(|| format!("非法领域包 ID `{bad}` 必须被拒绝"))?;
        assert_eq!(err.code().as_str(), "INVALID_ID");
    }
    let ok = DomainPackId::parse("edercare-guardian-2")?;
    assert_eq!(ok.as_str(), "edercare-guardian-2");
    assert_eq!(
        DomainPackId::parse("  personal-companion  ")?.as_str(),
        "personal-companion"
    );
    Ok(())
}

#[test]
fn registry_rejects_duplicate_guardian_relabel_and_untrusted_switch() -> TestResult {
    let mut registry = on_disk_registry()?;
    let agent = quetzalcoatl_types::AgentId::new_v4();

    // 未登记的监护人不会凭空获得信任
    registry.trust_guardian(GuardianKey::new("00".repeat(32), "guardian:attacker"));
    assert_eq!(registry.guardians().len(), 6);

    // 切换未知包必须类型化失败
    let err = registry
        .use_pack(
            agent,
            &DomainPackId::parse("ghost-domain")?,
            1_795_400_000_000,
            "unknown",
        )
        .err()
        .ok_or("未知领域包必须报错")?;
    assert_eq!(err.code().as_str(), "INVALID_ID");
    assert!(registry.audit_log().is_empty());
    Ok(())
}

fn routine(channel: &str, text: &str) -> quetzalcoatl_domains::OutboundRequest {
    quetzalcoatl_domains::OutboundRequest {
        kind: quetzalcoatl_domains::OutboundKind::RoutineMessage,
        channel_id: String::from(channel),
        recipient_ids: vec![String::from("contact:companion-self")],
        text: String::from(text),
        is_non_idempotent_public: false,
    }
}
