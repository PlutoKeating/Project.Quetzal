//! 接上 DeepSeek Harness（dsh）：插件放在 `QUETZALCOATL_HOME/hosts/dsh/` 下，由 dsh 按绝对路径加载；
//! 在 dsh 的用户层补丁 `$DSH_HOME/cordis.patch.yml` 末尾加一段带标记的插入，登记插件与
//! `@deepseek-ai/dsh-mcp-client` → `qz mcp --host dsh`。撤下就是删掉这一段与插件。
//!
//! 补丁对所有 dsh profile 生效。原文件里我们的那段之外的内容一个字都不动。

use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_types::Result;

use crate::host_connect::{DoctorLine, doctor_line, storage_error, write_private};
use crate::local_ipc::IpcClient;

/// 宿主标识。
pub const HOST_DSH: &str = "dsh";
const BLOCK_START: &str = "# >>> quetzalcoatl";
const BLOCK_END: &str = "# <<< quetzalcoatl";

const TPL_INDEX: &str =
    include_str!("../../../packages/harness-enhancers/dsh-plugin/quetzalcoatl/index.ts");
const TPL_PATCH: &str =
    include_str!("../../../packages/harness-enhancers/dsh-plugin/cordis.patch.yml");

/// 接上 dsh 所需的全部位置。
#[derive(Clone, Debug)]
pub struct DshTarget {
    pub qz_home: PathBuf,
    pub qz_bin: PathBuf,
    /// dsh 的家目录（`DSH_HOME` 或 `~/.dsh`）。
    pub dsh_home: PathBuf,
}

impl DshTarget {
    fn host_dir(&self) -> PathBuf {
        self.qz_home.join("hosts").join(HOST_DSH)
    }

    /// 插件入口。
    #[must_use]
    pub fn plugin_path(&self) -> PathBuf {
        self.host_dir().join("plugin").join("index.ts")
    }

    fn patch_path(&self) -> PathBuf {
        self.dsh_home.join("cordis.patch.yml")
    }

    fn record_path(&self) -> PathBuf {
        self.host_dir().join("connect.json")
    }
}

/// 找 dsh 的家目录。
#[must_use]
pub fn dsh_home_dir() -> Option<PathBuf> {
    std::env::var_os("DSH_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".dsh")))
}

fn yaml_string_inner(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap_or_default();
    quoted
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .map(String::from)
        .unwrap_or_default()
}

/// 去掉文件里我们的那一段（含首尾标记行）。没有就原样返回。
fn without_block(text: &str) -> String {
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if line.trim_start().starts_with(BLOCK_START) {
            inside = true;
            continue;
        }
        if inside {
            if line.trim_start().starts_with(BLOCK_END) {
                inside = false;
            }
            continue;
        }
        out.push(line);
    }
    let mut joined = out.join("\n");
    while joined.ends_with("\n\n") {
        joined.pop();
    }
    if !joined.is_empty() && !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

fn has_block(text: &str) -> bool {
    text.lines()
        .any(|line| line.trim_start().starts_with(BLOCK_START))
}

/// 接上 dsh。重复执行会按新版本刷新那一段。
pub fn connect_dsh(target: &DshTarget) -> Result<()> {
    let bin = yaml_string_inner(&target.qz_bin.to_string_lossy());
    write_private(
        &target.plugin_path(),
        &TPL_INDEX.replace("{{QZ_BIN_RAW}}", &bin),
    )?;
    let block = TPL_PATCH
        .replace(
            "{{PLUGIN_URL}}",
            &yaml_string_inner(&target.plugin_path().to_string_lossy()),
        )
        .replace("{{QZ_BIN_RAW}}", &bin);
    let patch = target.patch_path();
    let existed = patch.is_file();
    let current = fs::read_to_string(&patch).unwrap_or_default();
    let rest = without_block(&current);
    let separator = if rest.is_empty() { "" } else { "\n" };
    fs::create_dir_all(&target.dsh_home)
        .map_err(|e| storage_error(format!("无法创建 dsh 家目录: {e}")))?;
    fs::write(&patch, format!("{rest}{separator}{block}"))
        .map_err(|e| storage_error(format!("写 dsh 补丁失败: {e}")))?;
    let created_patch = fs::read_to_string(target.record_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("created_patch").and_then(serde_json::Value::as_bool))
        .unwrap_or(!existed);
    write_private(
        &target.record_path(),
        &serde_json::json!({
            "qz_bin": target.qz_bin.to_string_lossy(),
            "patch": patch.to_string_lossy(),
            "created_patch": created_patch,
        })
        .to_string(),
    )
}

/// 撤下：从补丁里删掉我们的那一段（文件是我们建的、删完只剩空白就整个删掉），再删插件与本地记录。
pub fn disconnect_dsh(target: &DshTarget) -> Result<()> {
    let patch = target.patch_path();
    if let Ok(current) = fs::read_to_string(&patch)
        && has_block(&current)
    {
        let rest = without_block(&current);
        let created = fs::read_to_string(target.record_path())
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v.get("created_patch").and_then(serde_json::Value::as_bool))
            .unwrap_or(false);
        if created && rest.trim().is_empty() {
            fs::remove_file(&patch)
                .map_err(|e| storage_error(format!("删除 dsh 补丁失败: {e}")))?;
        } else {
            fs::write(&patch, rest).map_err(|e| storage_error(format!("写 dsh 补丁失败: {e}")))?;
        }
    }
    let host_dir = target.host_dir();
    if host_dir.exists() {
        fs::remove_dir_all(&host_dir)
            .map_err(|e| storage_error(format!("删除 dsh 插件失败: {e}")))?;
    }
    Ok(())
}

