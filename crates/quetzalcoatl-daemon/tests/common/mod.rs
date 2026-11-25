#![allow(dead_code)]

//! 守护进程集成测试共享工具：短路径临时目录。
//!
//! 守护进程会在 `QUETZALCOATL_HOME` 下绑定 `run/daemon.sock`，而 Unix 域套接字路径受
//! Linux `SUN_LEN`（108 字节，含结尾 NUL）硬限制。仓库位于深层目录或 `TMPDIR` 较长时，
//! 普通测试目录名会让 socket 绑定以晦涩错误失败，因此这里统一使用极短的
//! `<temp>/q<pid>-<tag>-<6hex>` 目录，并在创建时提前校验路径预算。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Unix 域套接字路径预算：`sun_path` 上限 108 字节，预留嵌套片段与安全余量后按 100 校验。
pub const UNIX_SOCKET_PATH_BUDGET: usize = 100;

/// 为最长的嵌套 socket 片段（如 `/quetzalcoatl_home/run/daemon.sock`）预留的字节数。
const NESTED_SOCKET_BUDGET: usize = 40;

/// 进程内单调递增序号，配合 pid 与时间熵避免并行测试目录撞名。
static SEQ: AtomicU64 = AtomicU64::new(0);

/// 创建单个测试独占的短临时目录 `<temp>/q<pid>-<tag>-<6hex>`，名称总长 ≤ 24 字节。
///
/// 若 `TMPDIR` 过长导致嵌套 socket 路径逼近 `SUN_LEN`，返回清晰错误而不是等到
/// 绑定 socket 时才失败；目录由调用方守卫负责递归清理。
pub fn temp_root(prefix: &str) -> std::io::Result<PathBuf> {
    let base = std::env::temp_dir();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    let nonce = (nanos ^ (u64::from(std::process::id()) << 20) ^ seq) & 0xff_ffff;
    let tag: String = prefix.chars().take(6).collect();
    let dir = base.join(format!("q{}-{tag}-{nonce:06x}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    enforce_socket_budget(&dir)?;
    Ok(dir)
}

/// 若目录加上最坏嵌套 socket 片段后仍逼近 `SUN_LEN`，直接给出可诊断的错误。
fn enforce_socket_budget(dir: &Path) -> std::io::Result<()> {
    let worst = dir.as_os_str().len() + NESTED_SOCKET_BUDGET;
    if worst >= UNIX_SOCKET_PATH_BUDGET {
        let dir = dir.display();
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "测试临时目录过长：{worst} 字节（含嵌套预留 {NESTED_SOCKET_BUDGET}）≥ \
                 {UNIX_SOCKET_PATH_BUDGET} 字节安全上限，Unix socket 路径将超过 SUN_LEN(108)；\
                 请缩短 TMPDIR，当前目录 {dir}"
            ),
        ));
    }
    Ok(())
}
