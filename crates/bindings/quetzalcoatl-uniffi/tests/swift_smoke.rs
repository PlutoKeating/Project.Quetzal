#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! Swift 6 绑定冒烟：始终生成并静态校验绑定源码；仅当 `swiftc` 在位时做真实类型检查。

mod common;

use std::fs;
use std::process::Command;

#[test]
fn swift_bindings_generate_and_typecheck_when_toolchain_present() {
    let out = common::temp_dir("qz_swift_smoke");
    let generated = common::generate_bindings("swift", &out).expect("生成 Swift 绑定");
    let target = generated.join("QuetzalcoatlBindings.swift");
    let source = fs::read_to_string(&target).expect("读取生成的 Swift 绑定");

    for symbol in [
        "FfiViewStream",
        "FfiViewSession",
        "FfiCognitionDensity",
        "nextEvents",
    ] {
        assert!(
            source.contains(symbol),
            "Swift 绑定缺少导出的符号 `{symbol}`"
        );
    }
    assert!(
        !source.contains("CallbackInterface"),
        "Swift 绑定不得包含任何外语回调接口（拉模式唯一）"
    );

    let Some(swiftc) = common::find_tool(&["swiftc"]) else {
        println!(
            "SKIP: 本机未安装 swiftc（Swift 6.2+ 工具链）；已生成并静态校验绑定源码: {}",
            target.display()
        );
        return;
    };

    let status = Command::new(swiftc)
        .args(["-typecheck", "-module-name", "QuetzalcoatlBindings"])
        .arg(&target)
        .status()
        .expect("运行 swiftc -typecheck");
    assert!(status.success(), "swiftc 类型检查失败");

    let _ = fs::remove_dir_all(&out);
    println!("SWIFT_SMOKE_OK {}", target.display());
}
