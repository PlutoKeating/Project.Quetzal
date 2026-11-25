use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;

use quetzalcoatl_types::{
    AgentId, ArtifactId, DeviceId, Epoch, ErrorCode, HlcTimestamp, QuetzalcoatlError, RunId,
    ThreadId,
};

type TestResult = Result<(), Box<dyn Error>>;

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("无法定位工作区根目录")?;
    Ok(root.to_path_buf())
}

#[test]
fn deny_toml_blocks_gpl_and_agpl_licenses() -> TestResult {
    let root = repo_root()?;
    let deny_path = root.join("deny.toml");
    let raw = fs::read_to_string(&deny_path)?;
    let parsed: toml::Value = toml::from_str(&raw)?;

    let allow = parsed
        .get("licenses")
        .and_then(|l| l.get("allow"))
        .and_then(toml::Value::as_array)
        .ok_or("deny.toml 缺少 [licenses].allow 数组")?;

    for item in allow {
        let spdx = item.as_str().ok_or("allow 项必须为字符串")?;
        assert!(
            !spdx.starts_with("GPL-")
                && !spdx.starts_with("AGPL-")
                && !spdx.starts_with("LGPL-3.0")
                && !spdx.starts_with("SSPL"),
            "deny.toml 严禁放行强传染许可证: {spdx}"
        );
    }

    let unknown_registry = parsed
        .get("sources")
        .and_then(|s| s.get("unknown-registry"))
        .and_then(toml::Value::as_str);
    assert_eq!(unknown_registry, Some("deny"));

    let unknown_git = parsed
        .get("sources")
        .and_then(|s| s.get("unknown-git"))
        .and_then(toml::Value::as_str);
    assert_eq!(unknown_git, Some("deny"));

    let wildcards = parsed
        .get("bans")
        .and_then(|b| b.get("wildcards"))
        .and_then(toml::Value::as_str);
    assert_eq!(wildcards, Some("deny"));

    // 实测调用 cargo-deny：验证 GPL-2.0-only、GPL-3.0-only、AGPL-3.0-only 被真实阻断，而 Apache-2.0 通过
    let probe_base = std::env::temp_dir().join(format!("qz_deny_probe_{}", std::process::id()));
    for (forbidden, should_pass) in [
        ("GPL-2.0-only", false),
        ("GPL-3.0-only", false),
        ("AGPL-3.0-only", false),
        ("Apache-2.0", true),
    ] {
        let dir = probe_base.join(forbidden.replace('.', "_"));
        fs::create_dir_all(dir.join("src"))?;
        fs::write(
            dir.join("Cargo.toml"),
            format!(
                "[package]\nname = \"qz-license-probe\"\nversion = \"0.1.0\"\nedition = \"2024\"\nlicense = \"{forbidden}\"\n"
            ),
        )?;
        fs::write(dir.join("src/lib.rs"), "")?;

        let status = Command::new("cargo")
            .args([
                "deny",
                "--manifest-path",
                &dir.join("Cargo.toml").to_string_lossy(),
                "--config",
                &deny_path.to_string_lossy(),
                "check",
                "licenses",
            ])
            .output()?;

        assert_eq!(
            status.status.success(),
            should_pass,
            "许可证 {forbidden} 的 cargo-deny 检查结果不符合预期: stderr={}",
            String::from_utf8_lossy(&status.stderr)
        );
    }
    let _ = fs::remove_dir_all(&probe_base);
    Ok(())
}

