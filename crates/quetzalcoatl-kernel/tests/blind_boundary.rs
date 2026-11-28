#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;

use quetzalcoatl_kernel::{
    ArtifactEntryKind, compute_workspace_tree_blake3, compute_workspace_tree_manifest,
};
use quetzalcoatl_types::ArtifactId;
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("无法定位仓库根目录")?;
    Ok(root.to_path_buf())
}

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let parent = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
        let uid = Uuid::new_v4().simple().to_string();
        let path = parent.join(format!("{prefix}_{}", &uid[..12]));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn collect_runtime_closure(
    meta: &serde_json::Value,
    root_pkg_name: &str,
) -> Result<BTreeSet<String>, Box<dyn Error>> {
    let packages = meta["packages"]
        .as_array()
        .ok_or("cargo metadata 缺少 packages")?;
    let mut id_to_name = BTreeMap::<String, String>::new();
    let mut kernel_id: Option<String> = None;
    for pkg in packages {
        let id = pkg["id"].as_str().ok_or("pkg.id")?.to_owned();
        let name = pkg["name"].as_str().ok_or("pkg.name")?.to_owned();
        if name == root_pkg_name {
            kernel_id = Some(id.clone());
        }
        id_to_name.insert(id, name);
    }
    let root_id = kernel_id.ok_or("未在 cargo metadata 中找到 quetzalcoatl-kernel")?;

    let nodes = meta["resolve"]["nodes"]
        .as_array()
        .ok_or("cargo metadata 缺少 resolve.nodes")?;
    let mut node_map = BTreeMap::<String, &serde_json::Value>::new();
    for node in nodes {
        let id = node["id"].as_str().ok_or("node.id")?.to_owned();
        node_map.insert(id, node);
    }

    let mut visited_ids = BTreeSet::<String>::new();
    let mut stack = vec![root_id];
    while let Some(curr) = stack.pop() {
        if !visited_ids.insert(curr.clone()) {
            continue;
        }
        if let Some(node) = node_map.get(&curr)
            && let Some(deps) = node["deps"].as_array()
        {
            for dep in deps {
                let is_normal_runtime_dep = dep["dep_kinds"]
                    .as_array()
                    .map(|kinds| kinds.iter().any(|k| k["kind"].is_null()))
                    .unwrap_or(false);
                if is_normal_runtime_dep && let Some(dep_pkg_id) = dep["pkg"].as_str() {
                    stack.push(dep_pkg_id.to_owned());
                }
            }
        }
    }

    let mut names = BTreeSet::<String>::new();
    for id in visited_ids {
        if let Some(name) = id_to_name.get(&id) {
            names.insert(name.clone());
        }
    }
    Ok(names)
}

