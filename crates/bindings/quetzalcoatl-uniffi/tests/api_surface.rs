#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! UniFFI 绑定层静态门禁：精确版本锁定、`uniffi-bindgen-cs` 配对、零回调接口、手写代码零 `unsafe`。

mod common;

use std::process::Command;

use serde_json::Value;

const PINNED_UNIFFI: &str = "0.32.0";

fn locked_version(lock: &str, package: &str) -> Option<String> {
    let mut in_package = false;
    for line in lock.lines() {
        let trimmed = line.trim();
        if trimmed == "[[package]]" {
            in_package = false;
            continue;
        }
        if trimmed == format!("name = \"{package}\"") {
            in_package = true;
            continue;
        }
        if in_package && let Some(rest) = trimmed.strip_prefix("version = ") {
            return Some(rest.trim().trim_matches('"').to_owned());
        }
    }
    None
}

#[test]
fn uniffi_is_pinned_exactly_to_0_32_0() {
    let root_manifest = include_str!("../../../../Cargo.toml");
    assert!(
        root_manifest.contains(r#"uniffi = { version = "=0.32.0" }"#),
        "根 Cargo.toml 必须精确锁定 uniffi = \"=0.32.0\""
    );
    let lock = include_str!("../../../../Cargo.lock");
    assert_eq!(
        locked_version(lock, "uniffi").as_deref(),
        Some(PINNED_UNIFFI),
        "Cargo.lock 解析出的 uniffi 版本必须等于精确锁定值"
    );
    for sibling in [
        "uniffi_core",
        "uniffi_macros",
        "uniffi_meta",
        "uniffi_bindgen",
    ] {
        assert_eq!(
            locked_version(lock, sibling).as_deref(),
            Some(PINNED_UNIFFI),
            "{sibling} 必须与 uniffi 同版本，避免 ABI 漂移"
        );
    }
}

#[test]
fn bindgen_cs_pairing_matches_pinned_uniffi() {
    let pin: Value = serde_json::from_str(include_str!("../bindgen-cs-pin.json"))
        .expect("解析 bindgen-cs-pin.json");
    assert_eq!(
        pin["paired_uniffi_version"].as_str(),
        Some(PINNED_UNIFFI),
        "uniffi-bindgen-cs 的配对 uniffi 版本必须与本工作区锁定版本一致"
    );
    assert_eq!(pin["crates_io_published"].as_bool(), Some(false));

    let Some(tool) = common::find_tool(&["uniffi-bindgen-cs"]) else {
        println!(
            "SKIP: 未安装 uniffi-bindgen-cs（crates.io 未发布，需按 {} 安装），已用 bindgen-cs-pin.json 固定配对版本",
            pin["install_command"].as_str().unwrap_or("(见 pin 文件)")
        );
        return;
    };
    let output = Command::new(&tool)
        .arg("--version")
        .output()
        .expect("运行 uniffi-bindgen-cs --version");
    let version_out = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let paired = version_out
        .rsplit_once('+')
        .map(|(_, paired)| paired.trim().trim_start_matches('v').to_owned())
        .unwrap_or_default();
    assert_eq!(
        paired, PINNED_UNIFFI,
        "已安装工具 {version_out} 的配对 uniffi 版本与锁定值不一致"
    );
    assert_eq!(
        pin["tool_version"].as_str(),
        Some(
            version_out
                .split_once('+')
                .map(|(tool, _)| tool.trim_start_matches("uniffi-bindgen ").trim())
                .unwrap_or(version_out.as_str())
        ),
        "pin 文件记录的 bindgen-cs 版本必须与实际安装一致"
    );
    println!("uniffi-bindgen-cs 配对校验通过: {version_out} (paired uniffi {paired})");
}

fn non_comment_source(path: &str, source: &str) -> String {
    source
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !(trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*"))
        })
        .map(|line| format!("{path}: {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn exported_surface_declares_no_callback_interfaces() {
    let handwritten = [
        ("src/lib.rs", include_str!("../src/lib.rs")),
        (
            "src/bin/uniffi-bindgen.rs",
            include_str!("../src/bin/uniffi-bindgen.rs"),
        ),
    ];
    for (path, source) in handwritten {
        let code = non_comment_source(path, source);
        for forbidden in [
            "callback_interface",
            "with_foreign",
            "ForeignCallback",
            "Box<dyn Fn",
            "extern \"C\" fn",
        ] {
            assert!(
                !code.contains(forbidden),
                "{path} 不得出现回调接口标记 `{forbidden}`（防坑规范 #14 只允许拉模式）"
            );
        }
    }

    // 从真实 cdylib 的动态符号表验证：UniFFI 只为回调接口生成 `init_callback_vtable_*`。
    let Ok(lib) = common::ensure_native_lib() else {
        println!("SKIP: 无法构建 cdylib，跳过符号级回调接口校验");
        return;
    };
    let output = match Command::new("nm")
        .args(["-D", "--defined-only"])
        .arg(&lib)
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => {
            println!("SKIP: 本机缺少 nm 或无法解析动态符号，跳过符号级回调接口校验");
            return;
        }
    };
    let symbols = String::from_utf8_lossy(&output.stdout);
    let callback_vtables = symbols
        .lines()
        .filter(|line| line.contains("init_callback_vtable"))
        .count();
    assert_eq!(
        callback_vtables, 0,
        "导出的动态库中不得存在任何外语回调 vtable 初始化符号"
    );
    println!(
        "符号级校验通过: 0 个 init_callback_vtable，{} 个导出符号",
        symbols
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
    );
}

#[test]
fn handwritten_sources_contain_no_unsafe() {
    // 唯一的 `unsafe` 允许出现在 `uniffi::setup_scaffolding!()` 宏展开的 FFI 胶水中，
    // 手写源码必须零 `unsafe` 关键字。
    for (path, source) in [
        ("src/lib.rs", include_str!("../src/lib.rs")),
        (
            "src/bin/uniffi-bindgen.rs",
            include_str!("../src/bin/uniffi-bindgen.rs"),
        ),
    ] {
        let code = non_comment_source(path, source);
        for forbidden in [
            "unsafe {",
            "unsafe fn",
            "unsafe impl",
            "unsafe extern",
            "unsafe(no_mangle)",
            "unsafe(export_name)",
        ] {
            assert!(
                !code.contains(forbidden),
                "{path} 手写代码不得包含 `{forbidden}`（unsafe 豁免仅限宏展开胶水）"
            );
        }
    }
}
