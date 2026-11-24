#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 零遥测与体积门禁：
//! 1. 默认构建参考二进制的本 crate 增量 `< 3.0 MB`；
//! 2. 默认构建不包含任何 ONNX Runtime 遥测路径/符号；
//! 3. 密封子进程连续运行 120 s 的 VAD/AEC 路径，零出站连接尝试；
//! 4. `ORT_DISABLE_TELEMETRY=1` 在每条模型加载路径上都存在。

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use ed25519_dalek::SigningKey;

use quetzalcoatl_voice_ai::ort_loader::{
    AiPackKind, ORT_DISABLE_TELEMETRY, OnDemandAiPackManager, PackFileEntry, PackManifest,
    PackSource,
};

const SIZE_LIMIT_BYTES: u64 = 3_000_000;

// ---------------------------------------------------------------------------
// 参考探针构建（体积门禁 + 密封子进程复用同一二进制）
// ---------------------------------------------------------------------------

struct ProbeBuild {
    root: PathBuf,
    with_dep: PathBuf,
    baseline: PathBuf,
}

static PROBE: OnceLock<ProbeBuild> = OnceLock::new();

fn workspace_crate_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn probe_root() -> PathBuf {
    let unique = format!(
        "qz-voice-size-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    std::env::temp_dir().join(unique)
}

fn write_probe_package(root: &Path, name: &str, with_dep: bool) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(dir.join("src")).expect("创建探针目录");
    let dep_line = if with_dep {
        format!(
            "quetzalcoatl-voice-ai = {{ path = {:?} }}\n",
            workspace_crate_dir()
        )
    } else {
        String::new()
    };
    let manifest = format!(
        "[package]\nname = \"{name}\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n\
         [profile.release]\nstrip = \"symbols\"\npanic = \"abort\"\noverflow-checks = false\n\n\
         [dependencies]\n{dep_line}"
    );
    fs::write(dir.join("Cargo.toml"), manifest).expect("写探针 Cargo.toml");

    let main_rs = if with_dep {
        r#"use quetzalcoatl_voice_ai::aec_vad::{DuplexAudioGate, GateConfig};

fn run_gate_forever() {
    let mut gate = DuplexAudioGate::new(GateConfig::default()).expect("gate");
    let mut frame = [0.0_f32; 320];
    let mut index: u64 = 0;
    loop {
        for (i, sample) in frame.iter_mut().enumerate() {
            let t = (index as usize * 320 + i) as f32 / 16000.0;
            *sample = 0.2 * (std::f32::consts::TAU * 180.0 * t).sin();
        }
        let mut capture = frame;
        capture[0] += 0.001;
        let _decision = gate.process_frame(&frame, &capture, true).expect("frame");
        index += 1;
    }
}

fn main() {
    let soak = std::env::var("QZ_VOICE_SOAK_SECS").ok();
    if let Some(secs) = soak {
        let secs: u64 = secs.parse().unwrap_or(120);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        let mut gate = DuplexAudioGate::new(GateConfig::default()).expect("gate");
        let mut frame = [0.0_f32; 320];
        let mut index: u64 = 0;
        while std::time::Instant::now() < deadline {
            for (i, sample) in frame.iter_mut().enumerate() {
                let t = (index as usize * 320 + i) as f32 / 16000.0;
                *sample = 0.15 * (std::f32::consts::TAU * 160.0 * t).sin();
            }
            let mut capture = frame;
            capture[1] += 0.0005;
            let _ = gate.process_frame(&frame, &capture, true).expect("frame");
            index += 1;
            if std::env::var("QZ_VOICE_SOAK_CHECK_FDS").is_ok() && has_socket_fd() {
                std::process::exit(7);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        std::process::exit(0);
    }
    run_gate_forever();
}

fn has_socket_fd() -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = std::fs::read_dir("/proc/self/fd") {
            for entry in entries.flatten() {
                if let Ok(target) = std::fs::read_link(entry.path())
                    && target.to_string_lossy().starts_with("socket:")
                {
                    return true;
                }
            }
        }
    }
    false
}
"#
    } else {
        "fn main() { println!(\"baseline\"); }\n"
    };
    fs::write(dir.join("src/main.rs"), main_rs).expect("写探针 main.rs");
    dir
}

fn build_release_binary(dir: &Path) -> PathBuf {
    let target_dir = dir.join("target");
    let cargo = std::env::var("CARGO")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| String::from("cargo"));
    let status = Command::new(cargo)
        .arg("build")
        .arg("--release")
        .arg("--offline")
        .current_dir(dir)
        .env("CARGO_TARGET_DIR", &target_dir)
        .env("CARGO_NET_OFFLINE", "true")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .expect("启动 cargo 构建探针");
    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        panic!("探针构建失败:\n{stderr}");
    }
    target_dir.join("release").join(
        dir.file_name()
            .and_then(|name| name.to_str())
            .expect("探针包名"),
    )
}