#[test]
fn cargo_metadata_proves_zero_upper_layer_and_vendor_dependencies() -> TestResult {
    let root = repo_root()?;

    // 1. 全平台无过滤 cargo metadata 检查
    let raw_all = Command::new("cargo")
        .current_dir(&root)
        .args(["metadata", "--format-version", "1"])
        .output()?;
    assert!(
        raw_all.status.success(),
        "cargo metadata 执行失败: {}",
        String::from_utf8_lossy(&raw_all.stderr)
    );
    let meta_all: serde_json::Value = serde_json::from_slice(&raw_all.stdout)?;

    // 1a. 严格校验 quetzalcoatl-kernel 直接依赖白名单
    let allowed_direct: BTreeSet<&str> = BTreeSet::from([
        "blake3",
        "quetzalcoatl-crypto",
        "quetzalcoatl-sandbox",
        "quetzalcoatl-spine",
        "quetzalcoatl-types",
        "serde",
        "serde_json",
        "uuid",
    ]);
    let kernel_pkg = meta_all["packages"]
        .as_array()
        .and_then(|pkgs| {
            pkgs.iter()
                .find(|p| p["name"].as_str() == Some("quetzalcoatl-kernel"))
        })
        .ok_or("未找到 quetzalcoatl-kernel package 条目")?;
    let deps_arr = kernel_pkg["dependencies"]
        .as_array()
        .ok_or("缺少 dependencies 数组")?;
    for dep in deps_arr {
        // 仅允许白名单内的正常编译运行期依赖
        if dep["kind"].is_null() {
            let dep_name = dep["name"].as_str().ok_or("缺少 dep.name")?;
            assert!(
                allowed_direct.contains(dep_name),
                "盲微内核严禁引入非白名单直接依赖: {dep_name}"
            );
        }
    }

    // 1b. 全目标传递闭包：严禁任何上层业务 crate 与 HTTP/LLM/P2P/MLS/GUI 库
    let all_target_closure = collect_runtime_closure(&meta_all, "quetzalcoatl-kernel")?;
    let allowed_workspace_crates: BTreeSet<&str> = BTreeSet::from([
        "quetzalcoatl-kernel",
        "quetzalcoatl-types",
        "quetzalcoatl-crypto",
        "quetzalcoatl-spine",
        "quetzalcoatl-sandbox",
    ]);
    for name in &all_target_closure {
        if name.starts_with("quetzalcoatl-") {
            assert!(
                allowed_workspace_crates.contains(name.as_str()),
                "盲微内核传递闭包严禁反向依赖上层工作区 crate: {name}"
            );
        }
    }

    let forbidden_crates = [
        "quetzalcoatl-ewave",
        "quetzalcoatl-harness",
        "quetzalcoatl-daemon",
        "quetzalcoatl-fabric",
        "quetzalcoatl-group",
        "quetzalcoatl-voice-ai",
        "quetzalcoatl-nse-ffi",
        "reqwest",
        "hyper",
        "http",
        "h2",
        "axum",
        "tower",
        "ureq",
        "curl",
        "iroh",
        "quinn",
        "rustls",
        "openmls",
        "gtk4",
        "relm4",
        "libadwaita",
        "ort",
        "tract-onnx",
        "sonora-aec3",
    ];
    for forbidden in forbidden_crates {
        assert!(
            !all_target_closure.contains(forbidden),
            "盲微内核全平台传递依赖闭包中发现违禁依赖: {forbidden}"
        );
    }

    // 2. POSIX 平台过滤传递闭包：断言连 tokio / mio 异步网络运行时也严格为 0
    for target_triple in ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"] {
        let raw_posix = Command::new("cargo")
            .current_dir(&root)
            .args([
                "metadata",
                "--format-version",
                "1",
                "--filter-platform",
                target_triple,
            ])
            .output()?;
        assert!(raw_posix.status.success());
        let meta_posix: serde_json::Value = serde_json::from_slice(&raw_posix.stdout)?;
        let posix_closure = collect_runtime_closure(&meta_posix, "quetzalcoatl-kernel")?;
        for async_rt in ["tokio", "mio", "tokio-util", "futures"] {
            assert!(
                !posix_closure.contains(async_rt),
                "盲微内核在 {target_triple} 传递闭包中严禁引入异步网络运行时 {async_rt}"
            );
        }
    }

    Ok(())
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    for entry_res in fs::read_dir(dir)? {
        let entry = entry_res?;
        let path = entry.path();
        let ftype = entry.file_type()?;
        if ftype.is_dir() {
            collect_rs_files(&path, out)?;
        } else if ftype.is_file() && path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
    Ok(())
}

#[test]
fn kernel_source_files_contain_zero_vendor_or_channel_identifiers() -> TestResult {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut rs_files = Vec::new();
    collect_rs_files(&src_dir, &mut rs_files)?;
    assert!(
        rs_files.len() >= 6,
        "预期扫描至少 6 个内核模块源码文件，实际仅发现 {}",
        rs_files.len()
    );

    let forbidden_vendor_terms = [
        "openai",
        "anthropic",
        "claude",
        "codex",
        "gemini",
        "deepseek",
        "opencode",
        "feishu",
        "larksuite",
        "telegram",
        "wecom",
        "dingtalk",
        "discord",
        "whatsapp",
        "koog",
        "swiftagent",
        "electron",
        "tauri",
        "flutter",
    ];

    for file in rs_files {
        let raw = fs::read_to_string(&file)?;
        let lower = raw.to_ascii_lowercase();
        for term in forbidden_vendor_terms {
            assert!(
                !lower.contains(term),
                "盲内核源码文件 {} 中检测到硬编码供应商/通道/宿主词条 `{term}`",
                file.display()
            );
        }
    }
    Ok(())
}

