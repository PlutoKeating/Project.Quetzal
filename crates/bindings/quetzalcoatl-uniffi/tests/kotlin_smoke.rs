#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! Kotlin 2.2 绑定冒烟：始终生成并静态校验绑定源码；仅当 `kotlinc` + JNA 在位时做真实编译。

mod common;

use std::fs;
use std::process::Command;

#[test]
fn kotlin_bindings_generate_and_compile_when_toolchain_present() {
    let out = common::temp_dir("qz_kotlin_smoke");
    let generated = common::generate_bindings("kotlin", &out).expect("生成 Kotlin 绑定");
    let target = generated.join("org/quetzalcoatl/bindings/quetzalcoatl_uniffi.kt");
    let source = fs::read_to_string(&target).expect("读取生成的 Kotlin 绑定");

    for symbol in ["class FfiViewSession", "densityPatch"] {
        assert!(
            source.contains(symbol),
            "Kotlin 绑定缺少导出的符号 `{symbol}`"
        );
    }
    assert!(
        !source.contains("FfiViewStream"),
        "对话流已按 000 号铁律撤销，绑定不得再导出 FfiViewStream"
    );
    assert!(
        !source.contains("FfiConverterCallbackInterface"),
        "Kotlin 绑定不得包含任何外语回调接口"
    );

    let Some(kotlinc) = common::find_tool(&["kotlinc"]) else {
        println!(
            "SKIP: 本机未安装 kotlinc（Kotlin 2.2+ 工具链）；已生成并静态校验绑定源码: {}",
            target.display()
        );
        return;
    };
    let Some(jna) = std::env::var_os("QZ_JNA_JAR").map(std::path::PathBuf::from) else {
        println!(
            "SKIP: 已安装 kotlinc，但未提供 QZ_JNA_JAR（生成绑定依赖 JNA），跳过 Kotlin 编译: {}",
            target.display()
        );
        return;
    };
    let jna_dir = jna
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
    let status = Command::new(kotlinc)
        .arg("-cp")
        .arg(&jna)
        .arg(&target)
        .arg("-d")
        .arg(out.join("bindings.jar"))
        .env("LD_LIBRARY_PATH", jna_dir)
        .status()
        .expect("运行 kotlinc");
    assert!(status.success(), "kotlinc 编译失败");

    let _ = fs::remove_dir_all(&out);
    println!("KOTLIN_SMOKE_OK {}", target.display());
}
