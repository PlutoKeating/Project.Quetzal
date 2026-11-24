#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! ORT 初始化编排：环境轴 + API 轴必须真实联动，桥接说谎必须失败。

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use quetzalcoatl_types::QuetzalcoatlError;
use quetzalcoatl_voice_ai::ort_loader::{
    ORT_DISABLE_TELEMETRY, OrtInitializer, OrtRuntimeBridge, TelemetryStatus,
};

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

#[test]
fn initializer_fails_closed_when_bridge_reports_telemetry_still_enabled() {
    let (mut initializer, calls) = initializer(TelemetryStatus::Enabled);
    let library = Path::new("/fake/libonnxruntime.so");
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
    // 环境轴在失败路径上同样必须已设置。
    assert_eq!(
        initializer
            .environment()
            .get(ORT_DISABLE_TELEMETRY)
            .map(String::as_str),
        Some("1")
    );
    // API 轴：桥接必须被要求关闭遥测（而不是默认/未指定）。
    assert_eq!(calls.borrow().as_slice(), &[(library.to_path_buf(), true)]);
}

#[test]
fn initializer_succeeds_only_with_both_axes_and_exposes_loader_env() {
    let (mut initializer, calls) = initializer(TelemetryStatus::Disabled);
    let library = Path::new("/fake/libonnxruntime.so");
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

    // 环境轴必须能原样注入承载 ORT 的子进程/加载器。
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

#[test]
fn bridge_failure_is_propagated_without_faking_success() {
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
        .initialize(Path::new("/fake/libonnxruntime.so"))
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
