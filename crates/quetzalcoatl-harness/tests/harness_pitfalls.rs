#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing};
use quetzalcoatl_ewave::{
    AssemblyRequest, Authority, BudgetProfile, Conscience, ConscienceManifest, ContextAssembler,
    FocusConfig, MemoryEntry, MemoryKind, Mutability, ObserveOptions, ProtectedDirective,
    ProvenanceRecord, SerpentineGraph, ValueEntry,
};
use quetzalcoatl_harness::{
    AcpJsonRpcDriver, ClaudeCodeDriver, CodexDriver, CodingAgentKind, DiscoveryConfig,
    GatewayConfig, GatewaySessionConfig, HarnessDriver, HarnessEvent, HarnessLaunchContext,
    HttpsUpstreamTransport, LoopbackGateway, MANAGED_RUN_ENV, McpBridgeSession, OpenCodeDriver,
    PiDriver, WorktreeManager, can_probe_linux_secret_service, count_anthropic_cache_controls,
    discover_coding_agents, gemini_cli_env, host_oauth_available, matches_agent_version_signature,
    prepare_stripped_oauth_stubs,
};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityDescriptor, CapabilityOrigin, ExecutionSurface, HeartScheduler,
    LeasePosture, MovementOutcome, PrincipalRole, SinkClass, SleepPhase,
};
use quetzalcoatl_sandbox::{
    SandboxConfig, SandboxManager, UpstreamRequest, UpstreamResponse, UpstreamTransport,
};
use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, HlcTimestamp, Result as QzResult, RunId};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let parent = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
        let uid = Uuid::new_v4().simple().to_string();
        let path = parent.join(format!("{prefix}_{}", &uid[..12]));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(unix)]
fn write_executable_script(path: &Path, body: &str) -> Result<(), Box<dyn Error>> {
    fs::write(path, body)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

fn build_sample_conscience_and_graph() -> Result<(Conscience, SerpentineGraph), Box<dyn Error>> {
    let root_key = AccountRootKey::from_bytes([0x42; 32]);
    let root_directives = vec![ProtectedDirective {
        id: String::from("root-sovereignty"),
        authority: Authority::Root,
        title: String::from("主权红线"),
        content: String::from("严禁泄露宿主凭据或绕过洁净室校验。"),
        created_at_ms: 1_795_400_000_000,
    }];
    let operator_directives = vec![ProtectedDirective {
        id: String::from("op-engineering"),
        authority: Authority::Operator,
        title: String::from("工程纪律"),
        content: String::from("研发变更必须在隔离 Git Worktree 中执行。"),
        created_at_ms: 1_795_400_000_000,
    }];
    let manifest = ConscienceManifest::sign_with_root(
        &root_key,
        &root_directives,
        &operator_directives,
        1_795_400_000_000,
    )?;
    let prov = ProvenanceRecord {
        written_by: String::from("seed"),
        at_ms: 1_795_400_000_000,
        source_event_ids: vec![String::from("ev-1")],
        model: None,
        supersedes: None,
    };
    let conscience = Conscience {
        schema_version: String::from("ewave-conscience/v1"),
        root_directives,
        operator_directives,
        manifest,
        identity: Vec::new(),
        values: vec![ValueEntry {
            id: String::from("core-honesty"),
            statement: String::from("始终客观诚实，绝不伪造测试通过。"),
            rationale: Some(String::from("工程可信根基")),
            authority: Authority::SelfCore,
            negotiable_in_conversation: false,
            examples: Vec::new(),
            mutability: Mutability::self_core_default(),
            provenance: prov.clone(),
            valid_from_ms: 1_795_400_000_000,
            invalid_at_ms: None,
        }],
        relationships: Vec::new(),
        memories: vec![MemoryEntry {
            id: String::from("mem-rust-edition"),
            kind: MemoryKind::Fact,
            topic: Some(String::from("toolchain")),
            content: String::from("本项目统一使用 Rust 2024 Edition 与严格 clippy 门禁。"),
            about: Vec::new(),
            salience: 0.9,
            evidence_count: 2,
            constant: true,
            untrusted: false,
            muted: false,
            pressure_flags: Vec::new(),
            authority: Authority::Memory,
            mutability: Mutability::memory_free(),
            valid_from_ms: 1_795_400_000_000,
            invalid_at_ms: None,
            triggers: vec![String::from("rust"), String::from("edition")],
            provenance: prov,
        }],
        focus: FocusConfig::default(),
        grants_given: Vec::new(),
        grants_received: Vec::new(),
        episodes: Vec::new(),
        peer_links: BTreeMap::new(),
        pending_disclosures: Vec::new(),
    };
    let mut graph = SerpentineGraph::new(Default::default())?;
    let _ = graph.observe(
        serde_json::json!({"topic": "router_deprivation"}),
        ObserveOptions {
            text: Some(String::from(
                "架构记忆：Router 硬剥夺 shell 与 edit 工具，由隔离 Worker 执行。",
            )),
            ..Default::default()
        },
    )?;
    Ok((conscience, graph))
}

#[derive(Clone, Default)]
struct RecordingUpstream {
    captured: Arc<Mutex<Vec<UpstreamRequest>>>,
}

impl RecordingUpstream {
    fn take_captured(&self) -> Result<Vec<UpstreamRequest>, Box<dyn Error>> {
        let mut guard = self.captured.lock().map_err(|_| "upstream lock")?;
        Ok(std::mem::take(&mut *guard))
    }
}

impl UpstreamTransport for RecordingUpstream {
    fn roundtrip(&self, request: &UpstreamRequest) -> QzResult<UpstreamResponse> {
        if let Ok(mut guard) = self.captured.lock() {
            guard.push(request.clone());
        }
        if request.path_and_query.contains("/responses") {
            let sse = b"event: response.output_text.delta\ndata: {\"delta\":\"codex-ok\"}\n\nevent: response.completed\ndata: {\"status\":\"completed\"}\n\n";
            Ok(UpstreamResponse {
                status: 200,
                headers: vec![(
                    String::from("Content-Type"),
                    String::from("text/event-stream"),
                )],
                body: sse.to_vec(),
            })
        } else {
            let body = br#"{"id":"msg_mock_1","type":"message","role":"assistant","content":[{"type":"text","text":"mock-ok"}]}"#;
            Ok(UpstreamResponse {
                status: 200,
                headers: vec![(
                    String::from("Content-Type"),
                    String::from("application/json"),
                )],
                body: body.to_vec(),
            })
        }
    }
}

type RawHttpReply = (u16, Vec<(String, String)>, Vec<u8>);

fn send_raw_http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<RawHttpReply, Box<dyn Error>> {
    let mut stream = TcpStream::connect(addr)?;
    let mut wire = Vec::new();
    wire.extend_from_slice(format!("{method} {path} HTTP/1.1\r\n").as_bytes());
    let has_host = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host"));
    if !has_host {
        wire.extend_from_slice(format!("Host: {addr}\r\n").as_bytes());
    }
    wire.extend_from_slice(b"Connection: close\r\n");
    for (k, v) in headers {
        wire.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
    }
    if !body.is_empty() || method == "POST" {
        wire.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
    }
    wire.extend_from_slice(b"\r\n");
    wire.extend_from_slice(body);
    stream.write_all(&wire)?;

    let mut resp_bytes = Vec::new();
    stream.read_to_end(&mut resp_bytes)?;
    let split_pos = resp_bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("HTTP 响应缺少头部结束符")?;
    let head_str = std::str::from_utf8(&resp_bytes[..split_pos])?;
    let mut lines = head_str.split("\r\n");
    let status_line = lines.next().ok_or("缺少状态行")?;
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .ok_or("缺少状态码")?
        .parse()?;
    let mut out_headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            out_headers.push((k.trim().to_owned(), v.trim().to_owned()));
        }
    }
    let resp_body = resp_bytes[split_pos + 4..].to_vec();
    Ok((status_code, out_headers, resp_body))
}

