#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 声明式能力包 / 桥接包描述符与可执行实现的一致性契约。

use std::collections::BTreeSet;
use std::error::Error;
use std::path::{Path, PathBuf};

use quetzalcoatl_capabilities::{CapabilityDescriptor, manifests};

type TestResult = Result<(), Box<dyn Error>>;

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(PathBuf::from)
        .ok_or_else(|| String::from("无法定位仓库根目录"))?)
}

fn workspace_members(root: &Path) -> Result<BTreeSet<String>, Box<dyn Error>> {
    let raw = std::fs::read_to_string(root.join("Cargo.toml"))?;
    let mut members = BTreeSet::new();
    let mut in_members = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("members") {
            in_members = true;
        }
        if in_members {
            for part in trimmed.split(['[', ',', ']']) {
                let item = part.trim();
                if item.starts_with('"') && item.ends_with('"') && item.len() > 2 {
                    members.insert(item.trim_matches('"').to_owned());
                }
            }
            if trimmed.contains(']') {
                in_members = false;
            }
        }
    }
    if members.is_empty() {
        return Err(String::from("缺少 workspace.members").into());
    }
    Ok(members)
}

#[test]
fn every_capability_descriptor_matches_manifest_and_named_module() -> TestResult {
    let root = repo_root()?;
    let members = workspace_members(&root)?;
    let declared = manifests();
    assert_eq!(declared.len(), 6, "基础能力包必须恰为六项，不得虚构");
    let mut seen = BTreeSet::new();
    for manifest in &declared {
        assert!(seen.insert(manifest.id.clone()));
        let path = root
            .join("packages/capabilities")
            .join(&manifest.id)
            .join("capability.json");
        let raw = std::fs::read_to_string(&path)?;
        let from_disk: CapabilityDescriptor = serde_json::from_str(&raw)?;
        assert_eq!(
            &from_disk,
            manifest,
            "描述符与实现不一致: {}",
            path.display()
        );
        assert!(
            members.contains(&format!("crates/{}", manifest.implementation.crate_name)),
            "实现 crate 必须是工作区成员: {}",
            manifest.implementation.crate_name
        );
        let lib = root
            .join("crates")
            .join(&manifest.implementation.crate_name)
            .join("src/lib.rs");
        let source = std::fs::read_to_string(&lib)?;
        assert!(
            source.contains(&format!("pub mod {};", manifest.implementation.module)),
            "模块不存在: {}::{}",
            manifest.implementation.crate_name,
            manifest.implementation.module
        );
        assert_eq!(manifest.status, "declared");
    }

    let dir = root.join("packages/capabilities");
    let mut found = BTreeSet::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.path().is_dir()
            && let Some(name) = entry.file_name().to_str()
        {
            found.insert(String::from(name));
        }
    }
    assert_eq!(found, seen, "packages/capabilities 不得存在未声明的能力包");
    Ok(())
}

#[test]
fn spine_bridge_descriptor_names_existing_workspace_implementation() -> TestResult {
    let root = repo_root()?;
    let members = workspace_members(&root)?;
    let raw = std::fs::read_to_string(root.join("packages/bridge/spine-bridge/package.json"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    assert_eq!(value["id"], "spine-bridge");
    assert_eq!(value["role"], "bridge");
    assert_eq!(value["status"], "declared");
    assert_eq!(value["implementation"]["crate"], "quetzalcoatl-bridge");
    assert!(
        members.contains(&String::from("crates/quetzalcoatl-bridge")),
        "桥接实现 crate 必须是工作区成员"
    );
    let module = value["implementation"]["module"]
        .as_str()
        .ok_or("implementation.module")?;
    let module_path = root
        .join("crates/quetzalcoatl-bridge/src")
        .join(format!("{module}.rs"));
    let source = std::fs::read_to_string(&module_path)?;
    assert!(source.contains("pub struct SpineBridge"));
    assert!(source.contains("pub enum BridgeRole"));
    let sinks = value["permissions"]["sinks"]
        .as_array()
        .ok_or("permissions.sinks")?;
    let names: Vec<&str> = sinks.iter().filter_map(serde_json::Value::as_str).collect();
    assert_eq!(names, vec!["memory.observe", "journal.note"]);
    assert_eq!(value["permissions"]["network"], false);
    Ok(())
}
