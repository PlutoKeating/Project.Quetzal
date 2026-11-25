#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 依赖图红线（防坑规范 #13）：`quetzalcoatl-client-core` 不得**直接**依赖
//! `rusqlite` / `quetzalcoatl-spine`，且去往 SQLite 的唯一间接网关必须是
//! `quetzalcoatl-daemon` 的 IPC 协议类型。任何新增旁路都会让本测试失败。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(std::path::Path::to_path_buf)
        .expect("定位工作区根目录")
}

fn cargo_metadata() -> Value {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| String::from("cargo"));
    let output = Command::new(cargo)
        .current_dir(repo_root())
        .args(["metadata", "--offline", "--format-version", "1"])
        .output()
        .expect("运行 cargo metadata");
    assert!(
        output.status.success(),
        "cargo metadata 失败: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("解析 cargo metadata")
}

fn package_graph(meta: &Value) -> (HashMap<String, String>, HashMap<String, Vec<String>>) {
    let mut names = HashMap::new();
    for package in meta["packages"].as_array().expect("packages") {
        let id = package["id"].as_str().expect("package id").to_owned();
        let name = package["name"].as_str().expect("package name").to_owned();
        names.insert(id, name);
    }
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    for node in meta["resolve"]["nodes"].as_array().expect("resolve.nodes") {
        let id = node["id"].as_str().expect("node id").to_owned();
        let deps = node["deps"]
            .as_array()
            .expect("node deps")
            .iter()
            .map(|dep| dep["pkg"].as_str().expect("dep pkg").to_owned())
            .collect();
        graph.insert(id, deps);
    }
    (names, graph)
}

fn reachable(
    start: &str,
    graph: &HashMap<String, Vec<String>>,
    blocked: &HashSet<String>,
) -> HashSet<String> {
    let mut seen = HashSet::new();
    let mut queue = VecDeque::new();
    if blocked.contains(start) {
        return seen;
    }
    seen.insert(start.to_owned());
    queue.push_back(start.to_owned());
    while let Some(current) = queue.pop_front() {
        for next in graph.get(&current).into_iter().flatten() {
            if blocked.contains(next) || !seen.insert(next.clone()) {
                continue;
            }
            queue.push_back(next.clone());
        }
    }
    seen
}

#[test]
fn client_core_only_reaches_sqlite_through_the_daemon_protocol() {
    let meta = cargo_metadata();
    let (id_to_name, graph) = package_graph(&meta);

    let id_of = |name: &str| -> String {
        id_to_name
            .iter()
            .find(|(_, value)| value.as_str() == name)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| panic!("cargo metadata 缺少 package {name}"))
    };
    let core = id_of("quetzalcoatl-client-core");
    let daemon = id_of("quetzalcoatl-daemon");
    let sqlite = id_of("rusqlite");

    // 1) 直接依赖必须干净（文档的可断言部分）。
    let core_package = meta["packages"]
        .as_array()
        .expect("packages")
        .iter()
        .find(|package| package["name"].as_str() == Some("quetzalcoatl-client-core"))
        .expect("quetzalcoatl-client-core package");
    let direct: Vec<&str> = core_package["dependencies"]
        .as_array()
        .expect("dependencies")
        .iter()
        .filter_map(|dep| dep["name"].as_str())
        .collect();
    assert!(
        !direct.contains(&"rusqlite"),
        "client-core 不得直接依赖 rusqlite，实际直接依赖: {direct:?}"
    );
    assert!(
        !direct.contains(&"quetzalcoatl-spine"),
        "client-core 不得直接依赖 quetzalcoatl-spine，实际直接依赖: {direct:?}"
    );
    assert!(
        direct.contains(&"quetzalcoatl-daemon"),
        "client-core 必须且只能经 quetzalcoatl-daemon 的 IPC 协议类型接触脊柱，实际: {direct:?}"
    );

    // 2) 已知的间接路径确实存在（经由 daemon），避免文档与现实脱节。
    let everything = reachable(&core, &graph, &HashSet::new());
    assert!(
        everything.contains(&sqlite),
        "预期存在 client-core -> quetzalcoatl-daemon -> rusqlite 的已知间接路径"
    );

    // 3) 裁剪掉 daemon 后必须彻底到不了 SQLite：daemon 是唯一网关。
    let without_daemon = reachable(&core, &graph, &HashSet::from([daemon.clone()]));
    assert!(
        !without_daemon.contains(&sqlite),
        "去往 SQLite 的唯一网关必须是 quetzalcoatl-daemon；出现了新的旁路依赖"
    );
}