#[test]
fn discovery_completes_under_10ms_filters_cln_pi_debian_dsh_and_blocks_headless_libsecret()
-> TestResult {
    // 1. 静态特征串核验：pi (CLN 1.3.7) / Debian dsh / Jordan Sissel grok 一律拒收
    assert!(
        !matches_agent_version_signature(
            "pi",
            "pi (CLN 1.3.7)\nWritten by Bruno Haible and Richard B. Kreckel."
        ),
        "数学计算器 CLN pi 严禁被识别为 Pi Coding Agent"
    );
    assert!(matches_agent_version_signature(
        "pi",
        "@mariozechner/pi-coding-agent v1.6.0"
    ));
    assert!(
        !matches_agent_version_signature("dsh", "Dancer's shell, version 0.25.10"),
        "Debian 系统包 dsh 严禁被识别为 DeepSeek Harness"
    );
    assert!(matches_agent_version_signature(
        "dsh",
        "dsh 0.4.2 (DeepSeek Harness)"
    ));
    assert!(!matches_agent_version_signature(
        "grok",
        "grok 0.9.2 - pattern matching tool by Jordan Sissel"
    ));
    assert!(matches_agent_version_signature(
        "grok",
        "grok-cli 1.1.0 (xAI Coding Agent)"
    ));

    // 防坑规范 #5：无 DBUS_SESSION_BUS_ADDRESS 时禁止触碰 libsecret / secret-tool
    assert!(!can_probe_linux_secret_service(None));
    assert!(!can_probe_linux_secret_service(Some("")));
    assert!(!can_probe_linux_secret_service(Some("   ")));
    assert!(can_probe_linux_secret_service(Some(
        "unix:path=/run/user/1000/bus"
    )));

    #[cfg(unix)]
    {
        let tmp = TempDirGuard::new("qz_discovery_trap")?;
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;
        let secret_sentinel = tmp.path().join("secret_tool_was_called");

        write_executable_script(
            &bin_dir.join("opencode"),
            "#!/bin/sh\necho 'opencode v2.4.0'\n",
        )?;
        write_executable_script(
            &bin_dir.join("claude"),
            "#!/bin/sh\necho '2.1.330 (Claude Code)'\n",
        )?;
        write_executable_script(
            &bin_dir.join("codex"),
            "#!/bin/sh\necho 'codex-cli 0.171.0'\n",
        )?;
        write_executable_script(
            &bin_dir.join("pi"),
            "#!/bin/sh\necho 'pi (CLN 1.3.7)'\necho 'Written by Bruno Haible'\n",
        )?;
        write_executable_script(
            &bin_dir.join("dsh"),
            "#!/bin/sh\necho \"Dancer's shell, version 0.25.10\"\n",
        )?;
        write_executable_script(
            &bin_dir.join("secret-tool"),
            &format!(
                "#!/bin/sh\ntouch '{}'\nsleep 30\n",
                secret_sentinel.display()
            ),
        )?;

        let cfg = DiscoveryConfig {
            search_paths: vec![bin_dir],
            env_overrides: BTreeMap::from([(
                String::from("DBUS_SESSION_BUS_ADDRESS"),
                String::new(),
            )]),
            probe_timeout: std::time::Duration::from_millis(7),
            allow_host_env: false,
        };
        let report = discover_coding_agents(&cfg)?;
        assert!(
            report.elapsed_micros < 10_000,
            "合成 PATH 并发嗅探必须在 <10ms 内完成，实际耗时 {}us",
            report.elapsed_micros
        );
        assert!(!report.linux_keyring_allowed);
        assert!(
            !secret_sentinel.exists(),
            "无 DBUS_SESSION_BUS_ADDRESS 时绝对禁止调用 secret-tool"
        );
        assert_eq!(report.recommended, Some(CodingAgentKind::OpenCode));

        let kinds: Vec<CodingAgentKind> = report.agents.iter().map(|a| a.kind).collect();
        assert!(kinds.contains(&CodingAgentKind::OpenCode));
        assert!(kinds.contains(&CodingAgentKind::ClaudeCode));
        assert!(kinds.contains(&CodingAgentKind::Codex));
        assert!(!kinds.contains(&CodingAgentKind::Pi));
        assert!(!kinds.contains(&CodingAgentKind::Dsh));
        assert!(
            report.rejected.iter().any(|r| r.binary_name == "pi"),
            "撞车的 CLN pi 必须记录在 rejected 列表中"
        );
        assert!(
            report.rejected.iter().any(|r| r.binary_name == "dsh"),
            "撞车的 Debian dsh 必须记录在 rejected 列表中"
        );
    }

    // 2. 宿主实机探测校验：本机存在 /usr/bin/pi (CLN 1.3.7) 与 opencode/claude/codex，必须在 <10ms 完成且过滤 /usr/bin/pi
    let live_report = discover_coding_agents(&DiscoveryConfig::default())?;
    assert!(
        live_report.elapsed_micros < 10_000,
        "宿主实机嗅探必须在 <10ms 内完成，实际耗时 {}us",
        live_report.elapsed_micros
    );
    if Path::new("/usr/bin/pi").exists() {
        assert!(
            !live_report
                .agents
                .iter()
                .any(|a| a.binary_path == Path::new("/usr/bin/pi")),
            "本机 /usr/bin/pi (CLN 1.3.7) 必须被精确过滤剔除"
        );
    }

    Ok(())
}

#[test]
fn gateway_enforces_256bit_cap_token_qz_token_401_and_oauth_refresh_token_stripping() -> TestResult
{
    let tmp = TempDirGuard::new("qz_gateway_oauth")?;
    let host_claude = tmp.path().join("host_claude");
    let host_codex = tmp.path().join("host_codex");
    let stub_root = tmp.path().join("sandbox_stubs");
    fs::create_dir_all(&host_claude)?;
    fs::create_dir_all(&host_codex)?;

    fs::write(
        host_claude.join(".credentials.json"),
        r#"{
            "claudeAiOauth": {
                "accessToken": "at_claude_real_secret_token_991",
                "refreshToken": "rt_claude_long_lived_never_enter_sandbox_991",
                "expiresAt": 1999999999000
            }
        }"#,
    )?;
    fs::write(
        host_codex.join("auth.json"),
        r#"{
            "tokens": {
                "access_token": "at_codex_real_secret_token_882",
                "refresh_token": "rt_codex_long_lived_never_enter_sandbox_882",
                "id_token": "eyJhbGciOiJSUzI1NiJ9.sensitive",
                "account_id": "acct_plus_sub_77"
            },
            "OPENAI_API_KEY": null
        }"#,
    )?;

    // 用户层的宿主设置（钩子、已启用插件）与缓存文件不是凭据，绝不能被带进受管运行的存根：
    // 否则受管运行会触发用户自己装的挂载（包括我们装进用户层的那一份），形成递归。
    fs::write(
        host_claude.join("settings.json"),
        r#"{
            "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "user-level-hook"}]}]},
            "enabledPlugins": {"quetzalcoatl@quetzalcoatl-local": true}
        }"#,
    )?;
    fs::write(host_claude.join("stats-cache.json"), r#"{"sessions": 3}"#)?;
    fs::write(host_codex.join("version.json"), r#"{"latest": "0.0.0"}"#)?;

    let (conscience, graph) = build_sample_conscience_and_graph()?;
    let assembled = ContextAssembler::assemble(
        &conscience,
        &graph,
        &AssemblyRequest::new(BudgetProfile::Standard, 1_795_400_010_000),
    )?;

    let mock_upstream = RecordingUpstream::default();
    let gw = LoopbackGateway::new(GatewayConfig::default(), Arc::new(mock_upstream.clone()));
    let mut handle = gw.serve_loopback(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    let addr = handle.bound_addr();

    let stub_probe = prepare_stripped_oauth_stubs(
        Some(&host_claude),
        Some(&host_codex),
        &stub_root,
        "qz_stub_placeholder_for_inspection",
    )?;
    assert_eq!(
        stub_probe.extracted.claude_access_token.as_deref(),
        Some("at_claude_real_secret_token_991")
    );
    assert_eq!(
        stub_probe.extracted.codex_access_token.as_deref(),
        Some("at_codex_real_secret_token_882")
    );
    assert_eq!(
        stub_probe.extracted.codex_account_id.as_deref(),
        Some("acct_plus_sub_77")
    );

    let mut claude_stub_files: Vec<String> = fs::read_dir(&stub_probe.claude_config_dir)?
        .filter_map(|e| e.ok().and_then(|e| e.file_name().into_string().ok()))
        .collect();
    claude_stub_files.sort();
    assert_eq!(
        claude_stub_files,
        vec![String::from(".credentials.json")],
        "Claude 存根只允许出现凭据文件，用户层 settings.json 等一律不带"
    );
    let mut codex_stub_files: Vec<String> = fs::read_dir(&stub_probe.codex_home_dir)?
        .filter_map(|e| e.ok().and_then(|e| e.file_name().into_string().ok()))
        .collect();
    codex_stub_files.sort();
    assert_eq!(
        codex_stub_files,
        vec![String::from("auth.json")],
        "Codex 存根只允许出现凭据文件"
    );
    let stripped_claude_json =
        fs::read_to_string(stub_probe.claude_config_dir.join(".credentials.json"))?;
    let stripped_codex_json = fs::read_to_string(stub_probe.codex_home_dir.join("auth.json"))?;
    for forbidden in [
        "rt_claude_long_lived_never_enter_sandbox_991",
        "rt_codex_long_lived_never_enter_sandbox_882",
        "at_claude_real_secret_token_991",
        "at_codex_real_secret_token_882",
        "refreshToken",
        "refresh_token",
        "id_token",
    ] {
        assert!(
            !stripped_claude_json.contains(forbidden),
            "沙箱 CLAUDE_CONFIG_DIR 存根严禁残留敏感字段 `{forbidden}`"
        );
        assert!(
            !stripped_codex_json.contains(forbidden),
            "沙箱 CODEX_HOME 存根严禁残留敏感字段 `{forbidden}`"
        );
    }

    #[cfg(unix)]
    {
        let mode = fs::metadata(stub_probe.claude_config_dir.join(".credentials.json"))?
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "剥离后的凭据存根权限必须严格为 0600");
    }

    let grant = gw.register_session(
        &handle.base_url(),
        GatewaySessionConfig {
            run_id: RunId::new_v4(),
            assembled_context: assembled,
            upstream_anthropic_bearer: stub_probe.extracted.claude_access_token.clone(),
            upstream_openai_bearer: stub_probe.extracted.codex_access_token.clone(),
            upstream_codex_bearer: stub_probe.extracted.codex_access_token.clone(),
            upstream_codex_account_id: stub_probe.extracted.codex_account_id.clone(),
            upstream_gemini_bearer: None,
        },
    )?;
    assert_eq!(
        grant.cap_token.len(),
        64,
        "路径能力密钥必须为 256-bit (64 hex chars)"
    );

    let sample_body = br#"{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}"#;

    // 1. 无 /run/<cap_token> 前缀 -> 401
    let (st_no_cap, _, _) = send_raw_http(addr, "POST", "/v1/messages", &[], sample_body)?;
    assert_eq!(st_no_cap, 401);

    // 2. 错误的 <cap_token> -> 401
    let bad_cap = "0".repeat(64);
    let (st_bad_cap, _, _) = send_raw_http(
        addr,
        "POST",
        &format!("/run/{bad_cap}/v1/messages"),
        &[("x-qz-token", &grant.qz_token)],
        sample_body,
    )?;
    assert_eq!(st_bad_cap, 401);

    // 3. 路径 cap_token 正确，但缺失 x-qz-token（或携带未知伪造 Authorization） -> 401
    let (st_no_tok, _, _) = send_raw_http(
        addr,
        "POST",
        &format!("/run/{}/v1/messages", grant.cap_token),
        &[("Authorization", "Bearer attacker-forged-token")],
        sample_body,
    )?;
    assert_eq!(st_no_tok, 401, "未带合法 x-qz-token 的请求必须返回 401");

    // 4. 携带合法 x-qz-token -> 200，且出站请求自动换上宿主托管的真 OAuth access_token
    let (st_ok, _, _) = send_raw_http(
        addr,
        "POST",
        &format!("/run/{}/v1/messages", grant.cap_token),
        &[
            ("Content-Type", "application/json"),
            ("x-qz-token", &grant.qz_token),
        ],
        sample_body,
    )?;
    assert_eq!(st_ok, 200);

    let captured = mock_upstream.take_captured()?;
    assert_eq!(captured.len(), 1);
    let out_req = &captured[0];
    assert!(
        out_req
            .headers
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case("authorization")
                && v == "Bearer at_claude_real_secret_token_991"),
        "网关出站瞬间必须换上真实 OAuth 令牌"
    );
    assert!(
        !out_req
            .headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("x-qz-token")),
        "内部鉴权头 x-qz-token 不得泄露给上游"
    );

    handle.shutdown();
    Ok(())
}