#[test]
fn workspace_enforces_forbid_unsafe_and_naming_conventions() -> TestResult {
    let root = repo_root()?;
    let root_cargo: toml::Value = toml::from_str(&fs::read_to_string(root.join("Cargo.toml"))?)?;

    let ws_pkg = root_cargo
        .get("workspace")
        .and_then(|w| w.get("package"))
        .ok_or("缺少 [workspace.package]")?;
    assert_eq!(
        ws_pkg.get("edition").and_then(toml::Value::as_str),
        Some("2024")
    );
    assert_eq!(
        ws_pkg.get("rust-version").and_then(toml::Value::as_str),
        Some("1.91")
    );
    assert_eq!(
        ws_pkg.get("license").and_then(toml::Value::as_str),
        Some("Apache-2.0")
    );

    let lints = root_cargo
        .get("workspace")
        .and_then(|w| w.get("lints"))
        .ok_or("缺少 [workspace.lints]")?;
    assert_eq!(
        lints
            .get("rust")
            .and_then(|r| r.get("unsafe_code"))
            .and_then(toml::Value::as_str),
        Some("forbid")
    );
    for lint_name in ["unwrap_used", "expect_used", "panic", "todo"] {
        assert_eq!(
            lints
                .get("clippy")
                .and_then(|c| c.get(lint_name))
                .and_then(toml::Value::as_str),
            Some("deny"),
            "workspace clippy.{lint_name} 必须设为 deny"
        );
    }

    let members = root_cargo
        .get("workspace")
        .and_then(|w| w.get("members"))
        .and_then(toml::Value::as_array)
        .ok_or("缺少 [workspace].members")?;
    assert!(!members.is_empty());

    for m in members {
        let rel = m.as_str().ok_or("member 路径必须为字符串")?;
        let crate_dir = root.join(rel);
        let crate_cargo: toml::Value =
            toml::from_str(&fs::read_to_string(crate_dir.join("Cargo.toml"))?)?;
        let pkg_name = crate_cargo
            .get("package")
            .and_then(|p| p.get("name"))
            .and_then(toml::Value::as_str)
            .ok_or("crate 缺少 package.name")?;
        assert!(
            pkg_name.starts_with("quetzalcoatl-"),
            "所有 Rust crate 必须以 quetzalcoatl- 为前缀，实际为: {pkg_name}"
        );
        let lib_rs = fs::read_to_string(crate_dir.join("src/lib.rs"))?;
        if rel.starts_with("crates/bindings/") {
            // 绑定层是唯一允许把 unsafe_code 从 forbid 收窄为 deny 的边界：
            // UniFFI / wasm-bindgen 宏必须生成 #[unsafe(no_mangle)] 导出符号，
            // 而 crate 级 forbid 无法被宏内部 allow 覆盖。
            // Cargo 不允许 `lints.workspace = true` 与逐项覆盖共存，因此这里强制要求
            // 绑定层**手工完整复刻**工作区 lint 集合，唯一差异是 unsafe_code = "deny"。
            // 手写代码零 unsafe 由各绑定 crate 的集成测试静态扫描保证，
            // 精确豁免文件/行记录在对应 crate 的 README。
            let lints = crate_cargo.get("lints").ok_or("绑定层缺少 [lints]")?;
            assert_ne!(
                lints.get("workspace").and_then(toml::Value::as_bool),
                Some(true),
                "{pkg_name} 绑定层不允许 lints.workspace = true（需逐项复刻以收窄 unsafe_code）"
            );
            assert_eq!(
                lints
                    .get("rust")
                    .and_then(|r| r.get("unsafe_code"))
                    .and_then(toml::Value::as_str),
                Some("deny"),
                "{pkg_name} 绑定层唯一允许的收窄是 [lints.rust] unsafe_code = \"deny\""
            );
            for lint_name in ["unwrap_used", "expect_used", "panic", "todo"] {
                assert_eq!(
                    lints
                        .get("clippy")
                        .and_then(|c| c.get(lint_name))
                        .and_then(toml::Value::as_str),
                    Some("deny"),
                    "{pkg_name} 绑定层必须复刻工作区 clippy.{lint_name} = deny"
                );
            }
            assert!(
                lib_rs.contains("#![deny(unsafe_code)]"),
                "{pkg_name}/src/lib.rs 绑定层必须显式声明 #![deny(unsafe_code)]"
            );
        } else {
            assert_eq!(
                crate_cargo
                    .get("lints")
                    .and_then(|l| l.get("workspace"))
                    .and_then(toml::Value::as_bool),
                Some(true),
                "{pkg_name} 必须声明 [lints] workspace = true"
            );
            assert!(
                lib_rs.contains("#![forbid(unsafe_code)]"),
                "{pkg_name}/src/lib.rs 必须显式包含 #![forbid(unsafe_code)]"
            );
        }
    }

    assert!(root.join("docs/V2_GOAL.html").is_file());
    assert!(root.join("AGENTS.md").is_file());
    assert!(root.join("LICENSE-APACHE").is_file());
    assert!(root.join("LICENSE-AGPL").is_file());
    Ok(())
}