fn probe() -> &'static ProbeBuild {
    PROBE.get_or_init(|| {
        let root = probe_root();
        let with_dir = write_probe_package(&root, "voice_size_probe_with", true);
        let base_dir = write_probe_package(&root, "voice_size_probe_base", false);
        let with_dep = build_release_binary(&with_dir);
        let baseline = build_release_binary(&base_dir);
        ProbeBuild {
            root,
            with_dep,
            baseline,
        }
    })
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).expect("读取探针元数据").len()
}

/// 体积门禁：默认特性 release 参考二进制因本 crate 产生的增量必须 `< 3.0 MB`。
#[test]
#[ignore = "专用 CI 作业：会构建 release 探针 crate，默认测试套件不得调用 cargo"]
fn incremental_release_size_is_under_three_megabytes() {
    let probe = probe();
    let with_size = file_len(&probe.with_dep);
    let base_size = file_len(&probe.baseline);
    let delta = with_size.saturating_sub(base_size);
    eprintln!(
        "voice-ai size gate: with={with_size} B baseline={base_size} B delta={delta} B ({:.3} MiB)",
        delta as f64 / (1024.0 * 1024.0)
    );
    assert!(
        delta < SIZE_LIMIT_BYTES,
        "默认构建体积增量 {delta} B 超过 3.0 MB 上限（with={with_size}, baseline={base_size}）"
    );
    assert!(
        with_size > base_size,
        "参考探针未实际链接本 crate（with={with_size} <= baseline={base_size}）"
    );
    let _ = &probe.root;
}

/// 默认构建不得包含 ONNX Runtime 遥测路径/符号，也不得引用任何网络出站符号。
#[test]
#[ignore = "专用 CI 作业：依赖 release 探针构建产物"]
fn default_build_reaches_no_onnxruntime_telemetry_or_network_symbols() {
    let probe = probe();
    let mut bytes = Vec::new();
    fs::File::open(&probe.with_dep)
        .expect("打开参考二进制")
        .read_to_end(&mut bytes)
        .expect("读取参考二进制");

    for needle in [
        b"onnxruntime".as_slice(),
        b"OneDS".as_slice(),
        b"1DS".as_slice(),
        b"opentelemetry".as_slice(),
    ] {
        assert!(
            !contains(&bytes, needle),
            "默认构建中出现遥测路径: {}",
            String::from_utf8_lossy(needle)
        );
    }
    for symbol in [
        b"\0connect\0".as_slice(),
        b"\0getaddrinfo\0".as_slice(),
        b"\0socket\0".as_slice(),
        b"\0sendto\0".as_slice(),
    ] {
        assert!(
            !contains(&bytes, symbol),
            "默认构建不可引用网络出站符号: {}",
            String::from_utf8_lossy(symbol).trim_matches('\0')
        );
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

// ---------------------------------------------------------------------------
// 密封子进程 120 s 零出站连接
// ---------------------------------------------------------------------------

fn open_socket_inodes(pid: u32) -> Vec<String> {
    let mut sockets = Vec::new();
    #[cfg(target_os = "linux")]
    {
        let dir = format!("/proc/{pid}/fd");
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(target) = fs::read_link(entry.path())
                    && target.to_string_lossy().starts_with("socket:")
                {
                    sockets.push(target.to_string_lossy().into_owned());
                }
            }
        }
    }
    let _ = pid;
    sockets
}

