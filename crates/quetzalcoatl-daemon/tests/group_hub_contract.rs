#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! Hub 契约测试：纪元门禁 fail-closed、发送/发布字节一致、`send` 与 IPC 同路径提交，
//! 以及 `leave` / `revoke-steward` 的 Hub 先行 + 幂等重试。
//!
//! 用一个进程内最小 HTTP Mock Hub 注入各阶段失败，绝不依赖真实 Go Hub 进程。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use quetzalcoatl_daemon::{
    GroupHubBinding, GroupRoomRuntime, PersistedFabricSession, base64_decode,
    group::push_prepared_to_hub,
};
use quetzalcoatl_group::floor_control::{Mention, MentionKind, SenderKind};
use quetzalcoatl_spine::RusqliteWalStore;
use quetzalcoatl_types::{AgentId, DeviceId};

fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "quetzalcoatl-hub-contract-{tag}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp home");
    dir
}

fn open_store(home: &std::path::Path) -> RusqliteWalStore {
    RusqliteWalStore::open(&home.join("spine.sqlite")).expect("open spine")
}

fn all_agents_mention() -> Vec<Mention> {
    vec![Mention {
        kind: MentionKind::AllAgents,
        target_agent_id: None,
    }]
}

#[derive(Default)]
struct MockState {
    commits: Vec<serde_json::Value>,
    delete_status: u16,
    delete_calls: usize,
    /// `None` 表示按请求 `after_seq` 回显（即“无新提交”）。
    head_seq: Option<u64>,
    epoch: u64,
}

struct MockHub {
    base_url: String,
    state: Arc<Mutex<MockState>>,
}

impl MockHub {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock hub");
        let base_url = format!("http://{}", listener.local_addr().expect("addr"));
        let state = Arc::new(Mutex::new(MockState {
            delete_status: 200,
            ..MockState::default()
        }));
        let shared = Arc::clone(&state);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let _ = handle_connection(stream, &shared);
            }
        });
        Self { base_url, state }
    }

    fn base_url(&self) -> &str {
        &self.base_url
    }

    fn binding(&self) -> GroupHubBinding {
        GroupHubBinding {
            base_url: self.base_url.clone(),
            session_token: Some(String::from("mock-token")),
            custom_ca_certs_der: Vec::new(),
        }
    }

    fn set_delete_status(&self, status: u16) {
        self.state.lock().expect("mock lock").delete_status = status;
    }

    fn set_epoch(&self, epoch: u64) {
        self.state.lock().expect("mock lock").epoch = epoch;
    }

    fn delete_calls(&self) -> usize {
        self.state.lock().expect("mock lock").delete_calls
    }

    fn commits(&self) -> Vec<serde_json::Value> {
        self.state.lock().expect("mock lock").commits.clone()
    }
}

fn handle_connection(mut stream: TcpStream, state: &Arc<Mutex<MockState>>) -> std::io::Result<()> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buf)?;
        if read == 0 {
            return Ok(());
        }
        raw.extend_from_slice(&buf[..read]);
        if let Some(pos) = find_header_end(&raw) {
            break pos;
        }
    };
    let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    while raw.len() < body_start + content_length {
        let read = stream.read(&mut buf)?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..read]);
    }
    let body = raw
        .get(body_start..body_start + content_length)
        .unwrap_or_default();

    let (status, payload) = route(&method, &path, body, state);
    let body_text = payload.to_string();
    let response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_text}",
        status_text(status),
        body_text.len()
    );
    stream.write_all(response.as_bytes())
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        404 => "Not Found",
        _ => "Internal Server Error",
    }
}