#[test]
fn anthropic_gateway_preserves_system0_headers_count_tokens_and_normalizes_cache_controls_to_4()
-> TestResult {
    let (conscience, graph) = build_sample_conscience_and_graph()?;
    let mut req = AssemblyRequest::new(BudgetProfile::Standard, 1_795_400_020_000);
    req.query = Some(String::from("rust edition 规范"));
    let assembled = ContextAssembler::assemble(&conscience, &graph, &req)?;

    let mock_upstream = RecordingUpstream::default();
    let gw = LoopbackGateway::new(GatewayConfig::default(), Arc::new(mock_upstream.clone()));
    let mut handle = gw.serve_loopback(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    let addr = handle.bound_addr();

    // 不设 upstream_anthropic_bearer，验证原样透传订阅用户的 Authorization 头（防坑规范 #2）
    let grant = gw.register_session(
        &handle.base_url(),
        GatewaySessionConfig {
            run_id: RunId::new_v4(),
            assembled_context: assembled.clone(),
            upstream_anthropic_bearer: None,
            upstream_openai_bearer: None,
            upstream_codex_bearer: None,
            upstream_codex_account_id: None,
            upstream_gemini_bearer: None,
        },
    )?;

    let input_payload = serde_json::json!({
        "model": "claude-sonnet-4-5-20250929",
        "max_tokens": 1024,
        "tools": [
            {
                "name": "read_file",
                "input_schema": {"type": "object"},
                "cache_control": {"type": "ephemeral"}
            },
            {
                "name": "grep_search",
                "input_schema": {"type": "object"},
                "cache_control": {"type": "ephemeral"}
            }
        ],
        "system": [
            {
                "type": "text",
                "text": "You are Claude Code, Anthropic's official CLI for Claude. DO NOT TOUCH THIS FINGERPRINT.",
                "cache_control": {"type": "ephemeral"}
            },
            {
                "type": "text",
                "text": "Workspace context block",
                "cache_control": {"type": "ephemeral"}
            }
        ],
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Turn 1 question", "cache_control": {"type": "ephemeral"}}
                ]
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Turn 1 answer", "cache_control": {"type": "ephemeral"}}
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_01",
                        "content": "Cargo.toml edition = 2024",
                        "cache_control": {"type": "ephemeral"}
                    }
                ]
            }
        ]
    });
    assert_eq!(count_anthropic_cache_controls(&input_payload), 7);
    let original_system_0 = input_payload["system"][0].clone();
    let original_msg_0 = input_payload["messages"][0]["content"][0]["text"].clone();

    let (status, _, _) = send_raw_http(
        addr,
        "POST",
        &format!("/run/{}/v1/messages", grant.cap_token),
        &[
            ("Content-Type", "application/json"),
            ("x-qz-token", &grant.qz_token),
            ("Authorization", "Bearer claude-max-oauth-passthrough"),
            (
                "anthropic-beta",
                "prompt-caching-2024-07-31,oauth-2025-04-20",
            ),
            ("anthropic-version", "2023-06-01"),
        ],
        &serde_json::to_vec(&input_payload)?,
    )?;
    assert_eq!(status, 200);

    let captured = mock_upstream.take_captured()?;
    assert_eq!(captured.len(), 1);
    let out = &captured[0];
    assert_eq!(out.path_and_query, "/v1/messages");
    assert!(out.headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("authorization") && v == "Bearer claude-max-oauth-passthrough"
    }));
    assert!(out.headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("anthropic-beta")
            && v == "prompt-caching-2024-07-31,oauth-2025-04-20"
    }));
    assert!(
        out.headers
            .iter()
            .any(|(k, v)| { k.eq_ignore_ascii_case("anthropic-version") && v == "2023-06-01" })
    );

    let out_json: serde_json::Value = serde_json::from_slice(&out.body)?;
    // 1. system[0] 绝对原封不动！
    assert_eq!(
        out_json["system"][0], original_system_0,
        "回环网关严禁触碰 system[0] 首部缓存指纹"
    );
    // 2. PINNED 追加在 system[last]
    let sys_arr = out_json["system"].as_array().ok_or("system 应为数组")?;
    let sys_last_text = sys_arr
        .last()
        .and_then(|v| v["text"].as_str())
        .ok_or("缺少 system[last].text")?;
    assert!(sys_last_text.contains("<ewave_pinned>"));
    assert!(sys_last_text.contains("ANTI_MIND_VIRUS"));

    // 3. 历史轮消息文本不变，动态易变段仅注入最后一条 user/tool_result 消息末尾
    assert_eq!(
        out_json["messages"][0]["content"][0]["text"],
        original_msg_0
    );
    let last_msg_content = out_json["messages"][2]["content"]
        .as_array()
        .ok_or("messages[2].content 应为数组")?;
    assert_eq!(last_msg_content[0]["type"], "tool_result");
    let tail_text = last_msg_content
        .last()
        .and_then(|b| b["text"].as_str())
        .ok_or("最后一条 user 消息末尾应包含动态注入块")?;
    assert!(tail_text.contains("<ewave_volatile>"));
    assert!(tail_text.contains("<ewave_check"));

    // 4. 全请求 cache_control 块总数严格归一化 <= 4
    let final_cc_count = count_anthropic_cache_controls(&out_json);
    assert!(
        final_cc_count <= 4,
        "全请求 cache_control 块数严禁超过 4，实际为 {final_cc_count}"
    );
    assert_eq!(final_cc_count, 4);

    // 5. /v1/messages/count_tokens 原样透传不改写字节
    let raw_count_tokens_body = br#"{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"exact-bytes-check"}]}"#;
    let (ct_status, _, _) = send_raw_http(
        addr,
        "POST",
        &format!(
            "/run/{}/v1/messages/count_tokens?beta=true",
            grant.cap_token
        ),
        &[
            ("Content-Type", "application/json"),
            ("x-qz-token", &grant.qz_token),
            ("anthropic-version", "2023-06-01"),
        ],
        raw_count_tokens_body,
    )?;
    assert_eq!(ct_status, 200);
    let ct_captured = mock_upstream.take_captured()?;
    assert_eq!(ct_captured.len(), 1);
    assert_eq!(
        ct_captured[0].path_and_query,
        "/v1/messages/count_tokens?beta=true"
    );
    assert_eq!(
        ct_captured[0].body.as_slice(),
        raw_count_tokens_body,
        "/v1/messages/count_tokens 必须逐字节原样透传"
    );

    handle.shutdown();
    Ok(())
}