#[test]
fn frozen_spec_vectors_and_v1_fixtures_are_complete_and_valid() -> TestResult {
    let root = repo_root()?;
    let vectors_dir = root.join("spec/vectors");

    // 1. opaque_rfc9807.json
    let opaque: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        vectors_dir.join("opaque_rfc9807.json"),
    )?)?;
    assert_eq!(opaque["schema_version"], 1);
    assert_eq!(opaque["suite"], "OPAQUE-Ristretto255-SHA512");
    assert_eq!(
        opaque["oprf_and_envelope"]["envelope_auth_tag_hex"]
            .as_str()
            .map(str::len),
        Some(128)
    );
    assert_eq!(
        opaque["ake_3dh"]["session_key_hex"].as_str().map(str::len),
        Some(128)
    );

    // 2. hpke_xwing.json
    let xwing: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(vectors_dir.join("hpke_xwing.json"))?)?;
    assert_eq!(xwing["schema_version"], 1);
    assert_eq!(xwing["hpke_ids"]["kem_id"], "0x647a");
    assert_eq!(
        xwing["kem"]["xwing_pk_hex"].as_str().map(str::len),
        Some(2432)
    );
    assert_eq!(
        xwing["kem"]["xwing_enc_hex"].as_str().map(str::len),
        Some(2240)
    );
    assert_eq!(xwing["seal_cases"].as_array().map(Vec::len), Some(2));

    // 3. spine_pack_aad.json
    let spine: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        vectors_dir.join("spine_pack_aad.json"),
    )?)?;
    assert_eq!(spine["schema_version"], 1);
    assert_eq!(spine["constants"]["zstd_max_window_log"], 20);
    assert_eq!(spine["constants"]["max_future_clock_drift_ms"], 300_000);
    let bucket_len = spine["packfile"]["padded_bucket_len"]
        .as_u64()
        .ok_or("缺少 padded_bucket_len")?;
    assert!(bucket_len >= 256 && bucket_len.is_power_of_two());

    // 4. anp_p9_mentions.json
    let mentions: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        vectors_dir.join("anp_p9_mentions.json"),
    )?)?;
    assert_eq!(mentions["schema_version"], 1);
    assert_eq!(mentions["constants"]["max_consecutive_agent_hops"], 3);
    let cases = mentions["floor_control_cases"]
        .as_array()
        .ok_or("缺少 floor_control_cases")?;
    assert!(cases.len() >= 6);

    // 5. V1 synthetic fixtures
    let fixtures_dir = root.join("crates/quetzalcoatl-spine/tests/fixtures");
    let soul_spec: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        fixtures_dir.join("v1_soul_v14/.soul-spec.json"),
    )?)?;
    assert_eq!(soul_spec["version"], 14);
    let memory_md = fs::read_to_string(fixtures_dir.join("v1_soul_v14/memories/MEMORY.md"))?;
    assert!(memory_md.contains("\n§\n"));
    let sample_sql = fs::read_to_string(fixtures_dir.join("v1_quetzal_sample.sql"))?;
    assert!(sample_sql.contains("3399359240601601"));
    assert!(sample_sql.contains("1489000737013761"));

    Ok(())
}

