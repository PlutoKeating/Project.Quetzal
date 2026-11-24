#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `<10ms` 有界超时并发 Coding Agent 嗅探器与同名工具防撞车校验（防坑规范 #5）。

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use quetzalcoatl_types::Result;
use serde::{Deserialize, Serialize};

/// 支持纳管的桌面底层 Coding Agent 枚举（按推荐优先级排列，`OpenCode` 为默认推荐）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodingAgentKind {
    OpenCode,
    ClaudeCode,
    Codex,
    Pi,
    Goose,
    Hermes,
    Dsh,
    Agy,
}

impl CodingAgentKind {
    pub const ALL: [Self; 8] = [
        Self::OpenCode,
        Self::ClaudeCode,
        Self::Codex,
        Self::Pi,
        Self::Goose,
        Self::Hermes,
        Self::Dsh,
        Self::Agy,
    ];

    #[must_use]
    pub const fn binary_name(self) -> &'static str {
        match self {
            Self::OpenCode => "opencode",
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
            Self::Goose => "goose",
            Self::Hermes => "hermes",
            Self::Dsh => "dsh",
            Self::Agy => "agy",
        }
    }

    #[must_use]
    pub const fn is_default_recommended(self) -> bool {
        matches!(self, Self::OpenCode)
    }

    /// 是否与常见系统/科学计算同名包撞车、必须强制通过 `--version` 特征串正验。
    #[must_use]
    pub const fn requires_strict_version_fingerprint(self) -> bool {
        matches!(self, Self::Pi | Self::Dsh)
    }
}