#[test]
fn codex_and_gemini_gateway_ws_426_zstd_decompression_raw_encrypted_content_and_driver_guards()
-> TestResult {
    let (conscience, graph) = build_sample_conscience_and_graph()?;
    let assembled = ContextAssembler::assemble(
        &conscience,
        &graph,
        &AssemblyRequest::new(BudgetProfile::Standard, 1_795_400_030_000),
    )?;

    let mock_upstream = RecordingUpstream::default();
    let gw = LoopbackGateway::new(GatewayConfig::default(), Arc::new(mock_upstream.clone()));
    let mut handle = gw.serve_loopback(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    let addr = handle.bound_addr();

    let grant = gw.register_session(
        &handle.base_url(),
        GatewaySessionConfig {
            run_id: RunId::new_v4(),
            assembled_context: assembled,
            upstream_anthropic_bearer: None,
            upstream_openai_bearer: Some(String::from("sk-openai-real")),
            upstream_codex_bearer: Some(String::from("oauth-codex-real")),
            upstream_codex_account_id: None,
            upstream_gemini_bearer: Some(String::from("goog-token-real")),
        },
    )?;

    // 1. Codex /responses WebSocket Upgrade -> HTTP 426 Upgrade Required（触发 codex-rs force_http_fallback）
    let (ws_status, _, _) = send_raw_http(
        addr,
        "GET",
        &format!(
            "/run/{}/chatgpt/backend-api/codex/responses",
            grant.cap_token
        ),
        &[
            ("x-qz-token", &grant.qz_token),
            ("Connection", "Upgrade"),
            ("Upgrade", "websocket"),
            ("Sec-WebSocket-Version", "13"),
            ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
        ],
        b"",
    )?;
    assert_eq!(
        ws_status, 426,
        "对 /responses 的 WebSocket 握手必须直接返回 HTTP 426 Upgrade Required"
    );

    // 2. Codex zstd 压缩请求体解压 + /backend-api/codex 路径与 ChatGPT-Account-ID 保真 + encrypted_content RawValue 逐字节保留
    let exact_encrypted_literal =
        r#"{"z_order": 1e+0,   "cipher": "\u0041_RAW_ENCRYPTED_REASONING== "}"#;
    let raw_codex_json = format!(
        r#"{{"model":"gpt-5-codex","instructions":"Base codex instructions","encrypted_content":{exact_encrypted_literal},"input":[{{"type":"reasoning","id":"rs_1","encrypted_content":{exact_encrypted_literal}}},{{"role":"user","content":"Fix parser bug"}}]}}"#
    );
    let zstd_compressed = zstd::bulk::compress(raw_codex_json.as_bytes(), 3)?;

    // 超出 window_log_max(20) 的恶意大窗口 zstd 帧必须被 400 拦截
    let mut bomb_enc = zstd::stream::write::Encoder::new(Vec::new(), 3)?;
    bomb_enc.window_log(25)?;
    bomb_enc.write_all(raw_codex_json.as_bytes())?;
    let oversized_win_zstd = bomb_enc.finish()?;
    let (bomb_status, _, _) = send_raw_http(
        addr,
        "POST",
        &format!(
            "/run/{}/chatgpt/backend-api/codex/responses",
            grant.cap_token
        ),
        &[
            ("x-qz-token", &grant.qz_token),
            ("Content-Type", "application/json"),
            ("Content-Encoding", "zstd"),
        ],
        &oversized_win_zstd,
    )?;
    assert_eq!(bomb_status, 400, "window_log > 20 的 zstd 请求体必须被拦截");

    let (codex_status, codex_resp_headers, codex_resp_body) = send_raw_http(
        addr,
        "POST",
        &format!(
            "/run/{}/chatgpt/backend-api/codex/responses",
            grant.cap_token
        ),
        &[
            ("x-qz-token", &grant.qz_token),
            ("Content-Type", "application/json"),
            ("Content-Encoding", "zstd"),
            ("ChatGPT-Account-ID", "acct_team_42"),
        ],
        &zstd_compressed,
    )?;
    assert_eq!(codex_status, 200);
    assert!(
        !codex_resp_headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-encoding")),
        "回传给 Codex 的 SSE 响应必须为未压缩明文流"
    );
    assert!(String::from_utf8_lossy(&codex_resp_body).contains("codex-ok"));

    let captured = mock_upstream.take_captured()?;
    assert_eq!(captured.len(), 1);
    let codex_out = &captured[0];
    assert_eq!(codex_out.path_and_query, "/backend-api/codex/responses");
    assert!(
        codex_out
            .headers
            .iter()
            .any(|(k, v)| { k.eq_ignore_ascii_case("chatgpt-account-id") && v == "acct_team_42" })
    );
    let out_body_str = std::str::from_utf8(&codex_out.body)?;
    assert!(
        out_body_str.contains(exact_encrypted_literal),
        "encrypted_content 必须通过 RawValue 逐字节原样保留空白与转义，实际为: {out_body_str}"
    );
    assert_eq!(
        out_body_str.matches(exact_encrypted_literal).count(),
        2,
        "顶层与 input[0] 中的两处 encrypted_content 都必须逐字节原样保留"
    );
    assert!(out_body_str.contains("<ewave_pinned>"));
    assert!(out_body_str.contains("<ewave_check"));

    // 3. /openai/v1/responses 双路径挂载验证
    let (oai_status, _, _) = send_raw_http(
        addr,
        "POST",
        &format!("/run/{}/openai/v1/responses", grant.cap_token),
        &[
            ("x-qz-token", &grant.qz_token),
            ("Content-Type", "application/json"),
        ],
        br#"{"model":"gpt-5","input":"hello"}"#,
    )?;
    assert_eq!(oai_status, 200);
    let oai_captured = mock_upstream.take_captured()?;
    assert_eq!(oai_captured[0].path_and_query, "/v1/responses");

    // 4. Gemini CLI 启动期无 model 字段的 /v1internal:loadCodeAssist 与 :onboardUser 透传 + 双环境变量
    for startup_path in ["/v1internal:loadCodeAssist", "/v1internal:onboardUser"] {
        let (g_status, _, _) = send_raw_http(
            addr,
            "POST",
            &format!("/run/{}{startup_path}", grant.cap_token),
            &[
                ("x-qz-token", &grant.qz_token),
                ("Content-Type", "application/json"),
            ],
            br#"{"metadata":{"ideType":"GEMINI_CLI"}}"#,
        )?;
        assert_eq!(
            g_status, 200,
            "Gemini CLI 启动握手路径 {startup_path} 缺少 model 字段时必须原样放行"
        );
    }
    let gem_captured = mock_upstream.take_captured()?;
    assert_eq!(gem_captured.len(), 2);
    assert_eq!(gem_captured[0].path_and_query, "/v1internal:loadCodeAssist");
    assert_eq!(gem_captured[1].path_and_query, "/v1internal:onboardUser");

    let gem_env = gemini_cli_env(&format!("{}/v1", grant.run_base_url), &grant.qz_token);
    let code_assist_ep = gem_env
        .get("CODE_ASSIST_ENDPOINT")
        .ok_or("缺少 CODE_ASSIST_ENDPOINT")?;
    let gemini_base = gem_env
        .get("GOOGLE_GEMINI_BASE_URL")
        .ok_or("缺少 GOOGLE_GEMINI_BASE_URL")?;
    assert!(
        !gemini_base.ends_with("/v1"),
        "GOOGLE_GEMINI_BASE_URL 严禁带 /v1 后缀: {gemini_base}"
    );
    assert!(!code_assist_ep.ends_with("/v1"));

    // 5. OpenCode V2 & Codex 驱动启动计划防坑校验
    let tmp = TempDirGuard::new("qz_driver_plans")?;
    let launch_ctx = HarnessLaunchContext {
        agent_kind: CodingAgentKind::OpenCode,
        binary_path: PathBuf::from("/usr/local/bin/opencode"),
        workspace_dir: tmp.path().to_path_buf(),
        sandbox_exec_path: PathBuf::from("/usr/local/bin/quetzalcoatl-sandbox-exec"),
        sandbox_spec_path: None,
        sandbox_binding: None,
        gateway_grant: grant,
        claude_stub_dir: Some(tmp.path().join("claude_stub")),
        codex_stub_dir: Some(tmp.path().join("codex_stub")),
        active_codex_provider: String::from("openai"),
        codex_uses_chatgpt_oauth: true,
        enhancers_root_dir: None,
        mcp_endpoint_url: None,
        daemon_ipc_url: None,
        daemon_ipc_token: None,
    };

    let oc_plan = OpenCodeDriver.build_launch_plan(&launch_ctx, "fix bug")?;
    OpenCodeDriver::validate_plan(&oc_plan)?;
    assert_eq!(
        oc_plan
            .env
            .get("OPENCODE_CONFIG_PROJECT_DISABLE")
            .map(String::as_str),
        Some("1")
    );
    assert!(!oc_plan.args.iter().any(|a| a == "--service"));
    assert_eq!(
        oc_plan.env.get("SHELL").map(String::as_str),
        Some("/usr/local/bin/quetzalcoatl-sandbox-exec")
    );
    assert!(OpenCodeDriver::is_blocked_http_path("/api/pty"));
    assert!(OpenCodeDriver::is_blocked_http_path("/api/pty/sess_1"));
    assert!(!OpenCodeDriver::is_blocked_http_path("/api/session"));

    let mut codex_ctx = launch_ctx.clone();
    codex_ctx.agent_kind = CodingAgentKind::Codex;
    codex_ctx.binary_path = PathBuf::from("/usr/local/bin/codex");
    let codex_plan = CodexDriver.build_launch_plan(&codex_ctx, "audit patch")?;
    CodexDriver::validate_plan(&codex_plan)?;
    let joined_args = codex_plan.args.join(" ");
    assert!(joined_args.contains("openai_base_url="));
    assert!(joined_args.contains("model_providers.openai.base_url="));
    assert!(
        !joined_args.contains("chatgpt_base_url"),
        "Codex 启动参数绝不可设置 chatgpt_base_url"
    );
    assert!(!codex_plan.env.contains_key("CHATGPT_BASE_URL"));

    let _ = ClaudeCodeDriver.build_launch_plan(&launch_ctx, "review")?;
    let _ = PiDriver.build_launch_plan(&launch_ctx, "implement")?;

    handle.shutdown();
    Ok(())
}

#[test]
fn mcp_bridge_and_isolated_git_worktree_enforce_blind_kernel_router_deprivation() -> TestResult {
    let tmp = TempDirGuard::new("qz_mcp_and_wt")?;
    let qz_home = tmp.path().join("qz_home");
    let store = RusqliteWalStore::open(&qz_home.join("spine/spine.sqlite"))?;
    let agent_id = AgentId::new_v4();
    let dev = DeviceIdentity::generate(DeviceId::new_v4())?;
    let root_key = AccountRootKey::from_bytes([0x11; 32]);
    let ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev.public_record())?;
    let spine = SpineEngine::new(
        agent_id,
        dev,
        ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, 1),
        store,
    )?;
    let sandbox = SandboxManager::new(SandboxConfig::new(&qz_home));
    let mut kernel = BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(42, 0.2, SleepPhase::Awake),
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    );

    for (cap_id, sink, surface) in [
        (
            "ewave.recall",
            SinkClass::LocalRead,
            ExecutionSurface::PureMetadata,
        ),
        (
            "task.artifact",
            SinkClass::LocalRead,
            ExecutionSurface::PureMetadata,
        ),
        (
            "shell",
            SinkClass::CodeRepositoryMutation,
            ExecutionSurface::SandboxShell,
        ),
        (
            "edit",
            SinkClass::CodeRepositoryMutation,
            ExecutionSurface::SandboxFileWrite,
        ),
        (
            "skill.synthesize",
            SinkClass::SandboxSelfEvolution,
            ExecutionSurface::PureMetadata,
        ),
    ] {
        kernel.register_capability(CapabilityDescriptor {
            capability_id: String::from(cap_id),
            interface_id: String::from("core"),
            sink_class: sink,
            surface,
            idempotent: matches!(sink, SinkClass::LocalRead),
            origin: CapabilityOrigin::HostRegistered,
        })?;
    }

    let all_bindings = BTreeSet::from([
        String::from("ewave.recall"),
        String::from("task.artifact"),
        String::from("shell"),
        String::from("edit"),
        String::from("skill.synthesize"),
    ]);

    let (conscience, graph) = build_sample_conscience_and_graph()?;

    // 1. Router 会话：shell / edit / skill.synthesize 被盲内核架构级硬剥夺
    let router_mcp = McpBridgeSession::router_default(all_bindings.clone());
    let list_resp_raw = router_mcp
        .handle_jsonrpc(
            &mut kernel,
            &conscience,
            &graph,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#,
            1_795_400_050_000,
        )?
        .ok_or("tools/list 应返回 JSON-RPC 响应")?;
    let list_resp: serde_json::Value = serde_json::from_str(&list_resp_raw)?;
    let router_tools: Vec<&str> = list_resp["result"]["tools"]
        .as_array()
        .ok_or("缺少 tools 数组")?
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(router_tools.contains(&"ewave.recall"));
    assert!(router_tools.contains(&"task.artifact"));
    assert!(!router_tools.contains(&"shell"));
    assert!(!router_tools.contains(&"edit"));
    assert!(!router_tools.contains(&"skill.synthesize"));

    // Router 强行调用 shell -> 被盲内核拒绝并记入 MovementLedger
    let deny_resp_raw = router_mcp
        .handle_jsonrpc(
            &mut kernel,
            &conscience,
            &graph,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"shell","arguments":{"cmd":"rm -rf /"}}}"#,
            1_795_400_050_010,
        )?
        .ok_or("tools/call 应返回 JSON-RPC 错误响应")?;
    let deny_resp: serde_json::Value = serde_json::from_str(&deny_resp_raw)?;
    assert!(deny_resp.get("error").is_some());
    assert!(
        kernel
            .ledger()
            .records()
            .iter()
            .any(|r| r.principal == PrincipalRole::Router
                && r.capability_id == "shell"
                && r.outcome == MovementOutcome::PermissionDenied)
    );

    // 2. 独立 Git Worktree 隔离创建、ACP 驱动事件流执行与验收应用
    let repo_dir = tmp.path().join("repo");
    fs::create_dir_all(repo_dir.join("src"))?;
    fs::write(repo_dir.join("src/lib.rs"), "pub fn value() -> u32 { 1 }\n")?;
    let init_ok = Command::new("git")
        .current_dir(&repo_dir)
        .args(["init", "-q"])
        .status()?;
    assert!(init_ok.success());
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["config", "user.email", "synth@quetzalcoatl.test"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["config", "user.name", "Synth"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["add", "."])
        .status()?;
    let commit_ok = Command::new("git")
        .current_dir(&repo_dir)
        .args(["commit", "-q", "-m", "initial"])
        .status()?;
    assert!(commit_ok.success());

    let wt_root = tmp.path().join("worktrees");
    let wt_run_id = RunId::new_v4();
    let wt_lease = WorktreeManager::create_detached(&repo_dir, &wt_root, wt_run_id)?;
    let wt_path = wt_lease.worktree_dir().to_path_buf();
    assert!(wt_path.is_dir());
    assert_ne!(wt_path, repo_dir);

    #[cfg(unix)]
    {
        let fake_agent = tmp.path().join("fake_acp_agent.sh");
        write_executable_script(
            &fake_agent,
            "#!/bin/sh\n\
             printf 'pub fn value() -> u32 { 42 }\\n' > src/lib.rs\n\
             echo '{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"type\":\"turn_started\",\"turn_id\":\"t1\"}}'\n\
             echo '{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"type\":\"tool_call\",\"call_id\":\"c1\",\"tool_name\":\"edit\",\"arguments\":{\"path\":\"src/lib.rs\"}}}'\n\
             echo '{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"type\":\"delta\",\"text\":\"Updated value() to 42. \"}}'\n\
             echo '{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"type\":\"turn_completed\",\"turn_id\":\"t1\",\"final_text\":\"Updated value() to 42. <ewave_check conflict=\\\"none\\\" ids=\\\"core-honesty\\\"/>\"}}'\n",
        )?;

        let dummy_grant = quetzalcoatl_harness::GatewaySessionGrant {
            run_id: wt_run_id,
            cap_token: "a".repeat(64),
            qz_token: "b".repeat(64),
            ephemeral_stub_token: format!("qz_stub_{}", "c".repeat(64)),
            run_base_url: format!("http://127.0.0.1:9/run/{}", "a".repeat(64)),
        };
        let drv = AcpJsonRpcDriver::new(CodingAgentKind::OpenCode);
        let outcome = drv.execute_turn(
            &HarnessLaunchContext {
                agent_kind: CodingAgentKind::OpenCode,
                binary_path: fake_agent,
                workspace_dir: wt_path.clone(),
                sandbox_exec_path: PathBuf::from("/bin/sh"),
                sandbox_spec_path: None,
                sandbox_binding: None,
                gateway_grant: dummy_grant,
                claude_stub_dir: None,
                codex_stub_dir: None,
                active_codex_provider: String::from("openai"),
                codex_uses_chatgpt_oauth: false,
                enhancers_root_dir: None,
                mcp_endpoint_url: None,
                daemon_ipc_url: None,
                daemon_ipc_token: None,
            },
            "Update value to 42",
        )?;

        assert!(outcome.changed_files.iter().any(|f| f == "src/lib.rs"));
        assert!(
            outcome
                .events
                .iter()
                .any(|e| matches!(e, HarnessEvent::SessionStarted { .. }))
        );
        assert!(
            outcome
                .events
                .iter()
                .any(|e| matches!(e, HarnessEvent::ToolCall { .. }))
        );
        assert!(
            outcome
                .events
                .iter()
                .any(|e| matches!(e, HarnessEvent::DiffProduced { .. }))
        );
        assert!(outcome.events.iter().any(|e| matches!(
            e,
            HarnessEvent::TurnCompleted {
                ewave_check: Some(chk),
                ..
            } if chk.conflict == "none"
        )));

        // 在 apply_verified_to_repo 之前，主仓库必须保持原样未受污染
        assert_eq!(
            fs::read_to_string(repo_dir.join("src/lib.rs"))?,
            "pub fn value() -> u32 { 1 }\n"
        );
        let applied = wt_lease.apply_verified_to_repo()?;
        assert!(applied.contains(&String::from("src/lib.rs")));
        assert_eq!(
            fs::read_to_string(repo_dir.join("src/lib.rs"))?,
            "pub fn value() -> u32 { 42 }\n"
        );
    }

    wt_lease.cleanup()?;
    assert!(
        !wt_path.exists(),
        "cleanup 后临时 Git worktree 目录必须被清理"
    );
    Ok(())
}

