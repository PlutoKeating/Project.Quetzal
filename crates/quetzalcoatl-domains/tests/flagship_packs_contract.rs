#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 五大标杆领域包契约：磁盘装载、演示信任锚钉扎、JCS 规范化、监护人信封外发门禁、
//! 配额跨重启持久化与领域包 ID/清单校验。

use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing, hex_encode};
use quetzalcoatl_domains::{
    DomainPack, DomainPackId, DomainPackRegistry, FLAGSHIP_DOMAIN_IDS, GuardianKey,
    MemorySafetySink, OutboundContext, OutboundKind, OutboundOutcome, OutboundRequest,
    PackSwitchOutcome, SafetyEnvelope, SafetySupervisor, SpineSafetySink, SuppressionReason,
};
use quetzalcoatl_kernel::{HeartScheduler, LeasePosture, SleepPhase};
use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, HlcTimestamp};

type TestResult = Result<(), Box<dyn Error>>;

const NOW_MS: u64 = 1_795_400_000_000;
const HOUR_MS: u64 = 3_600_000;

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
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

fn temp_home(tag: &str) -> PathBuf {
    let parent = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    let uid = uuid::Uuid::new_v4().simple().to_string();
    let path = parent.join(format!("qz_domains_{tag}_{}", &uid[..12]));
    let _ = fs::create_dir_all(&path);
    path
}

fn temp_spine(home: &Path) -> Result<SpineEngine<RusqliteWalStore>, Box<dyn Error>> {
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::from_bytes([0x3cu8; 32]);
    let device = DeviceIdentity::from_seeds(DeviceId::new_v4(), [0x11u8; 32], [0x22u8; 32])?;
    let epoch_ring = EpochKeyRing::new_genesis(agent_id, &root_key, device.public_record())?;
    let store = RusqliteWalStore::open(&home.join("spine.sqlite"))?;
    Ok(SpineEngine::new(
        agent_id,
        device,
        epoch_ring,
        HlcTimestamp::from_parts(NOW_MS, 0, 1),
        store,
    )?)
}

fn ctx<'a>(
    heart: &'a mut HeartScheduler,
    local_hour: f64,
    lease: LeasePosture,
    now_ms: u64,
    estimated_cost_micros: u64,
) -> OutboundContext<'a> {
    OutboundContext {
        heart,
        local_hour,
        lease,
        now_ms,
        estimated_cost_micros,
    }
}

fn routine(channel: &str, text: &str) -> OutboundRequest {
    OutboundRequest {
        kind: OutboundKind::RoutineMessage,
        channel_id: String::from(channel),
        recipient_ids: vec![String::from("contact:companion-self")],
        text: String::from(text),
        is_non_idempotent_public: false,
    }
}

fn emergency(channel: &str, recipients: &[&str], text: &str) -> OutboundRequest {
    OutboundRequest {
        kind: OutboundKind::EmergencyAlert,
        channel_id: String::from(channel),
        recipient_ids: recipients.iter().map(|r| String::from(*r)).collect(),
        text: String::from(text),
        is_non_idempotent_public: true,
    }
}

fn pubkey_hex(seed: &[u8; 32]) -> String {
    let sk = ed25519_dalek::SigningKey::from_bytes(seed);
    hex_encode(sk.verifying_key().as_bytes())
}

