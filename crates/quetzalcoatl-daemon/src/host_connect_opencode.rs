//! 接上 OpenCode（v2）：把插件目录放进 OpenCode 的用户配置目录下的 `plugins/`，它会自己加载；
//! 插件自己登记 MCP 服务，所以不改用户的配置文件。撤下就是删掉这个目录。
//!
//! 插件里的每个挂点都调用 `qz hook --host opencode`，工具经 `qz mcp --host opencode`。

use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_types::Result;

use crate::host_connect::{DoctorLine, doctor_line, storage_error, write_private};
use crate::local_ipc::IpcClient;

/// 宿主标识。
pub const HOST_OPENCODE: &str = "opencode";
/// 插件包名：用来认出这个目录是我们放的。
const PACKAGE_NAME: &str = "quetzalcoatl-opencode";

const TPL_PACKAGE: &str =
    include_str!("../../../packages/harness-enhancers/opencode-plugin/quetzalcoatl/package.json");
const TPL_INDEX: &str =
    include_str!("../../../packages/harness-enhancers/opencode-plugin/quetzalcoatl/index.ts");

/// 接上 OpenCode 所需的全部位置。
#[derive(Clone, Debug)]
pub struct OpenCodeTarget {
    pub qz_home: PathBuf,
    pub qz_bin: PathBuf,
    /// OpenCode 的用户配置目录（`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`）。
    pub config_dir: PathBuf,
}

impl OpenCodeTarget {
    /// 插件目录。
    #[must_use]
    pub fn plugin_dir(&self) -> PathBuf {
        self.config_dir.join("plugins").join("quetzalcoatl")
    }

    fn record_path(&self) -> PathBuf {
        self.qz_home
            .join("hosts")
            .join(HOST_OPENCODE)
            .join("connect.json")
    }
}

/// 找 OpenCode 的用户配置目录。
#[must_use]
pub fn opencode_config_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .map(|base| base.join("opencode"))
}

fn ours(dir: &Path) -> bool {
    fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
        .is_some_and(|name| name == PACKAGE_NAME)
}

/// TypeScript 字符串字面量里的内容。
fn ts_string_inner(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap_or_default();
    quoted
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .map(String::from)
        .unwrap_or_default()
}

/// 接上 OpenCode。重复执行会按新版本刷新；同名目录若不是我们放的，先挪到一边。
pub fn connect_opencode(target: &OpenCodeTarget) -> Result<()> {
    let dir = target.plugin_dir();
    if dir.exists() && !ours(&dir) {
        let aside = dir.with_file_name(format!(
            "quetzalcoatl.before-qz-{}",
            crate::daemon::now_unix_ms()
        ));
        fs::rename(&dir, &aside)
            .map_err(|e| storage_error(format!("无法把原来的插件目录挪到一边: {e}")))?;
    }
    let bin = ts_string_inner(&target.qz_bin.to_string_lossy());
    let fill = |template: &str| {
        template
            .replace("{{QZ_BIN_RAW}}", &bin)
            .replace("{{QZ_VERSION}}", env!("CARGO_PKG_VERSION"))
    };
    write_private(&dir.join("package.json"), &fill(TPL_PACKAGE))?;
    write_private(&dir.join("index.ts"), &fill(TPL_INDEX))?;
    write_private(
        &target.record_path(),
        &serde_json::json!({
            "qz_bin": target.qz_bin.to_string_lossy(),
            "plugin_dir": dir.to_string_lossy(),
        })
        .to_string(),
    )
}

/// 撤下：删掉我们放的插件目录与本地记录。别人的同名目录不动。
pub fn disconnect_opencode(target: &OpenCodeTarget) -> Result<()> {
    let dir = target.plugin_dir();
    if dir.exists() && ours(&dir) {
        fs::remove_dir_all(&dir).map_err(|e| storage_error(format!("删除插件目录失败: {e}")))?;
    }
    let record = target.record_path();
    if let Some(host_dir) = record.parent()
        && host_dir.exists()
    {
        fs::remove_dir_all(host_dir)
            .map_err(|e| storage_error(format!("删除本地记录失败: {e}")))?;
    }
    Ok(())
}