#[test]
fn hlc_timestamp_big_endian_roundtrip_monotonic_tick_and_drift_guard() -> TestResult {
    let t1 = HlcTimestamp::from_parts(1_795_400_000_000, 0, 0x0102_0304);
    assert_eq!(t1.wall_ms(), 1_795_400_000_000);
    assert_eq!(t1.logical(), 0);
    assert_eq!(t1.node_tag(), 0x0102_0304);

    // 固定 16 字节大端往返与字节字典序一致性
    let be1 = t1.to_be_bytes();
    assert_eq!(be1.len(), 16);
    assert_eq!(HlcTimestamp::from_be_bytes(be1), t1);

    let hex1 = t1.to_hex();
    assert_eq!(hex1.len(), 32);
    assert_eq!(HlcTimestamp::from_hex(&hex1)?, t1);

    let json1 = serde_json::to_string(&t1)?;
    let decoded1: HlcTimestamp = serde_json::from_str(&json1)?;
    assert_eq!(decoded1, t1);

    // 同一毫秒或时钟回拨下，单调 tick 必须严格递增逻辑计数
    let t2 = t1.tick(1_795_400_000_000, 0x0102_0304)?;
    assert!(t2 > t1);
    assert!(t2.to_be_bytes() > t1.to_be_bytes());
    assert_eq!(t2.wall_ms(), 1_795_400_000_000);
    assert_eq!(t2.logical(), 1);

    // 本机时钟回拨 500ms 时仍保持严格单调不回退
    let t3 = t2.tick(1_795_399_999_500, 0x0102_0304)?;
    assert!(t3 > t2);
    assert_eq!(t3.wall_ms(), 1_795_400_000_000);
    assert_eq!(t3.logical(), 2);

    // 本机物理时钟推进后逻辑计数器归零
    let t4 = t3.tick(1_795_400_000_005, 0x0102_0304)?;
    assert!(t4 > t3);
    assert_eq!(t4.wall_ms(), 1_795_400_000_005);
    assert_eq!(t4.logical(), 0);

    // 边界内远端时钟（恰好 +5m = 300_000ms）允许合入
    let local_now: u64 = 1_795_400_000_000;
    let remote_at_limit = HlcTimestamp::from_parts(
        local_now + HlcTimestamp::MAX_FUTURE_DRIFT_MS,
        7,
        0xaaaa_bbbb,
    );
    let merged = t4.observe_remote(remote_at_limit, local_now, 0x0102_0304)?;
    assert!(merged > remote_at_limit || merged.wall_ms() == remote_at_limit.wall_ms());
    assert_eq!(merged.logical(), 8);

    // 超出 +5m 容忍窗口（+5m + 1ms，以及 spec/vectors/spine_pack_aad.json 中的 +10m 投毒向量）必须硬拒收
    let remote_over_limit = HlcTimestamp::from_parts(
        local_now + HlcTimestamp::MAX_FUTURE_DRIFT_MS + 1,
        0,
        0xdead_beef,
    );
    let err = t4
        .observe_remote(remote_over_limit, local_now, 0x0102_0304)
        .err()
        .ok_or("超出 +5m 的远端 HLC 必须被拒绝")?;
    assert_eq!(err.code(), ErrorCode::ClockDriftExceeded);

    let root = repo_root()?;
    let spine_vec: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        root.join("spec/vectors/spine_pack_aad.json"),
    )?)?;
    let poison_case = &spine_vec["negative_cases"][2];
    let poison_hlc_hex = poison_case["remote_hlc_u128_hex"]
        .as_str()
        .ok_or("缺少 remote_hlc_u128_hex")?;
    let poison_local_ms = poison_case["local_trusted_wall_ms"]
        .as_u64()
        .ok_or("缺少 local_trusted_wall_ms")?;
    let poison_hlc = HlcTimestamp::from_hex(poison_hlc_hex)?;
    let poison_err = t1
        .observe_remote(poison_hlc, poison_local_ms, 0x0102_0304)
        .err()
        .ok_or("+10m 向量必须触发 ClockDriftExceeded")?;
    assert_eq!(
        poison_err.code().as_str(),
        poison_case["expected_error_code"].as_str().unwrap_or("")
    );

    Ok(())
}