fn connected(target: &DshTarget) -> bool {
    target.plugin_path().is_file()
        && fs::read_to_string(target.patch_path()).is_ok_and(|text| has_block(&text))
}

/// 治理面「宿主」页用的本机状态。
pub(crate) fn dsh_local_state(qz_home: &Path) -> crate::host_connect::ClaudeCodeLocalState {
    let connected = dsh_home_dir().is_some_and(|dsh_home| {
        connected(&DshTarget {
            qz_home: qz_home.to_path_buf(),
            qz_bin: PathBuf::new(),
            dsh_home,
        })
    });
    let on_path = std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join("dsh").is_file()));
    crate::host_connect::ClaudeCodeLocalState {
        installed: on_path || connected,
        connected,
        session_start: connected,
        prompt_submit: connected,
        stop: connected,
    }
}

/// 诊断：守护进程、插件、补丁。
#[must_use]
pub fn doctor_dsh(qz_home: &Path, target: &DshTarget) -> Vec<DoctorLine> {
    let daemon_ok = IpcClient::connect_from_home(qz_home)
        .ok()
        .flatten()
        .is_some();
    let plugin_current = fs::read_to_string(target.plugin_path())
        .is_ok_and(|text| text.contains(&yaml_string_inner(&target.qz_bin.to_string_lossy())));
    let patched = fs::read_to_string(target.patch_path()).is_ok_and(|text| has_block(&text));
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
        if plugin_current {
            doctor_line(true, "插件", "在，指向现在这个 qz")
        } else {
            doctor_line(false, "插件", "没有或指向旧的 qz：执行 qz connect")
        },
        if patched {
            doctor_line(
                true,
                "补丁",
                "已登记进 dsh 的用户层补丁，对所有 profile 生效；重启 dsh 后生效",
            )
        } else {
            doctor_line(false, "补丁", "dsh 的用户层补丁里没有：执行 qz connect")
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::{DshTarget, connect_dsh, disconnect_dsh, has_block};

    #[test]
    fn the_users_own_patch_is_kept_word_for_word_around_our_block()
    -> Result<(), Box<dyn std::error::Error>> {
        let root =
            std::env::temp_dir().join(format!("qz-dsh-connect-{}", crate::daemon::now_unix_ms()));
        let target = DshTarget {
            qz_home: root.join("home"),
            qz_bin: root.join("bin/qz"),
            dsh_home: root.join(".dsh"),
        };
        std::fs::create_dir_all(&target.dsh_home)?;
        let theirs = "# my overrides\n- id: ui-theme\n  config:\n    fontSize: 14\n";
        std::fs::write(target.dsh_home.join("cordis.patch.yml"), theirs)?;

        connect_dsh(&target)?;
        connect_dsh(&target)?;
        let patched = std::fs::read_to_string(target.dsh_home.join("cordis.patch.yml"))?;
        assert!(patched.starts_with(theirs), "{patched}");
        assert_eq!(
            patched.matches("# >>> quetzalcoatl").count(),
            1,
            "重复执行只有一段"
        );
        assert!(patched.contains("@deepseek-ai/dsh-mcp-client"));
        assert!(patched.contains(&target.plugin_path().to_string_lossy().into_owned()));
        assert!(!patched.contains("{{"));
        let plugin = std::fs::read_to_string(target.plugin_path())?;
        assert!(plugin.contains(&target.qz_bin.to_string_lossy().into_owned()));

        disconnect_dsh(&target)?;
        let after = std::fs::read_to_string(target.dsh_home.join("cordis.patch.yml"))?;
        assert_eq!(after, theirs, "撤下后用户自己的补丁一字不差");
        assert!(!has_block(&after));
        assert!(!target.plugin_path().exists());

        // 补丁文件原本不存在：撤下后连文件一起删掉。
        std::fs::remove_file(target.dsh_home.join("cordis.patch.yml"))?;
        connect_dsh(&target)?;
        disconnect_dsh(&target)?;
        assert!(!target.dsh_home.join("cordis.patch.yml").exists());
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }
}