/// 接上没有：记录在、插件目录在且是我们的。
#[must_use]
pub fn opencode_connected(target: &OpenCodeTarget) -> bool {
    target.record_path().is_file() && ours(&target.plugin_dir())
}

/// 治理面「宿主」页用的本机状态：插件目录里四个挂点都在插件里，所以只看插件目录在不在。
#[must_use]
pub(crate) fn opencode_local_state(qz_home: &Path) -> crate::host_connect::ClaudeCodeLocalState {
    let record = qz_home
        .join("hosts")
        .join(HOST_OPENCODE)
        .join("connect.json");
    let plugin_dir = fs::read_to_string(&record)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("plugin_dir")
                .and_then(|d| d.as_str())
                .map(PathBuf::from)
        });
    let connected = plugin_dir.as_deref().is_some_and(ours);
    let on_path = std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| dir.join("opencode").is_file())
    }) || std::env::var_os("HOME")
        .is_some_and(|home| PathBuf::from(home).join(".opencode/bin/opencode").is_file());
    crate::host_connect::ClaudeCodeLocalState {
        installed: on_path || connected,
        connected,
        session_start: connected,
        prompt_submit: connected,
        stop: connected,
    }
}

/// 诊断：守护进程、插件。
#[must_use]
pub fn doctor_opencode(qz_home: &Path, target: &OpenCodeTarget) -> Vec<DoctorLine> {
    let daemon_ok = IpcClient::connect_from_home(qz_home)
        .ok()
        .flatten()
        .is_some();
    let dir = target.plugin_dir();
    let current = fs::read_to_string(dir.join("index.ts"))
        .is_ok_and(|text| text.contains(&ts_string_inner(&target.qz_bin.to_string_lossy())));
    vec![
        doctor_line(
            daemon_ok,
            "守护进程",
            if daemon_ok {
                "在运行"
            } else {
                "没有运行：在终端执行 qz up"
            },
        ),
        if !ours(&dir) {
            doctor_line(false, "插件", "没有放进 OpenCode：执行 qz connect")
        } else if current {
            doctor_line(
                true,
                "插件",
                "已放进 OpenCode；它的后台服务会自己加载，没生效就执行 opencode service restart",
            )
        } else {
            doctor_line(
                false,
                "插件",
                "指向的 qz 不是现在这个：再执行一次 qz connect",
            )
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::{OpenCodeTarget, connect_opencode, disconnect_opencode, opencode_connected};

    #[test]
    fn connecting_drops_one_directory_and_disconnecting_takes_only_ours_away()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!(
            "qz-opencode-connect-{}",
            crate::daemon::now_unix_ms()
        ));
        let target = OpenCodeTarget {
            qz_home: root.join("home"),
            qz_bin: root.join("bin dir/qz"),
            config_dir: root.join("config/opencode"),
        };
        // 用户自己有个同名目录：挪到一边，不删。
        std::fs::create_dir_all(target.plugin_dir())?;
        std::fs::write(
            target.plugin_dir().join("package.json"),
            r#"{"name":"theirs"}"#,
        )?;

        connect_opencode(&target)?;
        assert!(opencode_connected(&target));
        let index = std::fs::read_to_string(target.plugin_dir().join("index.ts"))?;
        assert!(index.contains(&format!("\"{}\"", target.qz_bin.display())));
        assert!(!index.contains("{{QZ_BIN_RAW}}"));
        let aside: Vec<_> = std::fs::read_dir(target.config_dir.join("plugins"))?
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("quetzalcoatl.before-qz-")
            })
            .collect();
        assert_eq!(aside.len(), 1, "原来的目录挪到一边");

        connect_opencode(&target)?;
        assert!(opencode_connected(&target), "重复执行仍然接着");

        disconnect_opencode(&target)?;
        assert!(!target.plugin_dir().exists());
        assert!(!opencode_connected(&target));
        assert_eq!(
            std::fs::read_dir(target.config_dir.join("plugins"))?.count(),
            1,
            "别人的目录还在"
        );
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }
}
