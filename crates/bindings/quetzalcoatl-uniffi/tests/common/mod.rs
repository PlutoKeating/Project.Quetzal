#![allow(dead_code)]

//! 绑定冒烟测试共享工具：定位工作区、构建/定位 cdylib、生成 Kotlin/Swift/C# 绑定。

use std::path::{Path, PathBuf};
use std::process::Command;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .expect("定位工作区根目录")
}

pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn target_dir() -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join("target"))
}

pub fn profile() -> String {
    option_env!("PROFILE").unwrap_or("debug").to_owned()
}

pub fn native_lib_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "quetzalcoatl_uniffi.dll"
    } else if cfg!(target_os = "macos") {
        "libquetzalcoatl_uniffi.dylib"
    } else {
        "libquetzalcoatl_uniffi.so"
    }
}

pub fn native_lib_path() -> PathBuf {
    target_dir().join(profile()).join(native_lib_name())
}

pub fn cargo_bin() -> String {
    std::env::var("CARGO").unwrap_or_else(|_| String::from("cargo"))
}

/// 构建（或复用）`cdylib`；`cargo test` 默认只产出 `rlib`，因此按需构建一次。
pub fn ensure_native_lib() -> Result<PathBuf, String> {
    let lib = native_lib_path();
    if lib.is_file() {
        return Ok(lib);
    }
    let status = Command::new(cargo_bin())
        .current_dir(repo_root())
        .args(["build", "-p", "quetzalcoatl-uniffi", "--lib"])
        .status()
        .map_err(|e| format!("无法启动 cargo build: {e}"))?;
    if !status.success() {
        return Err(format!("cargo build -p quetzalcoatl-uniffi 失败: {status}"));
    }
    if lib.is_file() {
        Ok(lib)
    } else {
        Err(format!("未找到 cdylib: {}", lib.display()))
    }
}

pub struct Skip(pub String);

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("创建目录 {} 失败: {e}", path.display()))
}

/// 调用同包内的 `uniffi-bindgen` 二进制生成指定语言绑定。
pub fn generate_bindings(language: &str, out_dir: &Path) -> Result<PathBuf, String> {
    let lib = ensure_native_lib()?;
    ensure_dir(out_dir)?;
    let bindgen = env!("CARGO_BIN_EXE_uniffi-bindgen");
    let output = Command::new(bindgen)
        .args(["generate"])
        .arg(&lib)
        .args(["-l", language, "-n", "-o"])
        .arg(out_dir)
        .output()
        .map_err(|e| format!("无法启动 uniffi-bindgen: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "uniffi-bindgen ({language}) 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(out_dir.to_path_buf())
}

pub fn find_tool(candidates: &[&str]) -> Option<PathBuf> {
    for candidate in candidates {
        if let Some(home) = std::env::var_os("HOME") {
            let direct = PathBuf::from(&home).join(".cargo/bin").join(candidate);
            if direct.is_file() {
                return Some(direct);
            }
            let dotnet = PathBuf::from(&home).join(".dotnet").join(candidate);
            if dotnet.is_file() {
                return Some(dotnet);
            }
        }
        let Some(path) = std::env::var_os("PATH") else {
            continue;
        };
        for dir in std::env::split_paths(&path) {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

pub fn temp_dir(prefix: &str) -> PathBuf {
    let base = PathBuf::from("/tmp/opencode");
    let parent = if base.is_dir() {
        base
    } else {
        std::env::temp_dir()
    };
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    parent.join(format!("{prefix}_{nonce}_{}", std::process::id()))
}
