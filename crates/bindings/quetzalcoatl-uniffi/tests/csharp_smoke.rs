#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! C#（.NET 10）真实编译 + 运行冒烟：只有 dotnet SDK 与 `uniffi-bindgen-cs` 都在位时才执行，
//! 缺失时以明确理由 SKIP，绝不伪装通过。

mod common;

use std::process::Command;

#[test]
fn csharp_bindings_compile_and_run_on_dotnet() {
    if common::find_tool(&["dotnet"]).is_none() {
        println!("SKIP: 本机未安装 dotnet SDK，跳过 C# 绑定编译冒烟");
        return;
    }
    if common::find_tool(&["uniffi-bindgen-cs"]).is_none() {
        println!(
            "SKIP: 本机未安装 uniffi-bindgen-cs（crates.io 未发布，见 bindgen-cs-pin.json），跳过 C# 绑定编译冒烟"
        );
        return;
    }

    let script = common::repo_root().join("scripts/uniffi-bindings.sh");
    let output = Command::new("bash")
        .arg(&script)
        .arg("smoke-csharp")
        .env("QZ_CARGO", common::cargo_bin())
        .env("QZ_PROFILE", common::profile())
        .output()
        .expect("运行 scripts/uniffi-bindings.sh smoke-csharp");

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if output.status.code() == Some(77) {
        println!("SKIP: {stdout}{stderr}");
        return;
    }

    assert!(
        output.status.success(),
        "C# 冒烟失败 (status={}):\nstdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains("CSHARP_SMOKE_OK"),
        "C# 消费方必须真实运行并输出成功标记:\n{stdout}\n{stderr}"
    );
    println!("{stdout}");
}