#[test]
fn regression_r1_finding2_mcp_skill_synthesize_validates_rel_path_before_any_host_write()
-> TestResult {
    let tmp = TempDirGuard::new("qz_r1_mcp_path_traversal")?;
    let qz_home = tmp.path().join("qz_home");
    let ws = tmp.path().join("worker_ws");
    let outside_dir = tmp.path().join("outside_target");
    fs::create_dir_all(&ws)?;
    fs::create_dir_all(&outside_dir)?;

    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside_dir, ws.join("symlink_escape"))?;

    let store = RusqliteWalStore::open(&qz_home.join("spine/spine.sqlite"))?;
    let agent_id = AgentId::new_v4();
    let dev = DeviceIdentity::generate(DeviceId::new_v4())?;
    let root_key = AccountRootKey::from_bytes([0x31; 32]);
    let ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev.public_record())?;
    let spine = SpineEngine::new(
        agent_id,
        dev,
        ring,
        HlcTimestamp::from_parts(1_795_400_100_000, 0, 1),
        store,
    )?;
    let sandbox = SandboxManager::new(SandboxConfig::new(&qz_home));
    let mut kernel = BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(7, 0.2, SleepPhase::Awake),
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    );
    kernel.register_capability(CapabilityDescriptor {
        capability_id: String::from("skill.synthesize"),
        interface_id: String::from("core"),
        sink_class: SinkClass::SandboxSelfEvolution,
        surface: ExecutionSurface::PureMetadata,
        idempotent: false,
        origin: CapabilityOrigin::HostRegistered,
    })?;

    let run = kernel.spawn_explore_run("mcp-r1-f2", Some(ws.clone()), 1_795_400_100_000)?;
    let bindings = BTreeSet::from([String::from("skill.synthesize")]);
    let worker_mcp = McpBridgeSession::worker_for_run(run.run_id, bindings);
    let (conscience, graph) = build_sample_conscience_and_graph()?;

    for (idx, bad_rel) in [
        "../outside_target/pwn_parent.sh",
        ".git/hooks/pre-commit",
        ".opencode/plugins/hijack.ts",
        ".claude/settings.json",
        ".codex/config.toml",
        "symlink_escape/pwn_via_symlink.sh",
    ]
    .iter()
    .enumerate()
    {
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": idx + 1,
            "method": "tools/call",
            "params": {
                "name": "skill.synthesize",
                "arguments": {
                    "skill_id": format!("skill.bad_{idx}"),
                    "relative_script_path": bad_rel,
                    "interpreter": "/bin/sh",
                    "description": "exploit attempt",
                    "script_body": "#!/bin/sh\necho PWNED\n"
                }
            }
        });
        let raw_resp = worker_mcp
            .handle_jsonrpc(
                &mut kernel,
                &conscience,
                &graph,
                &req.to_string(),
                1_795_400_100_100 + (idx as u64),
            )?
            .ok_or("tools/call 应返回响应")?;
        let parsed: serde_json::Value = serde_json::from_str(&raw_resp)?;
        assert!(
            parsed.get("error").is_some(),
            "越界或受保护路径 `{bad_rel}` 必须报错拒绝"
        );
    }

    assert!(
        !outside_dir.join("pwn_parent.sh").exists(),
        "严禁在校验前通过 ../ 向工作区外部写入任何文件"
    );
    assert!(
        !outside_dir.join("pwn_via_symlink.sh").exists(),
        "严禁跟随工作区内符号链接目录写入外部文件"
    );
    assert!(
        !ws.join(".git/hooks/pre-commit").exists(),
        "严禁在校验前创建或写入 .git/hooks/pre-commit"
    );
    assert!(!ws.join(".opencode/plugins/hijack.ts").exists());
    assert!(!ws.join(".claude/settings.json").exists());
    assert!(!ws.join(".codex/config.toml").exists());

    Ok(())
}