#[test]
#[ignore = "专用 CI 作业：密封子进程需连续运行 120 s（QZ_VOICE_SOAK_SECS 可调）"]
// `try_wait` 已回收子进程；超时/错误路径均显式 `kill()+wait()`，此处仅放宽静态告警。
#[allow(clippy::zombie_processes)]
fn sealed_vad_soak_makes_zero_outbound_connections() {
    let probe = probe();
    let soak_secs = std::env::var("QZ_VOICE_SOAK_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(120);
    eprintln!("voice-ai soak: {soak_secs}s sealed child");

    let mut child = Command::new(&probe.with_dep)
        .env("QZ_VOICE_SOAK_SECS", soak_secs.to_string())
        .env("QZ_VOICE_SOAK_CHECK_FDS", "1")
        .env(ORT_DISABLE_TELEMETRY, "1")
        // 密封：剥离代理与任何出站凭据环境。
        .env_remove("http_proxy")
        .env_remove("https_proxy")
        .env_remove("HTTP_PROXY")
        .env_remove("HTTPS_PROXY")
        .env_remove("ALL_PROXY")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动密封 VAD 子进程");

    let pid = child.id();
    let start = Instant::now();
    let mut observed: Vec<String> = Vec::new();
    let mut reaped = false;
    while start.elapsed() < Duration::from_secs(soak_secs + 30) {
        observed.extend(open_socket_inodes(pid));
        match child.try_wait() {
            Ok(Some(status)) => {
                // `try_wait` 已回收；再 `wait()` 仅让静态检查确认所有路径均已收尸。
                let _ = child.wait();
                reaped = true;
                assert!(
                    status.success(),
                    "密封子进程异常退出: {status:?} (socket fds seen: {observed:?})"
                );
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("等待子进程失败: {error}");
            }
        }
    }
    if !reaped {
        let _ = child.kill();
        let _ = child.wait();
        panic!("密封子进程超时未退出");
    }
    assert!(
        observed.is_empty(),
        "密封 VAD 子进程打开了 socket fd: {observed:?}"
    );
    assert!(
        start.elapsed() >= Duration::from_secs(soak_secs.saturating_sub(1)),
        "密封子进程未运行满 {soak_secs}s"
    );
}

// ---------------------------------------------------------------------------
// 模型加载路径的遥测双杀
// ---------------------------------------------------------------------------

struct MemorySource {
    payloads: BTreeMap<String, Vec<u8>>,
}

impl PackSource for MemorySource {
    fn fetch(&self, url: &str) -> quetzalcoatl_types::Result<Vec<u8>> {
        self.payloads.get(url).cloned().ok_or_else(|| {
            quetzalcoatl_types::QuetzalcoatlError::IntegrityViolation {
                detail: format!("测试下载源缺少 {url}"),
            }
        })
    }
}

fn sample_pack() -> (OnDemandAiPackManager, PackManifest) {
    let home = std::env::temp_dir().join(format!(
        "qz-voice-telemetry-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&home).expect("创建 home");

    let bytes = b"fake-sensevoice-int8-weights".to_vec();
    let key = SigningKey::from_bytes(&[0x42_u8; 32]);
    let digest = blake3::hash(&bytes).to_hex().to_string();
    let mut manifest = PackManifest::new(
        "sensevoice-small",
        AiPackKind::SpeechRecognition,
        "1.0.0",
        "sensevoice-small-int8",
        vec![PackFileEntry {
            path: String::from("model.onnx"),
            url: String::from("https://models.invalid/sensevoice/model.onnx"),
            blake3: digest,
            size: bytes.len() as u64,
        }],
    );
    manifest.sign_with(&key).expect("签名清单");

    let mut payloads = BTreeMap::new();
    payloads.insert(
        String::from("https://models.invalid/sensevoice/model.onnx"),
        bytes,
    );
    let manager = OnDemandAiPackManager::new(
        &home,
        Arc::new(MemorySource { payloads }),
        key.verifying_key(),
    )
    .expect("构造按需模型管理器");
    (manager, manifest)
}

#[test]
fn ort_disable_telemetry_is_present_on_every_load_path() {
    let (manager, manifest) = sample_pack();
    assert_eq!(
        manager
            .loader_environment()
            .get(ORT_DISABLE_TELEMETRY)
            .map(String::as_str),
        Some("1"),
        "加载器环境必须注入 ORT_DISABLE_TELEMETRY=1"
    );

    let installed = manager.install_pack(&manifest).expect("安装模型包");
    assert_eq!(
        installed
            .env()
            .get(ORT_DISABLE_TELEMETRY)
            .map(String::as_str),
        Some("1")
    );

    let loaded = manager
        .load_pack(AiPackKind::SpeechRecognition, "1.0.0")
        .expect("校验并加载模型包");
    assert_eq!(
        loaded.env().get(ORT_DISABLE_TELEMETRY).map(String::as_str),
        Some("1")
    );

    // 环境轴必须能原样注入承载 ORT 的子进程（不启动真实进程，仅检查命令环境）。
    let mut command = Command::new("true");
    loaded.apply_env(&mut command);
    let applied: Vec<_> = command
        .get_envs()
        .filter(|(key, _)| key.to_string_lossy() == ORT_DISABLE_TELEMETRY)
        .map(|(_, value)| {
            value
                .map(std::ffi::OsStr::to_string_lossy)
                .map(|v| v.into_owned())
        })
        .collect();
    assert_eq!(applied, vec![Some(String::from("1"))]);
}
