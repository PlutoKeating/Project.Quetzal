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

    for symbol in ["FfiViewSession", "FfiCognitionDensity", "densityPatch"] {
        assert!(
            source.contains(symbol),
            "Swift 绑定缺少导出的符号 `{symbol}`"
        );
    }
    assert!(
        !source.contains("FfiViewStream"),
        "对话流已按 000 号铁律撤销，绑定不得再导出 FfiViewStream"
    );
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

    // 生成的 Swift 依赖 C FFI 模块（`RustBuffer` / `ForeignBytes` 定义在头文件里）。
    // 单独 typecheck 绑定文件必然缺类型：必须把 modulemap + 头文件放到 `-I` 目录，
    // 并把 modulemap 命名为 `module.modulemap`（Clang 模块查找的约定文件名）。
    let include_dir = out.join("include");
    fs::create_dir_all(&include_dir).expect("创建 Swift include 目录");
    fs::copy(
        out.join("quetzalcoatl_uniffiFFI.h"),
        include_dir.join("quetzalcoatl_uniffiFFI.h"),
    )
    .expect("复制 FFI 头文件");
    // uniffi 生成的 modulemap 含 `use "Darwin"`（Apple 平台专属模块）。
    // 在 Linux 的 Swift 工具链上这一行会让 Clang 直接报模块缺失，因此非 Apple 目标先摘掉。
    let modulemap = fs::read_to_string(out.join("quetzalcoatl_uniffiFFI.modulemap"))
        .expect("读取 FFI modulemap");
    let modulemap = if cfg!(target_vendor = "apple") {
        modulemap
    } else {
        modulemap
            .lines()
            .filter(|line| !line.trim_start().starts_with("use \"Darwin\""))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    };
    fs::write(include_dir.join("module.modulemap"), modulemap).expect("写入 FFI modulemap");

    let status = Command::new(swiftc)
        .args(["-typecheck", "-module-name", "QuetzalcoatlBindings"])
        .arg("-I")
        .arg(&include_dir)
        .arg(&target)
        .status()
        .expect("运行 swiftc -typecheck");
    assert!(status.success(), "swiftc 类型检查失败");

    let _ = fs::remove_dir_all(&out);
    println!("SWIFT_SMOKE_OK {}", target.display());
}