/// 用合成监护人密钥重签领域包（仅用于构造负面夹具）。
fn resign(pack: &mut DomainPack, seed: &[u8; 32]) -> TestResult {
    let mut payload = pack.safety_envelope.payload.clone();
    payload.guardian_key_id = pubkey_hex(seed);
    payload.pack_blake3_hex = pack.body_digest_hex()?;
    pack.safety_envelope = SafetyEnvelope::sign(payload, seed)?;
    Ok(())
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

        // 声明语言必须覆盖被签署信封的主语言（不得宣称未签署的语言）
        assert!(
            pack.locales
                .iter()
                .any(|l| l == &pack.safety_envelope.payload.locale),
            "{id} 声明的 locales {:?} 未包含信封主语言 {}",
            pack.locales,
            pack.safety_envelope.payload.locale
        );

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
                !envelope.payload.emergency.escalation_channels.is_empty(),
                "{id} 启用紧急告警必须声明升级通道白名单"
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

        // README 必须真实存在并说明拒绝行为、启用方式与实机执行边界
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
            readme.contains("本版本仅完成领域包的声明、校验与切换审计"),
            "{id} README 缺少实机执行边界声明"
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
fn embedded_pack_documents_and_demo_trust_table_are_in_sync() -> TestResult {
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

        // 演示信任锚钉扎表必须与内嵌正文的真实摘要一致（改包必须同步重算该表）
        let value: serde_json::Value = serde_json::from_str(content)?;
        let mut body = value.clone();
        body.as_object_mut()
            .ok_or("pack.json 顶层必须是对象")?
            .remove("safetyEnvelope");
        let digest = hex_encode(&quetzalcoatl_domains::blake3_jcs_digest(
            quetzalcoatl_domains::manifest::PACK_BODY_DIGEST_CONTEXT,
            &body,
        )?);
        let pinned = quetzalcoatl_domains::demo_keys::builtin_trusted_body_digest(id)
            .ok_or_else(|| format!("演示信任锚缺少 {id} 的钉扎摘要"))?;
        assert_eq!(
            pinned, digest,
            "演示信任锚钉扎摘要与内置正文不一致：请把新摘要写入 demo_keys::BUILTIN_TRUSTED_BODY_DIGESTS"
        );
    }
    Ok(())
}

