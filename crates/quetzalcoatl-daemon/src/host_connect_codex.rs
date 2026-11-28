//! 接上 Codex：写出本地插件源，用 Codex 自己的插件命令装入；可重复执行，可一步撤下。
//!
//! 与 Claude Code 的差别：Codex 把新装的钩子标为未信任并跳过，第一次要用户在 Codex 里
//! 信任一次（`/hooks`）；Codex 按插件版本号缓存插件，升级时版本号变了才会刷新。

use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_types::Result;
use serde_json::Value;

use crate::host_connect::{
    DoctorLine, doctor_line, json_string_inner, run_host_cli, shell_quote, storage_error,
    write_private,
};
use crate::local_ipc::IpcClient;

/// 宿主标识。
pub const HOST_CODEX: &str = "codex";
/// 本地插件源的名字与插件编号。
pub const CODEX_MARKETPLACE: &str = "quetzalcoatl-local";
pub const CODEX_PLUGIN_ID: &str = "quetzalcoatl@quetzalcoatl-local";

const TPL_MARKETPLACE: &str = include_str!(
    "../../../packages/harness-enhancers/codex-plugin/.agents/plugins/marketplace.json"
);
const TPL_PLUGIN: &str = include_str!(
    "../../../packages/harness-enhancers/codex-plugin/plugins/quetzalcoatl/.codex-plugin/plugin.json"
);
const TPL_HOOKS: &str = include_str!(
    "../../../packages/harness-enhancers/codex-plugin/plugins/quetzalcoatl/hooks/hooks.json"
);
const TPL_MCP: &str =
    include_str!("../../../packages/harness-enhancers/codex-plugin/plugins/quetzalcoatl/.mcp.json");

/// 接上 Codex 所需的全部位置。
#[derive(Clone, Debug)]
pub struct CodexTarget {
    pub qz_home: PathBuf,
    pub qz_bin: PathBuf,
    pub codex_bin: PathBuf,
    /// Codex 的配置目录（`CODEX_HOME` 或 `~/.codex`）。
    pub codex_home: PathBuf,
}

impl CodexTarget {
    fn host_dir(&self) -> PathBuf {
        self.qz_home.join("hosts").join(HOST_CODEX)
    }

    /// 本地插件源目录。
    #[must_use]
    pub fn plugin_source_dir(&self) -> PathBuf {
        self.host_dir().join("marketplace")
    }

    fn record_path(&self) -> PathBuf {
        self.host_dir().join("connect.json")
    }
}

fn write_plugin_source(target: &CodexTarget) -> Result<()> {
    let root = target.plugin_source_dir();
    let quoted_bin = json_string_inner(&shell_quote(&target.qz_bin));
    let raw_bin = json_string_inner(&target.qz_bin.to_string_lossy());
    let fill = |template: &str| {
        template
            .replace("{{QZ_BIN_RAW}}", &raw_bin)
            .replace("{{QZ_BIN}}", &quoted_bin)
            .replace("{{QZ_VERSION}}", env!("CARGO_PKG_VERSION"))
    };
    let plugin = root.join("plugins/quetzalcoatl");
    write_private(
        &root.join(".agents/plugins/marketplace.json"),
        &fill(TPL_MARKETPLACE),
    )?;
    write_private(&plugin.join(".codex-plugin/plugin.json"), &fill(TPL_PLUGIN))?;
    write_private(&plugin.join("hooks/hooks.json"), &fill(TPL_HOOKS))?;
    write_private(&plugin.join(".mcp.json"), &fill(TPL_MCP))?;
    Ok(())
}

/// 接上 Codex。重复执行不会重复写；升级后再执行会按新版本号刷新插件。
pub fn connect_codex(target: &CodexTarget) -> Result<()> {
    write_plugin_source(target)?;
    let source = target.plugin_source_dir();
    let source_arg = source.to_string_lossy().into_owned();
    run_host_cli(
        &target.codex_bin,
        &["plugin", "marketplace", "add", "--json", &source_arg],
    )?;
    run_host_cli(&target.codex_bin, &["plugin", "add", CODEX_PLUGIN_ID])?;
    write_private(
        &target.record_path(),
        &serde_json::json!({ "qz_bin": target.qz_bin.to_string_lossy() }).to_string(),
    )
}

/// 撤下：卸载插件、移除本地插件源、删掉本地记录。
pub fn disconnect_codex(target: &CodexTarget) -> Result<()> {
    let _ = run_host_cli(&target.codex_bin, &["plugin", "remove", CODEX_PLUGIN_ID]);
    let _ = run_host_cli(
        &target.codex_bin,
        &["plugin", "marketplace", "remove", CODEX_MARKETPLACE],
    );
    let host_dir = target.host_dir();
    if host_dir.exists() {
        fs::remove_dir_all(&host_dir)
            .map_err(|e| storage_error(format!("删除本地插件源失败: {e}")))?;
    }
    Ok(())
}

fn plugin_installed(target: &CodexTarget) -> Option<bool> {
    let stdout = run_host_cli(&target.codex_bin, &["plugin", "list", "--json"]).ok()?;
    let listed: Value = serde_json::from_str(stdout.trim()).ok()?;
    Some(
        listed
            .get("installed")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("pluginId").and_then(Value::as_str) == Some(CODEX_PLUGIN_ID)
                        && item.get("enabled").and_then(Value::as_bool) != Some(false)
                })
            }),
    )
}

/// Codex 的配置里信任了我们几个钩子。
fn trusted_hook_count(codex_home: &Path) -> usize {
    let Ok(config) = fs::read_to_string(codex_home.join("config.toml")) else {
        return 0;
    };
    let prefix = format!("[hooks.state.\"{CODEX_PLUGIN_ID}:");
    let mut count = 0;
    let mut in_ours = false;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_ours = line.starts_with(&prefix);
            continue;
        }
        if in_ours && line.starts_with("trusted_hash") {
            count += 1;
            in_ours = false;
        }
    }
    count
}

/// 诊断：守护进程、插件、钩子信任。
#[must_use]
pub fn doctor_codex(qz_home: &Path, target: &CodexTarget) -> Vec<DoctorLine> {
    let daemon_ok = IpcClient::connect_from_home(qz_home)
        .ok()
        .flatten()
        .is_some();
    let mut lines = vec![doctor_line(
        daemon_ok,
        "守护进程",
        if daemon_ok {
            "在运行"
        } else {
            "没有运行：在终端执行 qz up"
        },
    )];
    lines.push(match plugin_installed(target) {
        Some(true) => doctor_line(true, "插件", "已装入并启用"),
        Some(false) => doctor_line(false, "插件", "没有装入：执行 qz connect"),
        None => doctor_line(false, "插件", "读不到 Codex 的插件列表"),
    });
    let trusted = trusted_hook_count(&target.codex_home);
    lines.push(if trusted >= 4 {
        doctor_line(true, "钩子信任", "四个钩子都已信任")
    } else {
        doctor_line(
            false,
            "钩子信任",
            format!(
                "已信任 {trusted} 个：打开 Codex，在 /hooks 里信任 Quetzalcoatl 的钩子（工具通道不受影响）"
            ),
        )
    });
    lines
}

/// 找 Codex 的配置目录。
#[must_use]
pub fn codex_home_dir() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
}