#[test]
fn regression_r1_finding3_worktree_apply_blocks_symlink_exfiltration_and_protected_subpaths()
-> TestResult {
    let tmp = TempDirGuard::new("qz_r1_wt_symlink")?;
    let secret_file = tmp.path().join("sovereign_state.json");
    fs::write(&secret_file, r#"{"root_key_hex":"TOP_SECRET_ROOT_KEY"}"#)?;

    let repo_dir = tmp.path().join("repo");
    fs::create_dir_all(repo_dir.join("src"))?;
    fs::write(repo_dir.join("src/lib.rs"), "pub fn safe() -> u32 { 1 }\n")?;
    assert!(
        Command::new("git")
            .current_dir(&repo_dir)
            .args(["init", "-q"])
            .status()?
            .success()
    );
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["config", "user.email", "test@quetzalcoatl.test"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["config", "user.name", "Test"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["add", "."])
        .status()?;
    assert!(
        Command::new("git")
            .current_dir(&repo_dir)
            .args(["commit", "-q", "-m", "init"])
            .status()?
            .success()
    );

    let wt_root = tmp.path().join("wts");

    // 1. 符号链接窃密攻击：Worker 在 worktree 内创建指向外部密钥文件的符号链接
    #[cfg(unix)]
    {
        let wt1 = WorktreeManager::create_detached(&repo_dir, &wt_root, RunId::new_v4())?;
        std::os::unix::fs::symlink(&secret_file, wt1.worktree_dir().join("src/leak.json"))?;
        let res = wt1.apply_verified_to_repo();
        assert!(
            matches!(
                res,
                Err(quetzalcoatl_types::QuetzalcoatlError::SandboxViolation { .. })
            ),
            "apply_verified_to_repo 遇到符号链接必须报错 SandboxViolation，实际为: {res:?}"
        );
        assert!(
            !repo_dir.join("src/leak.json").exists(),
            "严禁解引用符号链接将宿主密钥复制到主仓库"
        );
        wt1.cleanup()?;
    }

    // 2. 受保护配置子目录覆写攻击：Worker 在 worktree 内新增 .opencode/opencode.json
    {
        let wt2 = WorktreeManager::create_detached(&repo_dir, &wt_root, RunId::new_v4())?;
        fs::create_dir_all(wt2.worktree_dir().join(".opencode"))?;
        fs::write(
            wt2.worktree_dir().join(".opencode/opencode.json"),
            r#"{"hijack":true}"#,
        )?;
        let res2 = wt2.apply_verified_to_repo();
        assert!(
            matches!(
                res2,
                Err(quetzalcoatl_types::QuetzalcoatlError::SandboxViolation { .. })
            ),
            "apply_verified_to_repo 触碰 .opencode/.claude/.codex/.git 必须报错 SandboxViolation，实际为: {res2:?}"
        );
        assert!(!repo_dir.join(".opencode/opencode.json").exists());
        wt2.cleanup()?;
    }

    Ok(())
}

#[test]
fn regression_r1_finding4_and_5_https_upstream_tls_roundtrip_no_redirect_and_gemini_auth()
-> TestResult {
    use quetzalcoatl_harness::HttpsUpstreamTransport;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

    let certified = rcgen::generate_simple_self_signed(vec![String::from("localhost")])?;
    let cert_der_bytes = certified.cert.der().to_vec();
    let key_der_bytes = certified.signing_key.serialize_der();

    let server_cfg = Arc::new(
        rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert_der_bytes.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der_bytes)),
        )?,
    );

    let tls_listener = std::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    let tls_port = tls_listener.local_addr()?.port();
    tls_listener.set_nonblocking(true)?;
    let stop_tls = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_tls_bg = Arc::clone(&stop_tls);
    let seen_paths = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen_paths_bg = Arc::clone(&seen_paths);

    let tls_thread = std::thread::spawn(move || {
        while !stop_tls_bg.load(std::sync::atomic::Ordering::Relaxed) {
            match tls_listener.accept() {
                Ok((tcp, _)) => {
                    let _ = tcp.set_nonblocking(false);
                    let _ = tcp.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    let Ok(conn) = rustls::ServerConnection::new(Arc::clone(&server_cfg)) else {
                        continue;
                    };
                    let mut tls_stream = rustls::StreamOwned::new(conn, tcp);
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 2048];
                    loop {
                        match tls_stream.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&chunk[..n]);
                                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                        }
                    }
                    let req_head = String::from_utf8_lossy(&buf);
                    let path_target = req_head
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_owned();
                    if let Ok(mut g) = seen_paths_bg.lock() {
                        g.push(path_target.clone());
                    }

                    if path_target.starts_with("/redirect302") {
                        let resp = b"HTTP/1.1 302 Found\r\nLocation: https://evil.attacker.invalid/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = tls_stream.write_all(resp);
                    } else {
                        let json_body =
                            br#"{"candidates":[{"content":{"parts":[{"text":"tls-gemini-ok"}]}}]}"#;
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\n",
                            json_body.len()
                        );
                        let _ = tls_stream.write_all(head.as_bytes());
                        let _ = tls_stream.write_all(json_body);
                        let _ = tls_stream.write_all(b"\r\n0\r\n\r\n");
                    }
                    let _ = tls_stream.flush();
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });

    let https_transport = HttpsUpstreamTransport::with_extra_root_der_certs(vec![cert_der_bytes])?;

    // 1. 直接验证 HttpsUpstreamTransport 不跟随跨源 302 重定向
    let redir_resp = https_transport.roundtrip(&UpstreamRequest {
        method: String::from("GET"),
        scheme: String::from("https"),
        host: String::from("localhost"),
        port: tls_port,
        path_and_query: String::from("/redirect302"),
        headers: Vec::new(),
        body: Vec::new(),
    })?;
    assert_eq!(
        redir_resp.status, 302,
        "HttpsUpstreamTransport 严禁自动跟随 302 重定向泄露凭据"
    );

    // 2. 通过 LoopbackGateway + gemini_cli_env 走真实 HTTPS 上游（测试 x-goog-api-key 头与 ?key= 查询参数双模式鉴权！）
    let (conscience, graph) = build_sample_conscience_and_graph()?;
    let assembled = ContextAssembler::assemble(
        &conscience,
        &graph,
        &AssemblyRequest::new(BudgetProfile::Standard, 1_795_400_200_000),
    )?;
    let endpoints = quetzalcoatl_harness::GatewayUpstreamEndpoints {
        gemini_base_url: format!("https://localhost:{tls_port}"),
        ..Default::default()
    };
    let gw = LoopbackGateway::new(GatewayConfig { endpoints }, Arc::new(https_transport));
    let mut gw_handle = gw.serve_loopback(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    let gw_addr = gw_handle.bound_addr();

    let grant = gw.register_session(
        &gw_handle.base_url(),
        GatewaySessionConfig {
            run_id: RunId::new_v4(),
            assembled_context: assembled,
            upstream_anthropic_bearer: None,
            upstream_openai_bearer: None,
            upstream_codex_bearer: None,
            upstream_codex_account_id: None,
            upstream_gemini_bearer: Some(String::from("real-gemini-oauth-token")),
        },
    )?;

    let gem_env = gemini_cli_env(&grant.run_base_url, &grant.ephemeral_stub_token);
    let gem_api_key = gem_env
        .get("GEMINI_API_KEY")
        .ok_or("缺少 GEMINI_API_KEY")?
        .clone();

    // 2a. 仅使用 gemini_cli_env 生成的 GEMINI_API_KEY 作为 x-goog-api-key 请求头（不带 x-qz-token） -> 200 OK
    let (st_hdr, _, body_hdr) = send_raw_http(
        gw_addr,
        "POST",
        &format!("/run/{}/v1internal:loadCodeAssist", grant.cap_token),
        &[
            ("Content-Type", "application/json"),
            ("x-goog-api-key", &gem_api_key),
        ],
        br#"{"metadata":{}}"#,
    )?;
    assert_eq!(
        st_hdr, 200,
        "gemini_cli_env 生成的密钥通过 x-goog-api-key 鉴权必须返回 200"
    );
    assert!(String::from_utf8_lossy(&body_hdr).contains("tls-gemini-ok"));

    // 2b. 仅使用 ?key=<GEMINI_API_KEY> 查询参数（Gemini SDK 默认行为，不带 x-qz-token / x-goog-api-key） -> 200 OK 且剥离查询参数中的存根密钥
    let (st_qp, _, body_qp) = send_raw_http(
        gw_addr,
        "POST",
        &format!(
            "/run/{}/v1beta/models/gemini-2.5-pro:generateContent?key={}&alt=json",
            grant.cap_token, gem_api_key
        ),
        &[("Content-Type", "application/json")],
        br#"{"contents":[{"role":"user","parts":[{"text":"hello gemini"}]}]}"#,
    )?;
    assert_eq!(st_qp, 200, "Gemini ?key= 查询参数鉴权必须返回 200");
    assert!(String::from_utf8_lossy(&body_qp).contains("tls-gemini-ok"));

    {
        let recorded = seen_paths.lock().map_err(|_| "seen_paths lock")?;
        let last_path = recorded.last().ok_or("TLS 服务器未收到请求")?;
        assert!(
            !last_path.contains("qz_stub_"),
            "转发至上游时必须剥离查询参数中的沙箱占位密钥: {last_path}"
        );
        assert!(last_path.contains("alt=json"));
    }

    gw_handle.shutdown();
    stop_tls.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], tls_port)),
        std::time::Duration::from_millis(20),
    );
    let _ = tls_thread.join();
    Ok(())
}