fn route(
    method: &str,
    path: &str,
    body: &[u8],
    state: &Arc<Mutex<MockState>>,
) -> (u16, serde_json::Value) {
    let target = path.split('?').next().unwrap_or(path);
    let query = path.split_once('?').map_or("", |(_, q)| q);
    if method == "POST" && target.ends_with("/commits") {
        let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(body) else {
            return (400, serde_json::json!({"code": "SERIALIZATION_ERROR"}));
        };
        let mut guard = state.lock().expect("mock lock");
        guard.commits.push(parsed.clone());
        let seq = guard.commits.len() as u64;
        let group_id = target
            .trim_start_matches('/')
            .split('/')
            .nth(2)
            .unwrap_or("room");
        return (
            201,
            serde_json::json!({
                "group_id": group_id,
                "server_seq": seq,
                "mls_epoch": parsed["mls_epoch"],
                "causal_parent_seq": parsed["causal_parent_seq"],
                "sender_agent_id": parsed["sender_agent_id"],
                "sender_device_id": parsed["sender_device_id"],
                "kind": parsed["kind"],
                "author_kind": parsed["author_kind"],
                "hop": 0,
                "created_at_ms": 1,
            }),
        );
    }
    if method == "GET" && target.ends_with("/commits") {
        let after_seq = query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(key, _)| *key == "after_seq")
            .and_then(|(_, value)| value.parse::<u64>().ok())
            .unwrap_or(0);
        let guard = state.lock().expect("mock lock");
        let head = guard.head_seq.unwrap_or(after_seq);
        return (
            200,
            serde_json::json!({
                "commits": [],
                "head_group_seq": head,
                "current_mls_epoch": guard.epoch,
            }),
        );
    }
    if method == "DELETE" && target.contains("/members/") {
        let mut guard = state.lock().expect("mock lock");
        guard.delete_calls += 1;
        let status = guard.delete_status;
        if status == 200 {
            return (
                200,
                serde_json::json!({"group_id": "room", "agent_id": "agent", "deleted": true}),
            );
        }
        return (
            status,
            serde_json::json!({"code": "STORAGE_ERROR", "detail": "injected"}),
        );
    }
    if method == "POST" && (target == "/v1/groups" || target.ends_with("/members")) {
        return (201, serde_json::json!({"ok": true}));
    }
    (404, serde_json::json!({"code": "NOT_FOUND"}))
}

fn write_session(home: &std::path::Path, base_url: &str, agent: AgentId, device: DeviceId) {
    let session = PersistedFabricSession {
        hub_url: base_url.to_owned(),
        hub_ca_file: None,
        relay_url: base_url.to_owned(),
        qad_port: 7842,
        session_token: String::from("mock-token"),
        account_id: String::from("acct"),
        agent_id: agent,
        device_id: device,
    };
    let dir = home.join("fabric");
    std::fs::create_dir_all(&dir).expect("create fabric dir");
    std::fs::write(
        dir.join("hub_session.json"),
        serde_json::to_vec_pretty(&session).expect("encode session"),
    )
    .expect("write session");
}