/// 嗅探配置（默认共享并发截止时间 `6ms`，保证全流程严格 `<10ms`）。
#[derive(Clone, Debug)]
pub struct DiscoveryConfig {
    pub search_paths: Vec<PathBuf>,
    pub env_overrides: BTreeMap<String, String>,
    pub probe_timeout: Duration,
    pub allow_host_env: bool,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        let search_paths = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        Self {
            search_paths,
            env_overrides: BTreeMap::new(),
            probe_timeout: Duration::from_millis(6),
            allow_host_env: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredAgent {
    pub kind: CodingAgentKind,
    pub binary_path: PathBuf,
    pub version_banner: String,
    pub is_default_recommended: bool,
    pub keyring_probed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedCandidate {
    pub binary_name: String,
    pub binary_path: PathBuf,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryReport {
    pub agents: Vec<DiscoveredAgent>,
    pub rejected: Vec<RejectedCandidate>,
    pub recommended: Option<CodingAgentKind>,
    pub elapsed_micros: u64,
    pub linux_keyring_allowed: bool,
}

/// 防坑规范 #5：无有效 `DBUS_SESSION_BUS_ADDRESS` 的无头 SSH/容器环境禁止触碰 `libsecret` / `secret-tool`。
#[must_use]
pub fn can_probe_linux_secret_service(dbus_session_bus_address: Option<&str>) -> bool {
    dbus_session_bus_address.is_some_and(|v| !v.trim().is_empty())
}

/// 核对 `--version` 输出特征串，阻断数学计算器 `/usr/bin/pi (CLN)`、Debian `dsh` 与日志解析器 `grok` 误判。
#[must_use]
pub fn matches_agent_version_signature(binary_name: &str, version_output: &str) -> bool {
    let lower = version_output.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }

    match binary_name.trim().to_ascii_lowercase().as_str() {
        "pi" => {
            if lower.contains("cln")
                || lower.contains("bruno haible")
                || lower.contains("kreckel")
                || lower.contains("archimedes")
                || lower.contains("calculator")
            {
                return false;
            }
            lower.contains("pi-coding-agent")
                || lower.contains("@mariozechner/pi")
                || lower.contains("earendil")
                || lower.contains("badlogic")
                || lower.contains("pi coding")
                || lower.starts_with("pi-agent")
        }
        "dsh" => {
            if lower.contains("dancer")
                || lower.contains("distributed shell")
                || lower.contains("uekawa")
            {
                return false;
            }
            lower.contains("deepseek")
                || lower.contains("superagent")
                || lower.contains("dsh-harness")
        }
        "grok" => {
            if lower.contains("jordan sissel")
                || lower.contains("pattern matching")
                || lower.contains("logstash")
            {
                return false;
            }
            lower.contains("xai") || lower.contains("grok-cli") || lower.contains("coding agent")
        }
        "opencode" => lower.contains("opencode"),
        "claude" => {
            lower.contains("claude") || lower.chars().next().is_some_and(|c| c.is_ascii_digit())
        }
        "codex" => lower.contains("codex"),
        "goose" => {
            if lower.contains("pressly")
                || lower.contains("database migration")
                || lower.contains("goose version:")
            {
                return false;
            }
            lower.contains("goose")
        }
        "hermes" => lower.contains("hermes"),
        "agy" => lower.contains("agy") || lower.contains("antigravity"),
        _ => false,
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        (meta.permissions().mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn find_executable_in_paths(binary_name: &str, search_paths: &[PathBuf]) -> Option<PathBuf> {
    for dir in search_paths {
        let candidate = dir.join(binary_name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let with_ext = dir.join(format!("{binary_name}.{ext}"));
                if is_executable_file(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

/// 零进程开销快速提取符号链接或受管安装目录中的版本提示（仅在命中已知规范安装布局时生效；任何未知路径一律返回 `None` 强制走 `--version` 校验）。
fn fast_filesystem_banner_hint(kind: CodingAgentKind, binary_path: &Path) -> Option<String> {
    if kind.requires_strict_version_fingerprint() {
        return None;
    }
    if let Ok(canon) = fs::canonicalize(binary_path) {
        let canon_str = canon.to_string_lossy();
        if kind == CodingAgentKind::ClaudeCode
            && let Some(idx) = canon_str.find("/claude/versions/")
        {
            let ver = &canon_str[idx + "/claude/versions/".len()..];
            if !ver.is_empty() && !ver.contains('/') {
                return Some(format!("{ver} (Claude Code)"));
            }
        }
        if kind == CodingAgentKind::Codex && canon_str.contains("/.codex/") {
            return Some(String::from("codex-cli (verified install)"));
        }
        if kind == CodingAgentKind::OpenCode && canon_str.contains("/.opencode/") {
            return Some(String::from("opencode (verified install)"));
        }
    }
    None
}

enum ProbeOutcome {
    Accepted(DiscoveredAgent),
    Rejected(RejectedCandidate),
}

fn probe_single_candidate(
    kind: CodingAgentKind,
    binary_path: PathBuf,
    deadline: Instant,
    linux_keyring_allowed: bool,
) -> ProbeOutcome {
    let bin_name = kind.binary_name();
    let fast_hint = fast_filesystem_banner_hint(kind, &binary_path);

    // 对于体积超过 32MB 的自解压 Bun/单文件宿主二进制（如 275MB opencode），冷启动解压需 30-45ms；
    // 若属于非同名撞车专属工具且已通过安装目录校验，直接采用 0ms 文件系统校验结果以确保总耗时严格 <10ms！
    if !kind.requires_strict_version_fingerprint()
        && let Ok(meta) = fs::metadata(&binary_path)
        && meta.len() > 32 * 1024 * 1024
        && let Some(banner) = fast_hint
    {
        return ProbeOutcome::Accepted(DiscoveredAgent {
            kind,
            binary_path,
            version_banner: banner,
            is_default_recommended: kind.is_default_recommended(),
            keyring_probed: false,
        });
    }

    let mut cmd = Command::new(&binary_path);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !linux_keyring_allowed {
        cmd.env_remove("DBUS_SESSION_BUS_ADDRESS");
    }

    let Ok(mut child) = cmd.spawn() else {
        return ProbeOutcome::Rejected(RejectedCandidate {
            binary_name: String::from(bin_name),
            binary_path,
            reason: String::from("spawn --version failed"),
        });
    };

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out_str = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut out_str);
                }
                if let Some(mut err) = child.stderr.take() {
                    let mut err_str = String::new();
                    if err.read_to_string(&mut err_str).is_ok() && !err_str.is_empty() {
                        if !out_str.is_empty() {
                            out_str.push('\n');
                        }
                        out_str.push_str(&err_str);
                    }
                }
                let first_line = out_str
                    .lines()
                    .next()
                    .map(str::trim)
                    .unwrap_or("")
                    .to_owned();

                if !status.success() {
                    return ProbeOutcome::Rejected(RejectedCandidate {
                        binary_name: String::from(bin_name),
                        binary_path,
                        reason: format!("--version exited with non-zero status: {status}"),
                    });
                }

                if matches_agent_version_signature(bin_name, &out_str) {
                    return ProbeOutcome::Accepted(DiscoveredAgent {
                        kind,
                        binary_path,
                        version_banner: if first_line.is_empty() {
                            String::from(bin_name)
                        } else {
                            first_line
                        },
                        is_default_recommended: kind.is_default_recommended(),
                        keyring_probed: false,
                    });
                }

                return ProbeOutcome::Rejected(RejectedCandidate {
                    binary_name: String::from(bin_name),
                    binary_path,
                    reason: format!("version signature mismatch (collision blocked): {first_line}"),
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    if let Some(banner) = fast_hint {
                        return ProbeOutcome::Accepted(DiscoveredAgent {
                            kind,
                            binary_path,
                            version_banner: banner,
                            is_default_recommended: kind.is_default_recommended(),
                            keyring_probed: false,
                        });
                    }
                    return ProbeOutcome::Rejected(RejectedCandidate {
                        binary_name: String::from(bin_name),
                        binary_path,
                        reason: String::from(
                            "strict version fingerprint timed out within <10ms budget",
                        ),
                    });
                }
                thread::sleep(Duration::from_micros(200));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return ProbeOutcome::Rejected(RejectedCandidate {
                    binary_name: String::from(bin_name),
                    binary_path,
                    reason: format!("try_wait error: {e}"),
                });
            }
        }
    }
}

/// 并发扫描本机已安装的 Coding Agent，保证总耗时严格 `<10ms` 且完全免疫同名命令撞车与无头 Keyring 卡死。
pub fn discover_coding_agents(config: &DiscoveryConfig) -> Result<DiscoveryReport> {
    let started = Instant::now();
    let bounded_timeout = config.probe_timeout.min(Duration::from_millis(6));
    let deadline = started + bounded_timeout;

    let dbus_val = if let Some(overridden) = config.env_overrides.get("DBUS_SESSION_BUS_ADDRESS") {
        Some(overridden.clone())
    } else if config.allow_host_env {
        std::env::var("DBUS_SESSION_BUS_ADDRESS").ok()
    } else {
        None
    };
    let linux_keyring_allowed = can_probe_linux_secret_service(dbus_val.as_deref());

    let mut found_candidates = Vec::<(CodingAgentKind, PathBuf)>::new();
    for kind in CodingAgentKind::ALL {
        if let Some(path) = find_executable_in_paths(kind.binary_name(), &config.search_paths) {
            found_candidates.push((kind, path));
        }
    }

    let outcomes: Vec<ProbeOutcome> = thread::scope(|s| {
        let mut handles = Vec::with_capacity(found_candidates.len());
        for (kind, path) in found_candidates {
            handles.push(s.spawn(move || {
                probe_single_candidate(kind, path, deadline, linux_keyring_allowed)
            }));
        }
        let mut collected = Vec::with_capacity(handles.len());
        for h in handles {
            if let Ok(item) = h.join() {
                collected.push(item);
            }
        }
        collected
    });

    let mut agents = Vec::new();
    let mut rejected = Vec::new();
    for out in outcomes {
        match out {
            ProbeOutcome::Accepted(a) => agents.push(a),
            ProbeOutcome::Rejected(r) => rejected.push(r),
        }
    }

    agents.sort_by_key(|a| a.kind);
    let recommended = agents
        .iter()
        .find(|a| a.kind == CodingAgentKind::OpenCode)
        .map(|a| a.kind)
        .or_else(|| agents.first().map(|a| a.kind));

    let elapsed_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);

    Ok(DiscoveryReport {
        agents,
        rejected,
        recommended,
        elapsed_micros,
        linux_keyring_allowed,
    })
}