#[test]
fn regression_r1_finding6_and_7_codex_opencode_json_parsers_provider_urls_claude_fallback_and_32mb_goose_collision()
-> TestResult {
    // 1. Codex `exec --json` 真实事件帧解析（item.completed 带 item.text + turn.completed 无 final_text）
    let codex_ev1 = AcpJsonRpcDriver::parse_stream_line(
        CodingAgentKind::Codex,
        r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Codex fixed concurrency bug <ewave_check conflict=\"none\" ids=\"\"/>"}}"#,
    );
    assert!(
        codex_ev1
            .iter()
            .any(|e| matches!(e, HarnessEvent::Delta { text } if text.contains("Codex fixed concurrency bug"))),
        "codex exec --json 的 item.completed 必须提取 item.text"
    );

    // 2. OpenCode `run --format json` 真实事件帧解析（type="text" 带 part.text + step_finish）
    let oc_ev1 = AcpJsonRpcDriver::parse_stream_line(
        CodingAgentKind::OpenCode,
        r#"{"type":"text","sessionID":"ses_1","part":{"id":"prt_1","type":"text","text":"OpenCode completed refactor"}}"#,
    );
    assert!(
        oc_ev1.iter().any(
            |e| matches!(e, HarnessEvent::Delta { text } if text == "OpenCode completed refactor")
        ),
        "opencode run --format json 的 type=text 必须提取 part.text"
    );

    // 3. Codex 标准 OpenAI API-key 模式 vs ChatGPT OAuth 模式的 base_url 分流 + Claude 无 OAuth 存根时的 ANTHROPIC_API_KEY 兜底
    let tmp = TempDirGuard::new("qz_r1_f6_f7")?;
    let empty_claude_stub = tmp.path().join("empty_claude_stub");
    fs::create_dir_all(&empty_claude_stub)?;
    let enhancers_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or("repo root")?
        .join("packages/harness-enhancers");

    let grant = quetzalcoatl_harness::GatewaySessionGrant {
        run_id: RunId::new_v4(),
        cap_token: "1".repeat(64),
        qz_token: "2".repeat(64),
        ephemeral_stub_token: format!("qz_stub_{}", "3".repeat(64)),
        run_base_url: format!("http://127.0.0.1:18080/run/{}", "1".repeat(64)),
    };

    let api_key_codex_ctx = HarnessLaunchContext {
        agent_kind: CodingAgentKind::Codex,
        binary_path: PathBuf::from("/usr/local/bin/codex"),
        workspace_dir: tmp.path().to_path_buf(),
        sandbox_exec_path: PathBuf::from("/usr/local/bin/quetzalcoatl-sandbox-exec"),
        sandbox_spec_path: None,
        sandbox_binding: None,
        gateway_grant: grant.clone(),
        claude_stub_dir: Some(empty_claude_stub),
        codex_stub_dir: None,
        active_codex_provider: String::from("openai"),
        codex_uses_chatgpt_oauth: false,
        enhancers_root_dir: Some(enhancers_root),
        mcp_endpoint_url: Some(String::from("http://127.0.0.1:19090/mcp")),
        daemon_ipc_url: None,
        daemon_ipc_token: None,
    };

    let codex_apikey_plan = CodexDriver.build_launch_plan(&api_key_codex_ctx, "test prompt")?;
    let joined_codex_args = codex_apikey_plan.args.join(" ");
    assert!(
        joined_codex_args.contains(&format!(
            "model_providers.openai.base_url=\"{}/openai/v1\"",
            grant.run_base_url
        )),
        "OpenAI API Key 模式下 model_providers.<provider>.base_url 必须指向 /openai/v1，实际为: {joined_codex_args}"
    );
    assert!(
        joined_codex_args.contains("mcp_servers.quetzalcoatl.url="),
        "绑定 mcp_endpoint_url 时 Codex 启动计划应挂载 MCP 配置"
    );
    assert!(
        codex_apikey_plan
            .env
            .contains_key("QUETZALCOATL_CODEX_HOOKS_PATH")
    );

    let claude_fallback_plan =
        ClaudeCodeDriver.build_launch_plan(&api_key_codex_ctx, "test claude")?;
    assert_eq!(
        claude_fallback_plan
            .env
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some(grant.ephemeral_stub_token.as_str()),
        "无宿主 OAuth 凭据存根时 ClaudeCodeDriver 必须注入 ANTHROPIC_API_KEY = ephemeral_stub_token"
    );

    // 4. Finding 7: >32MB 的非标准安装目录同名二进制（例如数据库迁移工具 pressly/goose）绝不可跳过 --version 防撞车校验！
    #[cfg(unix)]
    {
        let bin_dir = tmp.path().join("big_bin");
        fs::create_dir_all(&bin_dir)?;
        let fake_big_goose = bin_dir.join("goose");
        let mut f = fs::File::create(&fake_big_goose)?;
        f.write_all(
            b"#!/bin/sh\necho 'goose version: v3.21.1 (pressly database migration)'\nexit 0\n",
        )?;
        // 填充注释使文件大小 > 33 MiB（触发 >32MB 分支）
        let pad_line = vec![b'#'; 1024];
        for _ in 0..(33 * 1024) {
            f.write_all(&pad_line)?;
            f.write_all(b"\n")?;
        }
        f.flush()?;
        fs::set_permissions(&fake_big_goose, fs::Permissions::from_mode(0o755))?;

        let disc_rep = discover_coding_agents(&DiscoveryConfig {
            search_paths: vec![bin_dir],
            env_overrides: BTreeMap::from([(
                String::from("DBUS_SESSION_BUS_ADDRESS"),
                String::new(),
            )]),
            probe_timeout: std::time::Duration::from_millis(6),
            allow_host_env: false,
        })?;
        assert!(
            !disc_rep
                .agents
                .iter()
                .any(|a| a.kind == CodingAgentKind::Goose),
            ">32MB 的非受管路径 pressly/goose 严禁绕过 --version 被误识别为 Block Goose Coding Agent"
        );
    }

    Ok(())
}

