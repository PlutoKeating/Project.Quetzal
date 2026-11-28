#![forbid(unsafe_code)]

//! 桌面端持久化配置：窗口尺寸、最大化状态与上次停留的页。
//!
//! 配置目录优先级（全部只读环境变量，不写回）：
//! 1. `QUETZALCOATL_DESKTOP_CONFIG_DIR`（显式覆盖，测试与便携部署用）；
//! 2. `XDG_CONFIG_HOME/quetzalcoatl-desktop`；
//! 3. `$HOME/.config/quetzalcoatl-desktop`。
//!
//! 落盘采用「同目录、按进程唯一的临时文件 + rename」的原子替换（应用允许多实例，
//! 临时名必须含 pid 以免互相覆盖）；损坏或字段缺失的 JSON 整体回退默认配置，
//! 绝不逐字段猜测、也绝不弹错误对话框（缺失/损坏配置不是用户需要被打断的错误）。
//! 旧版本写下的 `density` 字段会被忽略。
//!
//! 关于窗口位置：GTK4 已移除 `gtk_window_get_position()` / `gtk_window_move()`，
//! Wayland 合成器亦禁止客户端指定绝对坐标，因此本端持久化**尺寸**（`default_width` /
//! `default_height`）与**最大化状态**，位置完全交由合成器管理并在 README 中如实说明。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 显式配置目录覆盖（测试与便携安装使用）。
pub const CONFIG_DIR_ENV: &str = "QUETZALCOATL_DESKTOP_CONFIG_DIR";
/// 配置文件文件名。
pub const CONFIG_FILE_NAME: &str = "desktop.json";

const MIN_WIDTH: i32 = 360;
const MAX_WIDTH: i32 = 4096;
const MIN_HEIGHT: i32 = 400;
const MAX_HEIGHT: i32 = 3072;

fn default_page() -> String {
    String::from("overview")
}

/// 桌面端配置（向后兼容：缺失字段一律取默认值）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopConfig {
    /// 窗口默认宽度（像素）。
    pub width: i32,
    /// 窗口默认高度（像素）。
    pub height: i32,
    /// 上次关闭时是否最大化。
    #[serde(default)]
    pub maximized: bool,
    /// 上次停留的页（机器名，例如 `memories`）。
    #[serde(default = "default_page")]
    pub page: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 820,
            maximized: false,
            page: default_page(),
        }
    }
}

impl DesktopConfig {
    /// 解析配置目录（不创建任何目录）。
    #[must_use]
    pub fn config_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os(CONFIG_DIR_ENV) {
            return Some(PathBuf::from(dir));
        }
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME")
            && !xdg.is_empty()
        {
            return Some(PathBuf::from(xdg).join("quetzalcoatl-desktop"));
        }
        std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(|home| PathBuf::from(home).join(".config/quetzalcoatl-desktop"))
    }

    /// 默认配置文件路径（无家目录时为 `None`，此时不持久化）。
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        Self::config_dir().map(|dir| dir.join(CONFIG_FILE_NAME))
    }

    /// 读取配置；文件缺失、不可读或 JSON 损坏时静默回退默认值。
    #[must_use]
    pub fn load_from(path: Option<&Path>) -> Self {
        let Some(path) = path else {
            return Self::default();
        };
        let Ok(raw) = fs::read(path) else {
            return Self::default();
        };
        match serde_json::from_slice::<Self>(&raw) {
            Ok(config) => config.sanitized(),
            Err(_) => Self::default(),
        }
    }

    /// 原子写入配置；写失败只返回 `io::Error`，由调用方决定是否记录（绝不弹窗）。
    pub fn save_to(&self, path: Option<&Path>) -> io::Result<()> {
        let Some(path) = path.map(Path::to_path_buf).or_else(Self::default_path) else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json =
            serde_json::to_vec_pretty(&self.clone().sanitized()).map_err(io::Error::other)?;
        // 应用声明 NON_UNIQUE（多实例），临时文件必须按进程唯一，避免互相覆盖。
        let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&temp, json)?;
        fs::rename(&temp, &path)
    }

    /// 把尺寸夹到可用区间，防止损坏配置把窗口缩成不可见的 1×1。
    #[must_use]
    pub fn sanitized(mut self) -> Self {
        self.width = self.width.clamp(MIN_WIDTH, MAX_WIDTH);
        self.height = self.height.clamp(MIN_HEIGHT, MAX_HEIGHT);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_density_field_is_ignored_and_size_is_clamped() {
        let raw = br#"{"density":"workbench","width":1,"height":99999,"maximized":true}"#;
        let config: DesktopConfig = serde_json::from_slice(raw).unwrap_or_default();
        let config = config.sanitized();
        assert_eq!(config.width, MIN_WIDTH);
        assert_eq!(config.height, MAX_HEIGHT);
        assert!(config.maximized);
        assert_eq!(config.page, "overview");
    }
}
