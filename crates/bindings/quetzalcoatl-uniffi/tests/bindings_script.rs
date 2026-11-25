#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! `scripts/uniffi-bindings.sh` 行为契约：Kotlin 冒烟必须在工具链缺失时以退出码 77 明确
//! SKIP，在工具链与 JNA 齐备时真实调用 `kotlinc` 编译，绝不伪造通过、也不伪造失败。

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};

fn write_executable(path: &Path, body: &str) {
    fs::write(path, body).expect("write fake tool");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod fake tool");
}

fn run_smoke_kotlin(extra_envs: &[(&str, &str)], remove: &[&str]) -> Output {
    let script = common::repo_root().join("scripts/uniffi-bindings.sh");
    let mut command = Command::new("bash");
    command
        .arg(&script)
        .arg("smoke-kotlin")
        .env("QZ_CARGO", common::cargo_bin())
        .env("QZ_PROFILE", common::profile());
    for (key, value) in extra_envs {
        command.env(key, value);
    }
    for key in remove {
        command.env_remove(key);
    }
    command
        .output()
        .expect("run uniffi-bindings.sh smoke-kotlin")
}

#[test]
fn kotlin_smoke_exits_77_when_jna_runtime_is_missing() {
    let root = common::temp_dir("qz_script_kotlin_no_jna");
    fs::create_dir_all(&root).expect("temp root");
    let fake_kotlinc = root.join("fake-kotlinc");
    write_executable(&fake_kotlinc, "#!/bin/sh\nexit 0\n");

    let output = run_smoke_kotlin(
        &[
            (
                "QZ_BINDINGS_OUT",
                root.join("bindings").to_str().expect("utf8 path"),
            ),
            ("QZ_KOTLINC", fake_kotlinc.to_str().expect("utf8 path")),
        ],
        &["QZ_JNA_JAR"],
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(
        output.status.code(),
        Some(77),
        "缺少 JNA 时必须明确 SKIP（77），stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains("SKIP") && stdout.contains("QZ_JNA_JAR"),
        "SKIP 理由必须点明 QZ_JNA_JAR: {stdout}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn kotlin_smoke_compiles_generated_bindings_when_toolchain_complete() {
    let root = common::temp_dir("qz_script_kotlin_compile");
    fs::create_dir_all(&root).expect("temp root");
    let arg_log = root.join("kotlinc-args.log");
    let fake_kotlinc = root.join("fake-kotlinc");
    write_executable(
        &fake_kotlinc,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$QZ_FAKE_KOTLINC_LOG\"\nexit 0\n",
    );
    let jna = root.join("jna.jar");
    fs::write(&jna, b"fake jna").expect("fake jna");

    let output = run_smoke_kotlin(
        &[
            (
                "QZ_BINDINGS_OUT",
                root.join("bindings").to_str().expect("utf8 path"),
            ),
            ("QZ_KOTLINC", fake_kotlinc.to_str().expect("utf8 path")),
            ("QZ_JNA_JAR", jna.to_str().expect("utf8 path")),
            ("QZ_FAKE_KOTLINC_LOG", arg_log.to_str().expect("utf8 path")),
        ],
        &[],
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(
        output.status.code(),
        Some(0),
        "工具链齐备时必须真实编译并成功，stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains("KOTLIN_SMOKE_OK"),
        "必须输出成功标记: {stdout}"
    );

    let recorded = fs::read_to_string(&arg_log).expect("kotlinc args log");
    assert!(
        recorded.contains(jna.to_str().expect("utf8 path")),
        "kotlinc 必须以 JNA jar 作为 classpath: {recorded}"
    );
    assert!(
        recorded.contains("quetzalcoatl_uniffi.kt"),
        "kotlinc 必须编译生成的 Kotlin 绑定: {recorded}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn all_mode_aggregates_toolchain_skips_instead_of_aborting() {
    let root = common::temp_dir("qz_script_all");
    fs::create_dir_all(&root).expect("temp root");
    let fake_home = root.join("home");
    fs::create_dir_all(&fake_home).expect("fake home");
    let cargo_home = std::env::var_os("CARGO_HOME").unwrap_or_else(|| {
        std::env::var_os("HOME")
            .map(|home| Path::new(&home).join(".cargo").into_os_string())
            .unwrap_or_default()
    });

    let script = common::repo_root().join("scripts/uniffi-bindings.sh");
    let output = Command::new("bash")
        .arg(&script)
        .arg("all")
        .env("HOME", &fake_home)
        .env("CARGO_HOME", &cargo_home)
        .env("QZ_CARGO", common::cargo_bin())
        .env("QZ_PROFILE", common::profile())
        .env(
            "QZ_BINDINGS_OUT",
            root.join("bindings").to_str().expect("utf8 path"),
        )
        .env("QZ_DOTNET", root.join("missing-dotnet"))
        .env("QZ_SWIFTC", root.join("missing-swiftc"))
        .env("QZ_KOTLINC", root.join("missing-kotlinc"))
        .env_remove("QZ_JNA_JAR")
        .output()
        .expect("run uniffi-bindings.sh all");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(0),
        "全部步骤要么通过要么明确 SKIP 时 all 必须退出 0，stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains("汇总"),
        "all 必须打印聚合汇总而不是在首个 SKIP 处中止: {stdout}"
    );
    for expected in ["smoke[csharp=77", "swift=77", "kotlin=77"] {
        assert!(
            stdout.contains(expected),
            "汇总必须记录 {expected} 的 SKIP 码: {stdout}"
        );
    }
    let _ = fs::remove_dir_all(&root);
}
