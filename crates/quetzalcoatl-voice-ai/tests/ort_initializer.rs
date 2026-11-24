#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! ORT 初始化编排：进程环境轴 + API 轴必须真实联动，缺一即 fail-closed。
//!
//! 由于 Rust 2024 的 `std::env::set_var` 是 `unsafe`，测试通过 `Command::env` 在子进程中
//! 建立/移除环境轴（`--test-threads` 安全，不修改测试进程环境）。

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::rc::Rc;

use quetzalcoatl_types::QuetzalcoatlError;
use quetzalcoatl_voice_ai::ort_loader::{
    ORT_DISABLE_TELEMETRY, OrtInitializer, OrtRuntimeBridge, TelemetryStatus,
};

const CHILD_MODE_ENV: &str = "QZ_ORT_INIT_CHILD_MODE";
const LIBRARY: &str = "/fake/libonnxruntime.so";

type CallLog = Rc<RefCell<Vec<(PathBuf, bool)>>>;

struct MockBridge {
    calls: CallLog,
    status: TelemetryStatus,
}

impl OrtRuntimeBridge for MockBridge {
    fn init(
        &mut self,
        library: &Path,
        disable_telemetry: bool,
    ) -> quetzalcoatl_types::Result<TelemetryStatus> {
        self.calls
            .borrow_mut()
            .push((library.to_path_buf(), disable_telemetry));
        Ok(self.status)
    }
}

fn initializer(status: TelemetryStatus) -> (OrtInitializer<MockBridge>, CallLog) {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let bridge = MockBridge {
        calls: Rc::clone(&calls),
        status,
    };
    (OrtInitializer::new(bridge), calls)
}

fn run_child(mode: &str, process_env_present: bool) -> Output {
    let mut command = Command::new(std::env::current_exe().expect("测试二进制路径"));
    command
        .args(["--exact", "child_mode_assertions", "--nocapture"])
        .env(CHILD_MODE_ENV, mode)
        .env_remove(ORT_DISABLE_TELEMETRY);
    if process_env_present {
        command.env(ORT_DISABLE_TELEMETRY, "1");
    }
    command.output().expect("启动子测试进程")
}

fn assert_child(mode: &str, process_env_present: bool) {
    let output = run_child(mode, process_env_present);
    assert!(
        output.status.success(),
        "子模式 {mode} 断言失败:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// 子进程模式分发；父进程直接调用时无 `CHILD_MODE_ENV` 立即返回。
#[test]
fn child_mode_assertions() {
    let Ok(mode) = std::env::var(CHILD_MODE_ENV) else {
        return;
    };
    let library = Path::new(LIBRARY);
    match mode.as_str() {
        "bridge_enabled" => {
            assert_eq!(
                std::env::var(ORT_DISABLE_TELEMETRY).as_deref(),
                Ok("1"),
                "子进程环境轴必须由 Command::env 注入"
            );
            let (mut initializer, calls) = initializer(TelemetryStatus::Enabled);
            let error = initializer
                .initialize(library)
                .expect_err("桥接返回遥测仍开启时必须失败");
            assert!(
                matches!(error, QuetzalcoatlError::IntegrityViolation { .. }),
                "必须是完整性拒绝，实际 {error}"
            );
            assert!(
                error.to_string().contains("遥测"),
                "错误信息必须说明遥测关闭失败: {error}"
            );
            assert_eq!(
                initializer
                    .environment()
                    .get(ORT_DISABLE_TELEMETRY)
                    .map(String::as_str),
                Some("1"),
                "失败路径的加载器环境也必须保留"
            );
            assert_eq!(calls.borrow().as_slice(), &[(library.to_path_buf(), true)]);
        }
        "bridge_disabled" => {
            let (mut initializer, calls) = initializer(TelemetryStatus::Disabled);
            let initialization = initializer.initialize(library).expect("双轴关闭时成功");
            assert_eq!(initialization.telemetry(), TelemetryStatus::Disabled);
            assert_eq!(
                initialization
                    .environment()
                    .get(ORT_DISABLE_TELEMETRY)
                    .map(String::as_str),
                Some("1")
            );
            assert_eq!(calls.borrow().as_slice(), &[(library.to_path_buf(), true)]);

            let mut command = Command::new("true");
            initialization.apply_environment(&mut command);
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
        "bridge_error" => {
            struct FailingBridge;
            impl OrtRuntimeBridge for FailingBridge {
                fn init(
                    &mut self,
                    _library: &Path,
                    _disable_telemetry: bool,
                ) -> quetzalcoatl_types::Result<TelemetryStatus> {
                    Err(QuetzalcoatlError::StorageError {
                        detail: String::from("动态库加载失败"),
                    })
                }
            }
            let mut initializer = OrtInitializer::new(FailingBridge);
            let error = initializer
                .initialize(library)
                .expect_err("桥接错误必须上抛");
            assert!(matches!(error, QuetzalcoatlError::StorageError { .. }));
            assert_eq!(
                initializer
                    .environment()
                    .get(ORT_DISABLE_TELEMETRY)
                    .map(String::as_str),
                Some("1"),
                "失败路径也不得丢失环境轴"
            );
        }
        "process_env_missing" => {
            assert!(
                std::env::var(ORT_DISABLE_TELEMETRY).is_err(),
                "该子进程必须没有进程环境轴"
            );
            let (mut initializer, calls) = initializer(TelemetryStatus::Disabled);
            let error = initializer
                .initialize(library)
                .expect_err("当前进程未导出环境轴时必须 fail-closed");
            assert!(
                matches!(error, QuetzalcoatlError::IntegrityViolation { .. }),
                "必须是完整性拒绝，实际 {error}"
            );
            assert!(
                error.to_string().contains(ORT_DISABLE_TELEMETRY),
                "错误必须点名缺失的环境变量: {error}"
            );
            assert!(
                calls.borrow().is_empty(),
                "进程环境轴未就绪时不得调用 ORT 桥接"
            );
        }
        other => panic!("未知子模式: {other}"),
    }
}

#[test]
fn initializer_fails_closed_when_bridge_reports_telemetry_still_enabled() {
    assert_child("bridge_enabled", true);
}

#[test]
fn initializer_succeeds_only_with_both_axes_and_exposes_loader_env() {
    assert_child("bridge_disabled", true);
}

#[test]
fn bridge_failure_is_propagated_without_faking_success() {
    assert_child("bridge_error", true);
}

#[test]
fn initialize_fails_closed_without_process_env_axis() {
    assert_child("process_env_missing", false);
}
