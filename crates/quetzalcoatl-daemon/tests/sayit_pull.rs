#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! SayIt 自动流入：按修订号增量取记录，一条记录成为一条往事；改了就接替，删了就抹除；
//! 落盘之后才上报游标。用一个假的 SayIt 服务驱动。

mod common;

use std::error::Error;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use quetzalcoatl_daemon::{DaemonConfig, IpcClient, IpcRequest, QuetzalcoatlDaemon};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn Error>>;

#[derive(Default)]
struct FakeSayIt {
    /// 当前全部变更（按 rev 升序）：(rev, 记录)。
    changes: Vec<(u64, Value)>,
    cursors: Vec<u64>,
}

fn serve(state: Arc<Mutex<FakeSayIt>>) -> Result<String, Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream);
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            let mut content_length = 0usize;
            let mut authorized = false;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    content_length = v.trim().parse().unwrap_or(0);
                }
                if lower.starts_with("authorization: bearer token-ok") {
                    authorized = true;
                }
            }
            let mut body = vec![0u8; content_length];
            let _ = reader.read_exact(&mut body);
            let mut parts = request_line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_owned();
            let target = parts.next().unwrap_or_default().to_owned();
            let (status, payload) = if !authorized {
                ("401 Unauthorized", json!({"error": "unauthorized"}))
            } else if target == "/v1/me" {
                (
                    "200 OK",
                    json!({"user_hash": "abc123", "account": "SayIt abc123", "head_rev": 0}),
                )
            } else if let Some(query) = target.strip_prefix("/v1/records?") {
                let after: u64 = query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("after="))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let guard = state.lock();
                let changes = guard.map(|s| s.changes.clone()).unwrap_or_default();
                let records: Vec<Value> = changes
                    .iter()
                    .filter(|(rev, _)| *rev > after)
                    .map(|(_, record)| record.clone())
                    .collect();
                let head = changes.last().map_or(0, |(rev, _)| *rev);
                let next = records
                    .last()
                    .and_then(|r| r["rev"].as_u64())
                    .unwrap_or(after);
                (
                    "200 OK",
                    json!({"records": records, "next": next, "more": false, "head_rev": head}),
                )
            } else if method == "PUT" && target.starts_with("/v1/consumers/") {
                let rev = serde_json::from_slice::<Value>(&body)
                    .ok()
                    .and_then(|v| v["rev"].as_u64())
                    .unwrap_or(0);
                if let Ok(mut guard) = state.lock() {
                    guard.cursors.push(rev);
                }
                ("200 OK", json!({"rev": rev}))
            } else {
                ("404 Not Found", json!({"error": "not_found"}))
            };
            let text = payload.to_string();
            let mut stream = reader.into_inner();
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                text.len()
            );
        }
    });
    Ok(format!("http://{addr}"))
}

fn record(id: &str, rev: u64, title: &str, body: &str) -> Value {
    json!({
        "id": id, "rev": rev, "title": title, "kind": "own",
        "markdown": format!("---\nid: \"{id}\"\ntitle: \"{title}\"\n---\n# {title}\n{body}")
    })
}

fn texts(client: &IpcClient) -> Result<Vec<String>, Box<dyn Error>> {
    let value = serde_json::to_value(client.call(&IpcRequest::SeaMemories {
        query: None,
        state: Some(String::from("all")),
        cursor: None,
        limit: Some(200),
    })?)?;
    Ok(value["data"]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|m| m["source"]["kind"] == "sayit")
        .filter_map(|m| m["text"].as_str().map(String::from))
        .collect())
}

#[test]
fn what_was_said_in_sayit_flows_in_and_edits_and_deletions_follow() -> TestResult {
    let root = common::temp_root("sayit")?;
    let home = root.join("h");
    let state = Arc::new(Mutex::new(FakeSayIt::default()));
    let base = serve(Arc::clone(&state))?;
    if let Ok(mut guard) = state.lock() {
        guard.changes = vec![
            (
                1,
                record("s_1", 1, "周末咖啡车出摊", "周六上午九点在河边。"),
            ),
            (2, record("s_2", 2, "鸢尾花计划", "发布日定在周四。")),
        ];
    }

    assert!(
        quetzalcoatl_daemon::sayit_pull::connect(&home, Some(&base), "token-bad").is_err(),
        "错的令牌接不上"
    );
    let account = quetzalcoatl_daemon::sayit_pull::connect(&home, Some(&base), "token-ok")?;
    assert_eq!(account, "SayIt abc123");
    let connection = fs::read_to_string(home.join("sayit/connection.json"))?;
    assert!(connection.contains("token-ok"));

    let mut cfg = DaemonConfig::new(home.clone());
    cfg.fabric = None;
    let daemon = QuetzalcoatlDaemon::start(cfg)?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());

    let first = serde_json::to_value(client.call(&IpcRequest::SayItPull)?)?;
    assert_eq!(first["data"]["added"], 2, "{first}");
    let now = texts(&client)?;
    assert!(
        now.iter().any(|t| t.contains("周六上午九点在河边")),
        "{now:?}"
    );
    assert!(now.iter().any(|t| t.contains("发布日定在周四")), "{now:?}");

    // 第一条改了，第二条删了。
    if let Ok(mut guard) = state.lock() {
        guard
            .changes
            .push((3, record("s_1", 3, "周末咖啡车出摊", "改到周日上午十点。")));
        guard
            .changes
            .push((4, json!({"id": "s_2", "rev": 4, "deleted": true})));
    }
    let second = serde_json::to_value(client.call(&IpcRequest::SayItPull)?)?;
    assert_eq!(second["data"]["updated"], 1, "{second}");
    assert_eq!(second["data"]["erased"], 1, "{second}");
    let now = texts(&client)?;
    assert!(
        now.iter().any(|t| t.contains("改到周日上午十点")),
        "{now:?}"
    );
    assert!(
        !now.iter().any(|t| t.contains("周六上午九点")),
        "旧版本不留: {now:?}"
    );
    assert!(
        !now.iter().any(|t| t.contains("发布日定在周四")),
        "删掉的抹除: {now:?}"
    );

    let cursors = state.lock().map(|s| s.cursors.clone()).unwrap_or_default();
    assert_eq!(cursors, vec![2, 4], "落盘之后才上报游标，且只增");
    drop(daemon);
    let _ = fs::remove_dir_all(&root);
    Ok(())
}