#[test]
fn workspace_tree_blake3_is_deterministic_ignores_git_and_never_follows_symlinks() -> TestResult {
    let tmp = TempDirGuard::new("qz_kernel_tree")?;
    let ws_a = tmp.path().join("ws_a");
    let ws_b = tmp.path().join("ws_b");
    let external_secret = tmp.path().join("outside_secret.txt");
    fs::write(&external_secret, "TOP_SECRET_V1")?;

    for ws in [&ws_a, &ws_b] {
        fs::create_dir_all(ws.join(".git/objects"))?;
        fs::create_dir_all(ws.join("src/nested"))?;
        fs::create_dir_all(ws.join("empty_dir"))?;
        fs::write(ws.join("src/lib.rs"), "pub fn answer() -> u32 { 42 }\n")?;
        fs::write(ws.join("src/nested/helper.txt"), "deterministic\n")?;
    }
    // 两个工作区的 .git 内部状态完全不同，但工作区树摘要必须完全一致
    fs::write(ws_a.join(".git/HEAD"), "ref: refs/heads/main\n")?;
    fs::write(
        ws_b.join(".git/HEAD"),
        "deadbeefcafebabe00112233445566778899aabb\n",
    )?;
    fs::write(ws_b.join(".git/index"), b"DIFFERENT_GIT_INDEX_BYTES")?;

    let manifest_a = compute_workspace_tree_manifest(&ws_a)?;
    let manifest_b = compute_workspace_tree_manifest(&ws_b)?;
    assert_ne!(
        manifest_a.tree_blake3,
        ArtifactId::ZERO,
        "真实工作区树摘要严禁退化为全零哨兵"
    );
    assert_eq!(manifest_a, manifest_b);
    assert_eq!(
        compute_workspace_tree_blake3(&ws_a)?,
        manifest_a.tree_blake3
    );
    assert!(
        manifest_a
            .entries
            .iter()
            .all(|e| e.rel_path != ".git" && !e.rel_path.starts_with(".git/")),
        "工作区树清单必须排除 .git 目录内容"
    );

    // 修改工作区内受控文件的任意 1 字节，树摘要必须立即改变
    fs::write(ws_b.join("src/lib.rs"), "pub fn answer() -> u32 { 43 }\n")?;
    let mutated_digest = compute_workspace_tree_blake3(&ws_b)?;
    assert_ne!(mutated_digest, manifest_a.tree_blake3);

    // Unix 符号链接不跟随测试：外部目标文件内容变化绝不泄露或改变工作区摘要，但链接自身路径改变会反映到摘要中
    #[cfg(unix)]
    {
        let link_path = ws_a.join("src/ext_link");
        symlink(&external_secret, &link_path)?;
        let with_link_manifest = compute_workspace_tree_manifest(&ws_a)?;
        assert!(
            with_link_manifest
                .entries
                .iter()
                .any(|e| { e.rel_path == "src/ext_link" && e.kind == ArtifactEntryKind::Symlink }),
            "符号链接必须以 Symlink 条目记录而非解引用读取目标文件"
        );
        let digest_v1 = with_link_manifest.tree_blake3;

        // 修改工作区外部被指向的机密文件内容：由于不跟随符号链接，树摘要必须完全不变！
        fs::write(&external_secret, "TOP_SECRET_MUTATED_V2_DIFFERENT_LENGTH")?;
        let digest_v2 = compute_workspace_tree_blake3(&ws_a)?;
        assert_eq!(
            digest_v1, digest_v2,
            "compute_workspace_tree_blake3 严禁解引用跟随符号链接读取工作区外部文件"
        );
    }

    Ok(())
}