fn registry_rooms(home: &std::path::Path) -> Vec<String> {
    let raw = std::fs::read(home.join("group-rooms/registry.json")).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_slice(&raw).unwrap_or(serde_json::json!({}));
    value["rooms"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row["room_id"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn recorded(req: &serde_json::Value) -> BTreeMap<String, serde_json::Value> {
    [
        "kind",
        "author_kind",
        "mls_epoch",
        "reencrypt_only",
        "causal_parent_seq",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), req[key].clone()))
    .collect()
}

#[test]
fn send_submits_to_hub_and_reports_exactly_the_appended_bytes() {
    let home = temp_home("send");
    let mock = MockHub::start();
    let agent = AgentId::new_v4();
    let device = DeviceId::new_v4();
    write_session(&home, mock.base_url(), agent, device);
    let mut store = open_store(&home);
    let mut runtime = GroupRoomRuntime::new(home.clone(), agent, device, "22".repeat(32));
    runtime.create("hub-room", 1, &mut store).expect("create");
    runtime.with_hub(mock.binding()).expect("attach hub");

    let outcome = runtime
        .send(
            "hub-room",
            "hello hub",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            &mut store,
        )
        .expect("send");
    assert_eq!(outcome.server_seq, Some(1), "send must submit to the Hub");
    let commits = mock.commits();
    assert_eq!(commits.len(), 1, "exactly one commit must be submitted");
    let request = &commits[0];
    assert_eq!(request["sender_agent_id"], agent.to_string());
    assert_eq!(request["sender_device_id"], device.to_string());
    assert_eq!(request["mls_epoch"], 0);
    assert_eq!(request["reencrypt_only"], false);

    // 回报的密文必须就是真正上线的字节（绝不回报“待发布副本”）。
    let appended = base64_decode(request["ciphertext_b64"].as_str().expect("wire ciphertext"))
        .expect("decode appended");
    let reported = base64_decode(
        outcome
            .ciphertext_b64
            .as_deref()
            .expect("reported ciphertext"),
    )
    .expect("decode reported");
    assert!(!appended.is_empty());
    assert_eq!(appended, reported);
}

#[test]
fn hub_ahead_epoch_fails_closed_without_publishing_anything() {
    let home = temp_home("hub-ahead");
    let mock = MockHub::start();
    let agent = AgentId::new_v4();
    let device = DeviceId::new_v4();
    write_session(&home, mock.base_url(), agent, device);
    let mut store = open_store(&home);
    let mut runtime = GroupRoomRuntime::new(home, agent, device, "33".repeat(32));
    runtime.create("room", 1, &mut store).expect("create");
    runtime.with_hub(mock.binding()).expect("attach hub");
    // Hub 已推进到 e+1，而本机仍停留在 e：没有 EpochKey[e+1]，必须冲突。
    mock.set_epoch(1);

    let err = runtime
        .send(
            "room",
            "must not publish",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            &mut store,
        )
        .expect_err("hub-ahead epoch must fail closed");
    assert!(
        matches!(
            err,
            quetzalcoatl_types::QuetzalcoatlError::WatermarkConflict { .. }
        ),
        "expected WatermarkConflict, got {err:?}"
    );
    assert!(
        mock.commits().is_empty(),
        "nothing may be published when the local node lacks the new epoch key"
    );
}

#[test]
fn hub_ahead_epoch_manual_pipeline_refuses_to_publish() {
    // 绕过 `send` 直连 prepared → push：验证的网络阶段本身在 Hub 领先时 fail closed，
    // 而不是靠上层 shim 恰好没提交。
    let home = temp_home("hub-ahead-manual");
    let mock = MockHub::start();
    let agent = AgentId::new_v4();
    let device = DeviceId::new_v4();
    write_session(&home, mock.base_url(), agent, device);
    let mut store = open_store(&home);
    let mut runtime = GroupRoomRuntime::new(home, agent, device, "3a".repeat(32));
    runtime.create("room", 1, &mut store).expect("create");
    runtime.with_hub(mock.binding()).expect("attach hub");
    mock.set_epoch(1);

    let prepared = runtime
        .prepare_send(
            "room",
            "must not publish",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            "message",
            0,
        )
        .expect("prepare");
    let err = push_prepared_to_hub(&prepared).expect_err("hub-ahead must conflict");
    assert!(
        matches!(
            err,
            quetzalcoatl_types::QuetzalcoatlError::WatermarkConflict { .. }
        ),
        "expected WatermarkConflict, got {err:?}"
    );
    assert!(
        mock.commits().is_empty(),
        "no re-wrapped blob may be published without EpochKey[e+1]"
    );
}

#[test]
fn leave_is_hub_first_and_retryable_after_failure() {
    let home = temp_home("leave");
    let mock = MockHub::start();
    let agent = AgentId::new_v4();
    let device = DeviceId::new_v4();
    write_session(&home, mock.base_url(), agent, device);
    let mut store = open_store(&home);
    let mut runtime = GroupRoomRuntime::new(home.clone(), agent, device, "44".repeat(32));
    runtime.create("room", 1, &mut store).expect("create");
    runtime.with_hub(mock.binding()).expect("attach hub");

    mock.set_delete_status(500);
    let err = runtime
        .leave("room", &mut store)
        .expect_err("hub failure must abort leave");
    assert!(
        matches!(
            err,
            quetzalcoatl_types::QuetzalcoatlError::StorageError { .. }
        ),
        "expected storage error, got {err:?}"
    );
    assert_eq!(
        runtime.room_count(),
        1,
        "local room must survive a failed leave"
    );
    assert_eq!(
        registry_rooms(&home),
        vec![String::from("room")],
        "registry must still list the room for retry"
    );

    // Hub 恢复：重试必须完成撤销，且只发生一次本地清理。
    mock.set_delete_status(200);
    let left = runtime.leave("room", &mut store).expect("retry leave");
    assert!(left.left);
    assert_eq!(runtime.room_count(), 0);
    assert!(registry_rooms(&home).is_empty());
    let again = runtime.leave("room", &mut store).expect("idempotent leave");
    assert!(!again.left);
    assert_eq!(mock.delete_calls(), 2, "failed attempt + successful retry");
}

#[test]
fn revoke_steward_is_hub_first_and_retryable_exactly_once() {
    let home_a = temp_home("revoke-a");
    let home_b = temp_home("revoke-b");
    let mock = MockHub::start();
    let agent_a = AgentId::new_v4();
    let agent_b = AgentId::new_v4();
    let device_a = DeviceId::new_v4();
    let device_b = DeviceId::new_v4();
    let mut store_a = open_store(&home_a);
    let mut store_b = open_store(&home_b);
    let mut runtime_a = GroupRoomRuntime::new(home_a.clone(), agent_a, device_a, "55".repeat(32));
    let mut runtime_b = GroupRoomRuntime::new(home_b.clone(), agent_b, device_b, "66".repeat(32));

    runtime_a.create("room", 1, &mut store_a).expect("create");
    let key_package = runtime_b
        .invite_key_package("room")
        .expect("key package")
        .key_package_b64
        .expect("key package bytes");
    let handoff = runtime_a
        .add_member("room", &key_package, agent_b, true, &mut store_a)
        .expect("add member");
    runtime_b
        .join(
            "room",
            handoff.welcome_b64.as_deref().expect("welcome"),
            handoff.ratchet_tree_b64.as_deref().expect("ratchet tree"),
            &mut store_b,
        )
        .expect("join");
    let identity = format!("agent:{agent_b}");
    let before = runtime_a.summary("room").expect("summary");
    assert!(before.members.contains(&identity));

    write_session(&home_a, mock.base_url(), agent_a, device_a);
    runtime_a.with_hub(mock.binding()).expect("attach hub");

    mock.set_delete_status(500);
    runtime_a
        .revoke_steward("room", identity.as_bytes(), &mut store_a)
        .expect_err("hub failure must abort revoke");
    let after_failure = runtime_a.summary("room").expect("summary");
    assert!(
        after_failure.members.contains(&identity),
        "MLS membership must not be touched before the Hub revoke succeeds"
    );
    assert_eq!(
        after_failure.mls_epoch, before.mls_epoch,
        "no premature rotation"
    );

    // Hub 已无该成员（404）也是成功：重试必须完成踢人与轮换，且只做一次。
    mock.set_delete_status(404);
    let revoked = runtime_a
        .revoke_steward("room", identity.as_bytes(), &mut store_a)
        .expect("retry revoke");
    assert!(revoked.dropped_management_rights);
    assert_eq!(revoked.rotated_epoch, before.mls_epoch + 1);
    let after = runtime_a.summary("room").expect("summary");
    assert!(!after.members.contains(&identity), "member must be removed");
    assert_eq!(after.mls_epoch, before.mls_epoch + 1);

    // 再次调用不得重复踢人或重复轮换。
    runtime_a
        .revoke_steward("room", identity.as_bytes(), &mut store_a)
        .expect_err("grant is already revoked");
    assert_eq!(
        runtime_a.summary("room").expect("summary").mls_epoch,
        before.mls_epoch + 1
    );
}

#[test]
fn send_shim_and_manual_pipeline_submit_identical_envelopes() {
    let agent = AgentId::new_v4();
    let device = DeviceId::new_v4();
    let seed = "77".repeat(32);
    let mock = MockHub::start();

    let home_a = temp_home("parity-a");
    write_session(&home_a, mock.base_url(), agent, device);
    let mut store_a = open_store(&home_a);
    let mut shim = GroupRoomRuntime::new(home_a, agent, device, seed.clone());
    shim.create("room", 1, &mut store_a).expect("create");
    shim.with_hub(mock.binding()).expect("attach hub");
    let shim_outcome = shim
        .send(
            "room",
            "parity",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            &mut store_a,
        )
        .expect("shim send");

    let home_b = temp_home("parity-b");
    write_session(&home_b, mock.base_url(), agent, device);
    let mut store_b = open_store(&home_b);
    let mut manual = GroupRoomRuntime::new(home_b, agent, device, seed);
    manual.create("room", 1, &mut store_b).expect("create");
    manual.with_hub(mock.binding()).expect("attach hub");
    let prepared = manual
        .prepare_send(
            "room",
            "parity",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            "message",
            0,
        )
        .expect("prepare");
    let applied = push_prepared_to_hub(&prepared)
        .expect("push")
        .expect("hub submission");
    let manual_outcome = manual
        .finish_send(prepared, Some(applied), &mut store_b)
        .expect("finish");

    assert_eq!(shim_outcome.server_seq, Some(1));
    assert_eq!(manual_outcome.server_seq, Some(2));
    let commits = mock.commits();
    assert_eq!(commits.len(), 2, "both paths must actually submit");
    // 密文本身由各自 MLS 棘轮生成（每次加密消耗独立密钥/nonce，不可逐字节比较），
    // 但上线信封的语义字段必须完全一致，且两条路径都必须真正提交。
    assert_eq!(recorded(&commits[0]), recorded(&commits[1]));
    for commit in &commits {
        assert!(
            commit["ciphertext_b64"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            "both paths must publish a non-empty MLS payload: {commit}"
        );
    }
}