#[test]
fn regression_r2_all_four_mcp_202_native_configs_subdir_delete_git_mv_and_secure_worktree_root()
-> TestResult {
    let tmp = TempDirGuard::new("qz_r2_all_four")?;

    // 1a. JSON-RPC 2.0 §4.1 & MCP Streamable HTTP：无 "id" 字段的通知必须返回 Ok(None) 及 HTTP 202 Accepted 空响应体
    let qz_home = tmp.path().join("qz_home");
    let store = RusqliteWalStore::open(&qz_home.join("spine/spine.sqlite"))?;
    let agent_id = AgentId::new_v4();
    let dev = DeviceIdentity::generate(DeviceId::new_v4())?;
    let root_key = AccountRootKey::from_bytes([0x51; 32]);
    let ring = EpochKeyRing::new_genesis(agent_id, &root_key, dev.public_record())?;
    let spine = SpineEngine::new(
        agent_id,
        dev,
        ring,
        HlcTimestamp::from_parts(1_795_400_500_000, 0, 1),
        store,
    )?;
    let sandbox = SandboxManager::new(SandboxConfig::new(&qz_home));
    let mut kernel = BlindKernel::new(
        spine,
        sandbox,
        HeartScheduler::new(11, 0.2, SleepPhase::Awake),
        LeasePosture::Witnessed {
            witness_epoch: Epoch::new(1),
        },
    );
    let (conscience, graph) = build_sample_conscience_and_graph()?;
    let router_mcp = McpBridgeSession::router_default(BTreeSet::new());

    let notif_res = router_mcp.handle_jsonrpc(
        &mut kernel,
        &conscience,
        &graph,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        1_795_400_500_001,
    )?;
    assert!(
        notif_res.is_none(),
        "无 id 字段的 JSON-RPC Notification 必须返回 None，实际返回: {notif_res:?}"
    );

    let mut mcp_http = quetzalcoatl_harness::serve_mcp_http_loopback(|raw| {
        let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
            quetzalcoatl_types::QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        if v.get("id").is_none() {
            Ok(None)
        } else {
            Ok(Some(String::from(
                r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#,
            )))
        }
    })?;
    let ep_url = mcp_http.endpoint_url().to_owned();
    let after_scheme = ep_url.strip_prefix("http://").ok_or("mcp http scheme")?;
    let (addr_str, path_str) = after_scheme.split_once('/').ok_or("mcp path")?;
    let mcp_addr: SocketAddr = addr_str.parse()?;
    let mcp_path = format!("/{path_str}");

    let (st_202, _, body_202) = send_raw_http(
        mcp_addr,
        "POST",
        &mcp_path,
        &[("Content-Type", "application/json")],
        br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    )?;
    assert_eq!(
        st_202, 202,
        "MCP Streamable HTTP 收到 Notification 必须返回 202 Accepted"
    );
    assert!(body_202.is_empty(), "202 Accepted 通知响应体必须为空字节");
    mcp_http.shutdown();

    // 1b. OpenCode / Claude / Codex 原生 MCP 配置与原生 CLI 钩子参数透传
    let enhancers_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or("repo root")?
        .join("packages/harness-enhancers");
    let grant = quetzalcoatl_harness::GatewaySessionGrant {
        run_id: RunId::new_v4(),
        cap_token: "a".repeat(64),
        qz_token: "b".repeat(64),
        ephemeral_stub_token: format!("qz_stub_{}", "c".repeat(64)),
        run_base_url: format!("http://127.0.0.1:18888/run/{}", "a".repeat(64)),
    };
    let sample_mcp_url = String::from("http://127.0.0.1:19999/mcp/abcd");
    let ctx = HarnessLaunchContext {
        agent_kind: CodingAgentKind::OpenCode,
        binary_path: PathBuf::from("/usr/local/bin/opencode"),
        workspace_dir: tmp.path().to_path_buf(),
        sandbox_exec_path: PathBuf::from("/usr/local/bin/quetzalcoatl-sandbox-exec"),
        sandbox_spec_path: None,
        sandbox_binding: None,
        gateway_grant: grant,
        claude_stub_dir: None,
        codex_stub_dir: None,
        active_codex_provider: String::from("openai"),
        codex_uses_chatgpt_oauth: false,
        enhancers_root_dir: Some(enhancers_root),
        mcp_endpoint_url: Some(sample_mcp_url.clone()),
        daemon_ipc_url: Some(String::from("http://127.0.0.1:17777")),
        daemon_ipc_token: Some("d".repeat(64)),
    };

    let oc_plan = OpenCodeDriver.build_launch_plan(&ctx, "prompt")?;
    let oc_cfg_str = oc_plan
        .env
        .get("OPENCODE_CONFIG_CONTENT")
        .ok_or("OpenCodeDriver 必须通过 OPENCODE_CONFIG_CONTENT 原生传入 MCP 配置")?;
    let oc_cfg_json: serde_json::Value = serde_json::from_str(oc_cfg_str)?;
    assert_eq!(
        oc_cfg_json["mcp"]["quetzalcoatl"]["url"].as_str(),
        Some(sample_mcp_url.as_str())
    );

    let claude_plan = ClaudeCodeDriver.build_launch_plan(&ctx, "prompt")?;
    let mcp_flag_idx = claude_plan
        .args
        .iter()
        .position(|a| a == "--mcp-config")
        .ok_or("ClaudeCodeDriver 必须传入原生 --mcp-config 参数")?;
    let claude_mcp_json: serde_json::Value =
        serde_json::from_str(&claude_plan.args[mcp_flag_idx + 1])?;
    assert_eq!(
        claude_mcp_json["mcpServers"]["quetzalcoatl"]["url"].as_str(),
        Some(sample_mcp_url.as_str())
    );
    let settings_idx = claude_plan
        .args
        .iter()
        .position(|a| a == "--settings")
        .ok_or("ClaudeCodeDriver 在挂载渐进增强器时必须传入原生 --settings 钩子")?;
    let claude_settings_json: serde_json::Value =
        serde_json::from_str(&claude_plan.args[settings_idx + 1])?;
    assert!(claude_settings_json["hooks"]["Stop"].is_array());
    assert!(claude_settings_json["hooks"]["PreCompact"].is_array());

    let codex_plan = CodexDriver.build_launch_plan(&ctx, "prompt")?;
    for (name, plan_env) in [
        ("OpenCode", &oc_plan.env),
        ("Claude Code", &claude_plan.env),
        ("Codex", &codex_plan.env),
    ] {
        assert_eq!(
            plan_env.get(MANAGED_RUN_ENV).map(String::as_str),
            Some("1"),
            "{name} 的受管运行必须带受管标记，让用户层挂载见到即退出"
        );
    }
    assert!(
        codex_plan.args.iter().any(|a| a.starts_with("notify=[")),
        "CodexDriver 在挂载渐进增强器时必须传入原生 -c notify=[...] 钩子参数"
    );

    // 2 & 3. 子目录文件删除 (`rm src/obsolete.rs`) 与暂存重命名 (`git mv src/old_name.rs src/new_name.rs`) 同步验证
    let repo_dir = tmp.path().join("repo");
    fs::create_dir_all(repo_dir.join("src"))?;
    fs::write(repo_dir.join("src/lib.rs"), "pub fn keep() {}\n")?;
    fs::write(repo_dir.join("src/obsolete.rs"), "pub fn drop_me() {}\n")?;
    fs::write(
        repo_dir.join("src/old_name.rs"),
        "pub fn renamed() -> u32 { 7 }\n",
    )?;
    assert!(
        Command::new("git")
            .current_dir(&repo_dir)
            .args(["init", "-q"])
            .status()?
            .success()
    );
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["config", "user.email", "r2@quetzalcoatl.test"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["config", "user.name", "R2"])
        .status()?;
    let _ = Command::new("git")
        .current_dir(&repo_dir)
        .args(["add", "."])
        .status()?;
    assert!(
        Command::new("git")
            .current_dir(&repo_dir)
            .args(["commit", "-q", "-m", "init 3 files"])
            .status()?
            .success()
    );

    let wt_root = tmp.path().join("secure_wts");
    let wt = WorktreeManager::create_detached(&repo_dir, &wt_root, RunId::new_v4())?;
    fs::remove_file(wt.worktree_dir().join("src/obsolete.rs"))?;
    assert!(
        Command::new("git")
            .current_dir(wt.worktree_dir())
            .args(["mv", "src/old_name.rs", "src/new_name.rs"])
            .status()?
            .success()
    );

    let applied = wt.apply_verified_to_repo()?;
    assert!(applied.contains(&String::from("src/obsolete.rs")));
    assert!(applied.contains(&String::from("src/old_name.rs")));
    assert!(applied.contains(&String::from("src/new_name.rs")));
    assert!(
        !repo_dir.join("src/obsolete.rs").exists(),
        "子目录内被删除的跟踪文件必须从主仓库移除"
    );
    assert!(
        !repo_dir.join("src/old_name.rs").exists(),
        "git mv 重命名前的旧路径必须从主仓库移除"
    );
    assert!(repo_dir.join("src/new_name.rs").is_file());
    assert!(repo_dir.join("src/lib.rs").is_file());
    wt.cleanup()?;

    // 4. worktrees_root 符号链接拦截与 0700 权限校验
    #[cfg(unix)]
    {
        let root_mode = fs::symlink_metadata(&wt_root)?.permissions().mode() & 0o777;
        assert_eq!(root_mode, 0o700, "worktrees_root 权限必须严格锁定为 0700");

        let real_target = tmp.path().join("real_dir");
        fs::create_dir_all(&real_target)?;
        let symlink_wt_root = tmp.path().join("symlink_wts");
        std::os::unix::fs::symlink(&real_target, &symlink_wt_root)?;
        let sym_res =
            WorktreeManager::create_detached(&repo_dir, &symlink_wt_root, RunId::new_v4());
        assert!(
            matches!(
                sym_res,
                Err(quetzalcoatl_types::QuetzalcoatlError::SandboxViolation { .. })
            ),
            "符号链接 worktrees_root 必须被拒绝返回 SandboxViolation"
        );
    }

    Ok(())
}

#[test]
fn host_oauth_available_is_read_only_and_recognises_both_providers() -> TestResult {
    let root = TempDirGuard::new("host_oauth_probe")?;
    let claude = root.path().join(".claude");
    let codex = root.path().join(".codex");
    fs::create_dir_all(&claude)?;
    fs::create_dir_all(&codex)?;

    // 空目录：没有凭据。
    assert!(!host_oauth_available(Some(&claude), Some(&codex)));
    assert!(!host_oauth_available(None, None));

    // 同名字段出现在未知 JSON 里才算：只有 refresh_token 时不算可用。
    fs::write(
        claude.join("credentials.json"),
        br#"{"refresh_token":"r","id_token":"i"}"#,
    )?;
    assert!(!host_oauth_available(Some(&claude), None));

    // Claude 形态：accessToken 嵌在嵌套对象里也能识别。
    fs::write(
        claude.join("credentials.json"),
        br#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r"}}"#,
    )?;
    assert!(host_oauth_available(Some(&claude), None));

    // 探测绝不写文件：目录内容与 mtime 不变。
    let before: Vec<String> = fs::read_dir(&claude)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(before, vec![String::from("credentials.json")]);

    // Codex 形态：OPENAI_API_KEY / access_token 任一非空即视为已配置。
    fs::write(codex.join("auth.json"), br#"{"OPENAI_API_KEY":""}"#)?;
    assert!(!host_oauth_available(None, Some(&codex)));
    fs::write(
        codex.join("auth.json"),
        br#"{"tokens":{"access_token":"t"}}"#,
    )?;
    assert!(host_oauth_available(None, Some(&codex)));

    // 非法 JSON 不得 panic，也不得被当成凭据。
    fs::write(codex.join("auth.json"), b"{not json")?;
    assert!(!host_oauth_available(None, Some(&codex)));
    Ok(())
}

/// 多地址回退：`localhost` 常同时解析到 `[::1, 127.0.0.1]`。只监听其中一族时，
/// 传输层必须逐个尝试，而不是「第一个地址连不上就判上游不可达」。
/// CI 的 IPv6-first 解析正是这样把只绑 127.0.0.1 的本地 TLS 上游判死的。
#[test]
fn upstream_transport_falls_back_across_resolved_addresses() -> TestResult {
    use std::net::Ipv6Addr;

    // 前提：本机 `localhost` 同时解析到两族地址。只解析出一族时（不少 Linux 只写 127.0.0.1）
    // 不存在「回退」场景，直接跳过；CI 的 IPv6-first 解析会走到这里。
    if ("localhost", 1).to_socket_addrs()?.count() < 2 {
        return Ok(());
    }
    let listener = match std::net::TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, 0))) {
        Ok(listener) => listener,
        Err(_) => return Ok(()), // 无 IPv6 回环的环境：无意义，跳过。
    };
    let port = listener.local_addr()?.port();
    let server = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nspine!",
            );
        }
    });

    let transport = HttpsUpstreamTransport::new()?;
    let response = transport.roundtrip(&UpstreamRequest {
        method: String::from("GET"),
        scheme: String::from("http"),
        host: String::from("localhost"),
        port,
        path_and_query: String::from("/health"),
        headers: vec![(String::from("host"), format!("localhost:{port}"))],
        body: Vec::new(),
    })?;
    assert_eq!(response.status, 200);
    assert_eq!(response.body, b"spine!");
    let _ = server.join();
    Ok(())
}