#[test]
fn strongly_typed_ids_epoch_and_error_codes_roundtrip() -> TestResult {
    let agent = AgentId::from_str("018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f")?;
    assert_eq!(agent.to_string(), "018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f");
    assert_eq!(AgentId::from_bytes(*agent.as_bytes()), agent);

    let device = DeviceId::new_v4();
    let run = RunId::new_v4();
    let thread = ThreadId::new_v4();
    assert_ne!(device.as_bytes(), &[0u8; 16]);
    assert_eq!(
        serde_json::from_str::<RunId>(&serde_json::to_string(&run)?)?,
        run
    );
    assert_eq!(
        serde_json::from_str::<ThreadId>(&serde_json::to_string(&thread)?)?,
        thread
    );

    let bad_agent = AgentId::from_str("not-a-uuid")
        .err()
        .ok_or("非法 UUID 必须报错")?;
    assert_eq!(bad_agent.code(), ErrorCode::InvalidId);

    let digest_hex = "a3f1e2d4c5b6a7988796a5b4c3d2e1f00112233445566778899aabbccddeeff0";
    let artifact = ArtifactId::from_str(digest_hex)?;
    assert_eq!(artifact.to_hex(), digest_hex);
    assert_eq!(artifact.to_string(), digest_hex);
    assert_eq!(ArtifactId::from_bytes(*artifact.as_bytes()), artifact);
    assert_eq!(
        serde_json::from_str::<ArtifactId>(&serde_json::to_string(&artifact)?)?,
        artifact
    );

    let bad_artifact = ArtifactId::from_str("abcd")
        .err()
        .ok_or("长度不足 64 字符的哈希必须报错")?;
    assert_eq!(bad_artifact.code(), ErrorCode::InvalidId);

    let ep0 = Epoch::GENESIS;
    let ep1 = ep0.next()?;
    assert_eq!(ep1.get(), 1);
    assert_eq!(Epoch::from_be_bytes(ep1.to_be_bytes()), ep1);
    let overflow_err = Epoch::new(u64::MAX)
        .next()
        .err()
        .ok_or("Epoch::MAX.next() 必须返回溢出错误而非 panic")?;
    assert_eq!(overflow_err.code(), ErrorCode::EpochOverflow);

    let integrity_err = QuetzalcoatlError::IntegrityViolation {
        detail: String::from("AAD mismatch"),
    };
    assert_eq!(integrity_err.code(), ErrorCode::IntegrityViolation);
    assert_eq!(integrity_err.code().as_str(), "INTEGRITY_VIOLATION");

    Ok(())
}

#[test]
fn quetzalcoatl_error_is_deserialize_owned_and_roundtrips_across_ipc() -> TestResult {
    fn assert_deserialize_owned<T: serde::de::DeserializeOwned>() {}

    assert_deserialize_owned::<QuetzalcoatlError>();
    assert_deserialize_owned::<ErrorCode>();
    assert_deserialize_owned::<AgentId>();
    assert_deserialize_owned::<DeviceId>();
    assert_deserialize_owned::<RunId>();
    assert_deserialize_owned::<ThreadId>();
    assert_deserialize_owned::<ArtifactId>();
    assert_deserialize_owned::<Epoch>();
    assert_deserialize_owned::<HlcTimestamp>();

    let err_from_parse = AgentId::from_str("invalid-uuid-payload")
        .err()
        .ok_or("非法 UUID 必须产生错误")?;

    // 1. 动态堆分配 String / 字节切片 (from_slice) 往返
    let encoded_bytes = serde_json::to_vec(&err_from_parse)?;
    let decoded_from_slice: QuetzalcoatlError = serde_json::from_slice(&encoded_bytes)?;
    assert_eq!(decoded_from_slice, err_from_parse);

    // 2. serde_json::Value (from_value) 往返，含 JSON 转义字符的 kind 字段
    let escaped_json = serde_json::json!({
        "code": "INVALID_ID",
        "kind": "AgentId/\"quoted\"",
        "detail": "bad escape check\nline2"
    });
    let decoded_escaped: QuetzalcoatlError = serde_json::from_value(escaped_json)?;
    assert_eq!(decoded_escaped.code(), ErrorCode::InvalidId);

    let reencoded_str = serde_json::to_string(&decoded_escaped)?;
    let roundtripped: QuetzalcoatlError = serde_json::from_reader(reencoded_str.as_bytes())?;
    assert_eq!(roundtripped, decoded_escaped);

    Ok(())
}