#[test]
fn demo_guardian_keys_only_trust_the_pinned_embedded_documents() -> TestResult {
    let mut registry = DomainPackRegistry::with_builtin_packs()?;
    let demo_seed = quetzalcoatl_domains::demo_guardian_seed("software-engineering");

    // 用演示密钥签署一份"内置包 + 多授权一个高危外发能力"的正文：签名数学有效，
    // 但正文摘要不在钉扎表内，必须被拒绝并指引操作者改用监护人自持密钥。
    let mut forged = registry
        .get(&DomainPackId::parse("software-engineering")?)?
        .clone();
    forged
        .role_tool_whitelist
        .push(String::from("world.public_dispatch"));
    resign(&mut forged, &demo_seed)?;
    let err = registry
        .install_pack_object(&forged)
        .err()
        .ok_or("演示密钥不得为任意新正文背书")?;
    assert_eq!(err.code().as_str(), "PERMISSION_DENIED");
    assert!(
        err.to_string().contains("监护人"),
        "拒绝必须指引改用监护人自持密钥，实际: {err}"
    );

    // 未在钉扎表中的领域包 ID 同样不得借演示密钥装载
    let mut foreign = forged.clone();
    foreign.id = String::from("demo-forged-foreign");
    foreign.safety_envelope.payload.pack_id = String::from("demo-forged-foreign");
    resign(&mut foreign, &demo_seed)?;
    assert_eq!(
        registry
            .install_pack_object(&foreign)
            .err()
            .map(|e| e.code().as_str().to_owned()),
        Some(String::from("PERMISSION_DENIED"))
    );
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

    // 2. 超出 IEEE-754 安全整数（2^53）的值必须被拒绝，避免跨语言静默截断
    let big = quetzalcoatl_domains::canonicalize_json_str(r#"{"n": 9007199254740993}"#)
        .err()
        .ok_or("JCS 必须拒绝超过 2^53 的整数")?;
    assert_eq!(big.code().as_str(), "SERIALIZATION_ERROR");
    assert!(
        big.to_string().contains("2^53") || big.to_string().contains("9007199254740992"),
        "错误信息必须说明安全整数上限，实际: {big}"
    );
    // 边界值 2^53 本身是安全的
    quetzalcoatl_domains::canonicalize_json_str(r#"{"n": 9007199254740992}"#)?;

    // 3. 磁盘 pack.json 增加无意义空白后仍然通过监护人签名校验
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
    let mut supervisor = SafetySupervisor::new(companion);
    let mut sink = MemorySafetySink::new();
    let mut heart = HeartScheduler::new(7, 0.05, SleepPhase::Awake);
    let witnessed = LeasePosture::Witnessed {
        witness_epoch: quetzalcoatl_types::Epoch::new(1),
    };

    // 静默时段 22:00-07:00 内一律抑制
    let quiet = supervisor.route_outbound(
        &routine("telegram", "深夜推销式问候"),
        &mut ctx(&mut heart, 23.0, witnessed, NOW_MS, 0),
        &mut sink,
    )?;
    assert_eq!(
        quiet.outcome,
        OutboundOutcome::Suppressed(SuppressionReason::QuietHours)
    );

    // 每通道每小时 4 条：第 5 条被抑制
    for offset in 0..4u64 {
        let decision = supervisor.route_outbound(
            &routine("telegram", "正常问候"),
            &mut ctx(&mut heart, 10.0, witnessed, NOW_MS + offset * 1_000, 0),
            &mut sink,
        )?;
        assert_eq!(decision.outcome, OutboundOutcome::Delivered);
    }
    let capped = supervisor.route_outbound(
        &routine("telegram", "第 5 条"),
        &mut ctx(&mut heart, 10.0, witnessed, NOW_MS + 4_000, 0),
        &mut sink,
    )?;
    assert_eq!(
        capped.outcome,
        OutboundOutcome::Suppressed(SuppressionReason::ChannelFrequencyCap)
    );
    // 窗口滑过 1 小时后恢复
    let recovered = supervisor.route_outbound(
        &routine("telegram", "一小时后"),
        &mut ctx(&mut heart, 10.0, witnessed, NOW_MS + HOUR_MS + 1, 0),
        &mut sink,
    )?;
    assert_eq!(recovered.outcome, OutboundOutcome::Delivered);

    // 预算硬上限 2_000_000 微单位
    let mut budget_supervisor = SafetySupervisor::new(companion);
    let mut budget_sink = MemorySafetySink::new();
    let first = budget_supervisor.route_outbound(
        &routine("telegram", "昂贵的一次外发"),
        &mut ctx(&mut heart, 10.0, witnessed, NOW_MS, 1_500_000),
        &mut budget_sink,
    )?;
    assert_eq!(first.outcome, OutboundOutcome::Delivered);
    let over_budget = budget_supervisor.route_outbound(
        &routine("telegram", "超预算外发"),
        &mut ctx(&mut heart, 10.0, witnessed, NOW_MS + 1, 600_000),
        &mut budget_sink,
    )?;
    assert_eq!(
        over_budget.outcome,
        OutboundOutcome::Suppressed(SuppressionReason::BudgetCeilingExhausted)
    );
    assert_eq!(budget_supervisor.budget_spent_micros(), 1_500_000);

    // 断网分区下非幂等公网例行外发进入 Outbox 语义（本层直接抑制）
    let mut partition_supervisor = SafetySupervisor::new(companion);
    let partitioned = partition_supervisor.route_outbound(
        &OutboundRequest {
            kind: OutboundKind::RoutineMessage,
            channel_id: String::from("telegram"),
            recipient_ids: vec![String::from("contact:companion-self")],
            text: String::from("离线待发"),
            is_non_idempotent_public: true,
        },
        &mut ctx(&mut heart, 10.0, LeasePosture::PartitionLocal, NOW_MS, 0),
        &mut sink,
    )?;
    assert_eq!(
        partitioned.outcome,
        OutboundOutcome::Suppressed(SuppressionReason::PartitionLocalPublicQueue)
    );
    Ok(())
}

#[test]
fn emergency_escalation_channels_and_recipient_caps_are_enforced() -> TestResult {
    let registry = on_disk_registry()?;
    let eldercare = registry.get(&DomainPackId::parse("eldercare-guardian")?)?;
    let witnessed = LeasePosture::Witnessed {
        witness_epoch: quetzalcoatl_types::Epoch::new(1),
    };

    // 监护人只授权 local_siren / telegram 升级：未声明的通道必须拒绝
    let mut sup = SafetySupervisor::new(eldercare);
    let mut sink = MemorySafetySink::new();
    let mut heart = HeartScheduler::new(9, 0.9, SleepPhase::Asleep);
    let denied = sup
        .route_outbound(
            &emergency(
                "feishu",
                &["contact:guardian-primary"],
                "通过未授权通道升级",
            ),
            &mut ctx(&mut heart, 10.0, witnessed, NOW_MS, 0),
            &mut sink,
        )
        .err()
        .ok_or("未声明的紧急升级通道必须被拒绝")?;
    assert_eq!(denied.code().as_str(), "PERMISSION_DENIED");
    assert!(
        denied.to_string().contains("升级") || denied.to_string().contains("escalation"),
        "拒绝信息必须说明升级通道未被授权，实际: {denied}"
    );

    // 声明通道内允许
    let allowed = sup.route_outbound(
        &emergency("local_siren", &["contact:guardian-primary"], "本地警笛升级"),
        &mut ctx(&mut heart, 10.0, witnessed, NOW_MS, 0),
        &mut sink,
    )?;
    assert_eq!(allowed.outcome, OutboundOutcome::Delivered);

    // 单条消息收件人上限对紧急路径同样生效（把上限压到 1 的合成信封夹具）
    let mut strict = eldercare.clone();
    strict
        .safety_envelope
        .payload
        .outbound
        .max_recipients_per_message = 1;
    let mut strict_sup = SafetySupervisor::new(&strict);
    let overflow = strict_sup
        .route_outbound(
            &emergency(
                "local_siren",
                &["contact:guardian-primary", "contact:guardian-backup"],
                "同时通知两位监护人",
            ),
            &mut ctx(&mut heart, 10.0, witnessed, NOW_MS, 0),
            &mut sink,
        )
        .err()
        .ok_or("超过信封收件人上限的紧急告警必须被拒绝")?;
    assert_eq!(overflow.code().as_str(), "PERMISSION_DENIED");
    assert!(
        overflow.to_string().contains("收件人"),
        "拒绝信息必须说明收件人上限，实际: {overflow}"
    );
    Ok(())
}

#[test]
fn quota_state_survives_restart_and_daily_window_rollover() -> TestResult {
    let home = temp_home("quota");
    let mut spine = temp_spine(&home)?;
    let registry = on_disk_registry()?;
    let companion = registry.get(&DomainPackId::parse("personal-companion")?)?;
    let witnessed = LeasePosture::Witnessed {
        witness_epoch: quetzalcoatl_types::Epoch::new(1),
    };
    let mut heart = HeartScheduler::new(13, 0.05, SleepPhase::Awake);

    // 第一个进程：15 小时窗口内打满每日 16 条上限（每小时 4 条）
    {
        let mut sink = SpineSafetySink::new(&mut spine);
        let mut supervisor = SafetySupervisor::restore(companion, &mut sink)?;
        for hour in 0..4u64 {
            for idx in 0..4u64 {
                let now = NOW_MS + hour * HOUR_MS + idx * 1_000;
                let mut ctx = OutboundContext {
                    heart: &mut heart,
                    local_hour: 10.0,
                    lease: witnessed,
                    now_ms: now,
                    estimated_cost_micros: 10_000,
                };
                let decision = supervisor.route_outbound(
                    &routine("telegram", "配额消耗"),
                    &mut ctx,
                    &mut sink,
                )?;
                assert_eq!(decision.outcome, OutboundOutcome::Delivered);
            }
        }
    }

    // 第二个进程（重启）：配额计数必须从脊柱恢复，下一小时仍被每日上限拒绝
    {
        let mut sink = SpineSafetySink::new(&mut spine);
        let mut supervisor = SafetySupervisor::restore(companion, &mut sink)?;
        assert_eq!(
            supervisor.budget_spent_micros(),
            16 * 10_000,
            "预算消耗必须跨重启恢复"
        );
        let denied = supervisor.route_outbound(
            &routine("telegram", "重启后仍应被拒绝"),
            &mut ctx(&mut heart, 10.0, witnessed, NOW_MS + 5 * HOUR_MS, 10_000),
            &mut sink,
        )?;
        assert_eq!(
            denied.outcome,
            OutboundOutcome::Suppressed(SuppressionReason::ChannelFrequencyCap),
            "重启绝不可重置监护人的每日外发硬上限"
        );
    }

    // 第三个进程：跨过 24 小时窗口后配额恢复
    {
        let mut sink = SpineSafetySink::new(&mut spine);
        let mut supervisor = SafetySupervisor::restore(companion, &mut sink)?;
        let allowed = supervisor.route_outbound(
            &routine("telegram", "新一天恢复额度"),
            &mut ctx(
                &mut heart,
                10.0,
                witnessed,
                NOW_MS + 24 * HOUR_MS + 1,
                10_000,
            ),
            &mut sink,
        )?;
        assert_eq!(
            allowed.outcome,
            OutboundOutcome::Delivered,
            "跨过 24 小时窗口后必须恢复额度"
        );
    }

    let _ = fs::remove_dir_all(&home);
    Ok(())
}

#[test]
fn pack_validation_rejects_bad_envelopes_and_accepts_camel_case_rule_aliases() -> TestResult {
    let mut registry = DomainPackRegistry::new(DomainPackId::parse("personal-companion")?);
    let guardian_seed = [0x5au8; 32];
    registry.trust_guardian(GuardianKey::new(
        pubkey_hex(&guardian_seed),
        "guardian:test-fixture",
    ));
    let base = on_disk_registry()?
        .get(&DomainPackId::parse("personal-companion")?)?
        .clone();

    // 1. QuietHours 越界（> 23）必须被拒绝，而不是静默 `% 24`
    let mut bad_quiet = base.clone();
    bad_quiet
        .safety_envelope
        .payload
        .outbound
        .quiet_hours
        .start_local_hour = 25;
    resign(&mut bad_quiet, &guardian_seed)?;
    let quiet_err = registry
        .install_pack_object(&bad_quiet)
        .err()
        .ok_or("QuietHours 起始小时 25 必须被拒绝")?;
    assert_eq!(quiet_err.code().as_str(), "INVALID_ID");
    assert!(quiet_err.to_string().contains("QuietHours"));

    // 2. requiredCapabilities 必须是角色工具白名单的子集
    let mut bad_caps = base.clone();
    bad_caps
        .required_capabilities
        .push(String::from("ghost.capability"));
    resign(&mut bad_caps, &guardian_seed)?;
    let caps_err = registry
        .install_pack_object(&bad_caps)
        .err()
        .ok_or("requiredCapabilities 越出角色工具白名单必须被拒绝")?;
    assert_eq!(caps_err.code().as_str(), "INVALID_ID");
    assert!(caps_err.to_string().contains("ghost.capability"));

    // 3. 信封主语言必须落在 pack.locales 内
    let mut bad_locale = base.clone();
    bad_locale.safety_envelope.payload.locale = String::from("fr-FR");
    resign(&mut bad_locale, &guardian_seed)?;
    let locale_err = registry
        .install_pack_object(&bad_locale)
        .err()
        .ok_or("信封主语言不在 locales 内必须被拒绝")?;
    assert_eq!(locale_err.code().as_str(), "INVALID_ID");
    assert!(locale_err.to_string().contains("locale") || locale_err.to_string().contains("语言"));

    // 4. 规则字段向后兼容 camelCase 别名，且序列化统一输出 snake_case
    let raw =
        fs::read_to_string(repo_root()?.join("packages/domains/youth-socratic-tutor/pack.json"))?;
    let camel = raw
        .replace("\"directive_id\"", "\"directiveId\"")
        .replace("\"min_questions\"", "\"minQuestions\"")
        .replace("\"final_answer_markers\"", "\"finalAnswerMarkers\"");
    assert_ne!(raw, camel);
    let mut pack: DomainPack = serde_json::from_str(&camel)?;
    resign(&mut pack, &guardian_seed)?;
    registry.install_pack_object(&pack)?;
    let emitted = serde_json::to_value(&pack.verifier_rules[0])?;
    assert!(
        emitted.get("directive_id").is_some(),
        "领域包规则必须统一输出 snake_case 字段"
    );
    assert!(emitted.get("directiveId").is_none());
    Ok(())
}

#[test]
fn unknown_channel_and_oversized_recipient_lists_are_permission_denied() -> TestResult {
    let registry = on_disk_registry()?;
    let companion = registry.get(&DomainPackId::parse("personal-companion")?)?;
    let mut supervisor = SafetySupervisor::new(companion);
    let mut sink = MemorySafetySink::new();
    let mut heart = HeartScheduler::new(11, 0.05, SleepPhase::Awake);
    let witnessed = LeasePosture::Witnessed {
        witness_epoch: quetzalcoatl_types::Epoch::new(1),
    };

    let unknown = supervisor
        .route_outbound(
            &routine("carrier-pigeon", "未登记通道"),
            &mut ctx(&mut heart, 10.0, witnessed, NOW_MS, 0),
            &mut sink,
        )
        .err()
        .ok_or("未登记通道必须被拒绝")?;
    assert_eq!(unknown.code().as_str(), "PERMISSION_DENIED");

    let oversized = supervisor
        .route_outbound(
            &OutboundRequest {
                kind: OutboundKind::RoutineMessage,
                channel_id: String::from("telegram"),
                recipient_ids: vec![
                    String::from("contact:a"),
                    String::from("contact:b"),
                    String::from("contact:c"),
                ],
                text: String::from("群发"),
                is_non_idempotent_public: false,
            },
            &mut ctx(&mut heart, 10.0, witnessed, NOW_MS, 0),
            &mut sink,
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
fn registry_rejects_untracked_guardian_and_idempotent_switch() -> TestResult {
    let mut registry = on_disk_registry()?;
    let agent = AgentId::new_v4();

    // 未登记的监护人不会凭空获得信任
    registry.trust_guardian(GuardianKey::new("00".repeat(32), "guardian:attacker"));
    assert_eq!(registry.guardians().len(), 6);

    // 首次切换 = Activated，重复切换 = Unchanged（不得重复签发审计）
    match registry.use_pack(
        agent,
        &DomainPackId::parse("eldercare-guardian")?,
        NOW_MS,
        "启用看护",
    )? {
        PackSwitchOutcome::Activated(audit) => assert_eq!(audit.to_pack_id, "eldercare-guardian"),
        PackSwitchOutcome::Unchanged { .. } => return Err("首次切换必须留痕".into()),
    }
    match registry.use_pack(
        agent,
        &DomainPackId::parse("eldercare-guardian")?,
        NOW_MS + 1,
        "重复启用",
    )? {
        PackSwitchOutcome::Unchanged { active_pack_id } => {
            assert_eq!(active_pack_id, "eldercare-guardian")
        }
        PackSwitchOutcome::Activated(_) => return Err("重复切换不得追加审计".into()),
    }
    assert_eq!(registry.audit_log().len(), 1);

    // 切换未知包必须类型化失败且不改变审计
    let err = registry
        .use_pack(
            agent,
            &DomainPackId::parse("ghost-domain")?,
            NOW_MS + 2,
            "unknown",
        )
        .err()
        .ok_or("未知领域包必须报错")?;
    assert_eq!(err.code().as_str(), "INVALID_ID");
    assert_eq!(registry.audit_log().len(), 1);
    Ok(())
}
