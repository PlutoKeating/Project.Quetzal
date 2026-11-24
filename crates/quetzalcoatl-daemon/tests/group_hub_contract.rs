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
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore};
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
    commit_status: u16,
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
            commit_status: 201,
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

    fn set_commit_status(&self, status: u16) {
        self.state.lock().expect("mock lock").commit_status = status;
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
        if guard.commit_status != 201 {
            return (
                guard.commit_status,
                serde_json::json!({"code": "STORAGE_ERROR", "detail": "injected"}),
            );
        }
        guard.commits.push(parsed.clone());
        if let Some(epoch) = parsed["mls_epoch"].as_u64() {
            guard.epoch = guard.epoch.max(epoch);
        }
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
        let limit = query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(key, _)| *key == "limit")
            .and_then(|(_, value)| value.parse::<usize>().ok())
            .unwrap_or(200);
        let group_id = target
            .trim_start_matches('/')
            .split('/')
            .nth(2)
            .unwrap_or("room");
        let guard = state.lock().expect("mock lock");
        let rows: Vec<serde_json::Value> = guard
            .commits
            .iter()
            .enumerate()
            .skip(after_seq as usize)
            .take(limit)
            .map(|(idx, commit)| {
                serde_json::json!({
                    "group_id": group_id,
                    "server_seq": idx as u64 + 1,
                    "mls_epoch": commit["mls_epoch"],
                    "causal_parent_seq": commit["causal_parent_seq"],
                    "sender_agent_id": commit["sender_agent_id"],
                    "sender_device_id": commit["sender_device_id"],
                    "mentions": commit["mentions"],
                    "ciphertext_b64": commit["ciphertext_b64"],
                    "kind": commit["kind"],
                    "author_kind": commit["author_kind"],
                    "hop": 0,
                    "created_at_ms": 1,
                })
            })
            .collect();
        let head = guard.head_seq.unwrap_or(guard.commits.len() as u64);
        return (
            200,
            serde_json::json!({
                "commits": rows,
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
    if method == "POST" && target == "/v1/groups" {
        return (
            201,
            serde_json::json!({
                "group_id": target.trim_start_matches('/').split('/').nth(2).unwrap_or("room"),
                "owner_agent_id": "agent",
                "secrecy_level": 1,
                "current_mls_epoch": 0,
                "created_at_ms": 1,
            }),
        );
    }
    if method == "POST" && target.ends_with("/members") {
        let parsed: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
        return (
            201,
            serde_json::json!({
                "group_id": target.trim_start_matches('/').split('/').nth(2).unwrap_or("room"),
                "agent_id": parsed["agent_id"],
                "role": parsed["role"],
                "added_at_ms": 1,
            }),
        );
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

    // 再次调用不得重复踢人或重复轮换：尾步骤幂等收敛（补写注册表后返回成功）。
    let repeat = runtime_a
        .revoke_steward("room", identity.as_bytes(), &mut store_a)
        .expect("idempotent tail retry");
    assert_eq!(repeat.rotated_epoch, before.mls_epoch + 1);
    assert_eq!(
        runtime_a.summary("room").expect("summary").mls_epoch,
        before.mls_epoch + 1
    );
    // Hub 日志里恰好一条 MLS Commit，重试不得重复发布。
    assert_eq!(
        mock.commits()
            .iter()
            .filter(|commit| commit["kind"] == "mls_commit")
            .count(),
        1
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

fn peer_commit(
    seq: u64,
    epoch: u64,
    kind: &str,
    sender: AgentId,
    ciphertext_b64: &str,
) -> quetzalcoatl_fabric::GroupCommitRecord {
    quetzalcoatl_fabric::GroupCommitRecord {
        group_id: String::from("room"),
        server_seq: seq,
        mls_epoch: epoch,
        causal_parent_seq: seq.saturating_sub(1),
        sender_agent_id: sender.to_string(),
        sender_device_id: String::from("dev"),
        mentions: serde_json::json!([]),
        ciphertext_b64: ciphertext_b64.to_owned(),
        kind: kind.to_owned(),
        author_kind: String::from("agent"),
        hop: 0,
        created_at_ms: 1,
    }
}

#[test]
fn mls_commit_is_published_and_applied_by_peer_sync() {
    let home_a = temp_home("mls-a");
    let home_b = temp_home("mls-b");
    let mock = MockHub::start();
    let agent_a = AgentId::new_v4();
    let agent_b = AgentId::new_v4();
    let device_a = DeviceId::new_v4();
    let device_b = DeviceId::new_v4();
    let mut store_a = open_store(&home_a);
    let mut store_b = open_store(&home_b);
    let mut runtime_a = GroupRoomRuntime::new(home_a.clone(), agent_a, device_a, "88".repeat(32));
    let mut runtime_b = GroupRoomRuntime::new(home_b.clone(), agent_b, device_b, "99".repeat(32));

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
    let identity_b = format!("agent:{agent_b}");
    let epoch_before = runtime_b.summary("room").expect("summary").mls_epoch;

    write_session(&home_a, mock.base_url(), agent_a, device_a);
    write_session(&home_b, mock.base_url(), agent_b, device_b);
    runtime_a.with_hub(mock.binding()).expect("attach hub a");
    runtime_b.with_hub(mock.binding()).expect("attach hub b");

    runtime_a
        .revoke_steward("room", identity_b.as_bytes(), &mut store_a)
        .expect("revoke");

    // Hub 只知道 `mls_commit` 这个不透明 kind，绝不解析 MLS 明文。
    let commits = mock.commits();
    let published = commits
        .iter()
        .find(|commit| commit["kind"] == "mls_commit")
        .expect("MLS commit must be in the Hub log");
    assert_eq!(published["author_kind"], "agent");
    assert!(
        published["ciphertext_b64"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(
        published["mentions"]
            .as_array()
            .is_some_and(|mentions| mentions.is_empty())
    );

    // 未同步的成员不能自我推进；同步后必须与作者同纪元并失去成员资格。
    let synced = runtime_b
        .sync_watermark("room", &mut store_b)
        .expect("sync");
    assert_eq!(synced.mls_epoch, epoch_before + 1);
    assert!(!synced.members.contains(&identity_b));
    // 重复同步幂等：不得重复应用同一 Commit。
    let again = runtime_b
        .sync_watermark("room", &mut store_b)
        .expect("sync again");
    assert_eq!(again.mls_epoch, epoch_before + 1);
}

#[test]
fn apply_sync_rejects_gaps_and_skips_duplicates() {
    use quetzalcoatl_daemon::group::PreparedSync;

    let home = temp_home("sync-order");
    let agent = AgentId::new_v4();
    let mut store = open_store(&home);
    let mut runtime = GroupRoomRuntime::new(home, agent, DeviceId::new_v4(), "aa".repeat(32));
    runtime.create("room", 1, &mut store).expect("create");

    // 序号缺口（期望 1，收到 2）必须冲突，绝不乱序应用。
    let gap = PreparedSync {
        room_id: String::from("room"),
        commits: vec![peer_commit(2, 1, "mls_commit", AgentId::new_v4(), "AA==")],
        head_group_seq: 2,
        after_seq: 0,
    };
    assert!(matches!(
        runtime.apply_sync(gap, &mut store),
        Err(quetzalcoatl_types::QuetzalcoatlError::WatermarkConflict { .. })
    ));

    // MLS 纪元跳步（本地 0，提交声称 3）同样必须冲突。
    let jump = PreparedSync {
        room_id: String::from("room"),
        commits: vec![peer_commit(1, 3, "mls_commit", AgentId::new_v4(), "AA==")],
        head_group_seq: 1,
        after_seq: 0,
    };
    assert!(matches!(
        runtime.apply_sync(jump, &mut store),
        Err(quetzalcoatl_types::QuetzalcoatlError::WatermarkConflict { .. })
    ));

    // 重复序号（<= last_seen）必须跳过而非冲突。
    let duplicate = PreparedSync {
        room_id: String::from("room"),
        commits: vec![peer_commit(1, 1, "mls_commit", AgentId::new_v4(), "AA==")],
        head_group_seq: 1,
        after_seq: 1,
    };
    let summary = runtime
        .apply_sync(duplicate, &mut store)
        .expect("duplicate is skipped");
    assert_eq!(summary.mls_epoch, 0);
    assert_eq!(summary.mls_cursor_group_seq, 1);
    // 重复行只是被跳过，绝不能推进语义水位线。
    assert_eq!(summary.last_seen_group_seq, 0);
}

#[test]
fn leave_retry_after_publish_failure_converges_in_process() {
    let home = temp_home("leave-retry");
    let mock = MockHub::start();
    let agent = AgentId::new_v4();
    let device = DeviceId::new_v4();
    write_session(&home, mock.base_url(), agent, device);
    let mut store = open_store(&home);
    let mut runtime = GroupRoomRuntime::new(home.clone(), agent, device, "bb".repeat(32));
    runtime.create("room", 1, &mut store).expect("create");
    runtime.with_hub(mock.binding()).expect("attach hub");

    // 尾步骤（离群提案发布）失败：房间与注册表必须原样保留，可原地重试。
    mock.set_commit_status(500);
    runtime
        .leave("room", &mut store)
        .expect_err("publish failure must abort the tail");
    assert_eq!(runtime.room_count(), 1);
    assert_eq!(registry_rooms(&home), vec![String::from("room")]);

    mock.set_commit_status(201);
    assert!(runtime.leave("room", &mut store).expect("retry").left);
    assert_eq!(runtime.room_count(), 0);
    assert!(registry_rooms(&home).is_empty());
    assert!(!runtime.leave("room", &mut store).expect("done").left);
}

#[test]
fn revoke_retry_after_publish_failure_converges_in_process() {
    let home_a = temp_home("revoke-retry-a");
    let home_b = temp_home("revoke-retry-b");
    let mock = MockHub::start();
    let agent_a = AgentId::new_v4();
    let agent_b = AgentId::new_v4();
    let device_a = DeviceId::new_v4();
    let mut store_a = open_store(&home_a);
    let mut store_b = open_store(&home_b);
    let mut runtime_a = GroupRoomRuntime::new(home_a.clone(), agent_a, device_a, "cc".repeat(32));
    let mut runtime_b =
        GroupRoomRuntime::new(home_b.clone(), agent_b, DeviceId::new_v4(), "dd".repeat(32));
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
    let identity_b = format!("agent:{agent_b}");
    let before = runtime_a.summary("room").expect("summary");
    write_session(&home_a, mock.base_url(), agent_a, device_a);
    runtime_a.with_hub(mock.binding()).expect("attach hub");

    // Hub DELETE 成功但 MLS Commit 发布失败：绝不能先合并/轮换。
    mock.set_commit_status(500);
    runtime_a
        .revoke_steward("room", identity_b.as_bytes(), &mut store_a)
        .expect_err("publish failure must abort before merging");
    let after_failure = runtime_a.summary("room").expect("summary");
    assert!(after_failure.members.contains(&identity_b));
    assert_eq!(after_failure.mls_epoch, before.mls_epoch);

    // 重试必须完成撤销（待定 Commit 已丢弃，可重新生成），且只轮换一次。
    mock.set_commit_status(201);
    let revoked = runtime_a
        .revoke_steward("room", identity_b.as_bytes(), &mut store_a)
        .expect("retry revoke");
    assert_eq!(revoked.rotated_epoch, before.mls_epoch + 1);
    assert!(
        !runtime_a
            .summary("room")
            .expect("summary")
            .members
            .contains(&identity_b)
    );
    assert_eq!(
        mock.commits()
            .iter()
            .filter(|commit| commit["kind"] == "mls_commit")
            .count(),
        1
    );
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

fn hub_client(mock: &MockHub) -> quetzalcoatl_fabric::HubClient {
    quetzalcoatl_fabric::HubClient::new(quetzalcoatl_fabric::HubClientConfig {
        base_url: mock.base_url().to_owned(),
        session_token: Some(String::from("mock-token")),
        custom_ca_certs_der: Vec::new(),
    })
    .expect("hub client")
}

/// 以“对端成员”的身份直接往群日志写一行（绕过本地运行时）。
#[allow(clippy::too_many_arguments)]
fn post_as_peer(
    mock: &MockHub,
    room: &str,
    agent: AgentId,
    device: DeviceId,
    epoch: u64,
    kind: &str,
    ciphertext_b64: &str,
    reencrypt_only: bool,
    mentions: serde_json::Value,
) -> u64 {
    block_on(hub_client(mock).append_group_commit(
        room,
        agent,
        device,
        epoch,
        0,
        &mentions,
        ciphertext_b64,
        kind,
        "human",
        reencrypt_only,
    ))
    .expect("peer append")
    .server_seq
}

struct TwoMemberRoom {
    mock: MockHub,
    home_c: PathBuf,
    agent_b: AgentId,
    agent_c: AgentId,
    device_b: DeviceId,
    device_c: DeviceId,
    runtime_a: GroupRoomRuntime,
    runtime_b: GroupRoomRuntime,
    runtime_c: GroupRoomRuntime,
    store_a: RusqliteWalStore,
    store_b: RusqliteWalStore,
    store_c: RusqliteWalStore,
}

/// A（群主）+ B（协管）+ C（普通成员）的本地三人群，尚未接 Hub。
fn three_member_room() -> TwoMemberRoom {
    let home_a = temp_home("tm-a");
    let home_b = temp_home("tm-b");
    let home_c = temp_home("tm-c");
    let mock = MockHub::start();
    let agent_a = AgentId::new_v4();
    let agent_b = AgentId::new_v4();
    let agent_c = AgentId::new_v4();
    let device_a = DeviceId::new_v4();
    let device_b = DeviceId::new_v4();
    let device_c = DeviceId::new_v4();
    let mut store_a = open_store(&home_a);
    let mut store_b = open_store(&home_b);
    let mut store_c = open_store(&home_c);
    let mut runtime_a = GroupRoomRuntime::new(home_a.clone(), agent_a, device_a, "11".repeat(32));
    let mut runtime_b = GroupRoomRuntime::new(home_b.clone(), agent_b, device_b, "22".repeat(32));
    let mut runtime_c = GroupRoomRuntime::new(home_c.clone(), agent_c, device_c, "33".repeat(32));
    write_session(&home_a, mock.base_url(), agent_a, device_a);
    write_session(&home_b, mock.base_url(), agent_b, device_b);
    write_session(&home_c, mock.base_url(), agent_c, device_c);
    runtime_a.with_hub(mock.binding()).expect("hub a");
    runtime_b.with_hub(mock.binding()).expect("hub b");
    runtime_c.with_hub(mock.binding()).expect("hub c");
    runtime_a.create("room", 1, &mut store_a).expect("create");
    let kp_b = runtime_b
        .invite_key_package("room")
        .expect("kp b")
        .key_package_b64
        .expect("kp b");
    let handoff_b = runtime_a
        .add_member("room", &kp_b, agent_b, true, &mut store_a)
        .expect("add b");
    runtime_b
        .join(
            "room",
            handoff_b.welcome_b64.as_deref().expect("welcome"),
            handoff_b.ratchet_tree_b64.as_deref().expect("tree"),
            &mut store_b,
        )
        .expect("join b");
    let kp_c = runtime_c
        .invite_key_package("room")
        .expect("kp c")
        .key_package_b64
        .expect("kp c");
    let handoff_c = runtime_a
        .add_member("room", &kp_c, agent_c, false, &mut store_a)
        .expect("add c");
    runtime_c
        .join(
            "room",
            handoff_c.welcome_b64.as_deref().expect("welcome"),
            handoff_c.ratchet_tree_b64.as_deref().expect("tree"),
            &mut store_c,
        )
        .expect("join c");
    TwoMemberRoom {
        mock,
        home_c,
        agent_b,
        agent_c,
        device_b,
        device_c,
        runtime_a,
        runtime_b,
        runtime_c,
        store_a,
        store_b,
        store_c,
    }
}

#[test]
fn background_sync_never_consumes_pending_semantic_rows() {
    let mut room = three_member_room();

    // 自己的发布会推进 MLS 游标但绝不推进语义水位线。
    let before = room.runtime_a.summary("room").expect("summary");
    assert_eq!(before.last_seen_group_seq, 0);
    let seq = post_as_peer(
        &room.mock,
        "room",
        room.agent_b,
        room.device_b,
        2,
        "constraint_update",
        "Y29uc3RyYWludA==",
        false,
        serde_json::json!([{"kind":"all_agents"}]),
    );
    let synced = room
        .runtime_a
        .sync_watermark("room", &mut room.store_a)
        .expect("sync");
    assert_eq!(synced.pending_semantic_group_seq, Some(seq));
    assert_eq!(synced.last_seen_group_seq, 0, "语义水位线绝不能被心跳推进");

    let err = room
        .runtime_a
        .send(
            "room",
            "must-block",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            &mut room.store_a,
        )
        .expect_err("pending semantic row must block sending");
    assert!(matches!(
        err,
        quetzalcoatl_types::QuetzalcoatlError::WatermarkConflict { .. }
    ));

    let consumed = room
        .runtime_a
        .consume_semantic_watermark("room")
        .expect("consume");
    assert_eq!(consumed.pending_semantic_group_seq, None);
    assert_eq!(consumed.last_seen_group_seq, seq);
    let sent = room
        .runtime_a
        .send(
            "room",
            "after-consume",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            &mut room.store_a,
        )
        .expect("send after consume");
    assert!(sent.server_seq.is_some());
}

#[test]
fn leave_proposal_is_applied_and_owner_commit_drops_the_leaver() {
    let mut room = three_member_room();
    // B 先追平到当前纪元（否则其离群提案属于旧纪元，按协议本就不能应用）。
    room.runtime_b
        .sync_watermark("room", &mut room.store_b)
        .expect("b sync");
    let identity_b = format!("agent:{}", room.agent_b);
    let epoch_before = room.runtime_a.summary("room").expect("summary").mls_epoch;

    // B 自愿离群：只发布 SelfRemove 提案（协议禁止自提交移除）。
    assert!(
        room.runtime_b
            .leave("room", &mut room.store_b)
            .expect("leave")
            .left
    );
    let after_leave = room.runtime_a.summary("room").expect("summary");
    assert!(
        after_leave.members.contains(&identity_b),
        "提案尚未提交前，A 的名单里仍应有 B"
    );

    // A（群主）同步：应用提案并由群主提交，名单必须真正移除 B。
    let synced = room
        .runtime_a
        .sync_watermark("room", &mut room.store_a)
        .expect("owner sync");
    assert!(!synced.members.contains(&identity_b));
    assert_eq!(synced.mls_epoch, epoch_before + 1);
}

#[test]
fn restart_keeps_staged_proposals() {
    let mut room = three_member_room();
    room.runtime_b
        .sync_watermark("room", &mut room.store_b)
        .expect("b sync");
    assert!(
        room.runtime_b
            .leave("room", &mut room.store_b)
            .expect("leave")
            .left
    );
    // C 不是群主：只暂存提案并持久化，不替群主提交。
    let synced = room
        .runtime_c
        .sync_watermark("room", &mut room.store_c)
        .expect("c sync");
    assert!(synced.pending_semantic_group_seq.is_none());
    assert!(
        room.runtime_c.has_staged_proposals("room"),
        "提案必须进入 MLS 提案队列"
    );

    // 重启：从脊柱恢复后提案仍在（否则 server_seq 已标记已读却丢提案）。
    drop(room.runtime_c);
    let mut restored = GroupRoomRuntime::new(
        room.home_c.clone(),
        room.agent_c,
        room.device_c,
        "33".repeat(32),
    );
    restored.restore(&room.store_c).expect("restore");
    assert!(
        restored.has_staged_proposals("room"),
        "重启后已应用的提案必须仍可恢复"
    );
}

#[test]
fn revoke_selects_newest_active_grant_after_reinvite() {
    let home_a = temp_home("reinvite-a");
    let home_b1 = temp_home("reinvite-b1");
    let home_b2 = temp_home("reinvite-b2");
    let mock = MockHub::start();
    let agent_a = AgentId::new_v4();
    let agent_b = AgentId::new_v4();
    let device_a = DeviceId::new_v4();
    let mut store_a = open_store(&home_a);
    let mut store_b1 = open_store(&home_b1);
    let mut store_b2 = open_store(&home_b2);
    let mut runtime_a = GroupRoomRuntime::new(home_a.clone(), agent_a, device_a, "44".repeat(32));
    let mut runtime_b1 =
        GroupRoomRuntime::new(home_b1, agent_b, DeviceId::new_v4(), "45".repeat(32));
    let mut runtime_b2 =
        GroupRoomRuntime::new(home_b2, agent_b, DeviceId::new_v4(), "46".repeat(32));
    runtime_a.create("room", 1, &mut store_a).expect("create");
    let identity = format!("agent:{agent_b}");

    let invite = |runtime_b: &mut GroupRoomRuntime,
                  store_b: &mut RusqliteWalStore,
                  store_a: &mut RusqliteWalStore,
                  runtime_a: &mut GroupRoomRuntime| {
        let key_package = runtime_b
            .invite_key_package("room")
            .expect("kp")
            .key_package_b64
            .expect("kp bytes");
        let handoff = runtime_a
            .add_member("room", &key_package, agent_b, true, store_a)
            .expect("add");
        runtime_b
            .join(
                "room",
                handoff.welcome_b64.as_deref().expect("welcome"),
                handoff.ratchet_tree_b64.as_deref().expect("tree"),
                store_b,
            )
            .expect("join");
    };
    invite(&mut runtime_b1, &mut store_b1, &mut store_a, &mut runtime_a);

    write_session(&home_a, mock.base_url(), agent_a, device_a);
    runtime_a.with_hub(mock.binding()).expect("attach hub");

    runtime_a
        .revoke_steward("room", identity.as_bytes(), &mut store_a)
        .expect("first revoke");
    assert_eq!(mock.delete_calls(), 1);

    // 重新邀请同一 MLS 身份（新叶子、新授权），再吊销必须命中 Hub + MLS。
    invite(&mut runtime_b2, &mut store_b2, &mut store_a, &mut runtime_a);
    let before_second = runtime_a.summary("room").expect("summary").mls_epoch;
    let second = runtime_a
        .revoke_steward("room", identity.as_bytes(), &mut store_a)
        .expect("second revoke must target the active grant");
    assert_eq!(
        mock.delete_calls(),
        2,
        "re-invite revoke must hit the Hub again"
    );
    assert_eq!(second.rotated_epoch, before_second + 1);
    assert!(
        !runtime_a
            .summary("room")
            .expect("summary")
            .members
            .contains(&identity)
    );
}

#[test]
fn same_agent_other_device_commit_is_applied_on_sync() {
    let home_a1 = temp_home("samedev-a1");
    let home_a2 = temp_home("samedev-a2");
    let home_c = temp_home("samedev-c");
    let mock = MockHub::start();
    let agent_a = AgentId::new_v4();
    let device_a1 = DeviceId::new_v4();
    let device_a2 = DeviceId::new_v4();
    let mut store_a1 = open_store(&home_a1);
    let mut store_a2 = open_store(&home_a2);
    let mut store_c = open_store(&home_c);
    let mut a1 = GroupRoomRuntime::new(home_a1.clone(), agent_a, device_a1, "2a".repeat(32));
    let mut a2 = GroupRoomRuntime::new(home_a2.clone(), agent_a, device_a2, "2b".repeat(32));
    let agent_c = AgentId::new_v4();
    let mut c = GroupRoomRuntime::new(home_c, agent_c, DeviceId::new_v4(), "2c".repeat(32));
    a1.create("room", 1, &mut store_a1).expect("create");
    let kp_a2 = a2
        .invite_key_package("room")
        .expect("kp a2")
        .key_package_b64
        .expect("kp a2");
    let handoff = a1
        .add_member("room", &kp_a2, agent_a, false, &mut store_a1)
        .expect("add a2");
    a2.join(
        "room",
        handoff.welcome_b64.as_deref().expect("welcome"),
        handoff.ratchet_tree_b64.as_deref().expect("tree"),
        &mut store_a2,
    )
    .expect("a2 join");

    write_session(&home_a1, mock.base_url(), agent_a, device_a1);
    write_session(&home_a2, mock.base_url(), agent_a, device_a2);
    a1.with_hub(mock.binding()).expect("hub a1");
    a2.with_hub(mock.binding()).expect("hub a2");

    // A1 邀请 C：该 MLS Commit 的 sender_agent_id 与 A2 相同（同一 Agent 的另一台设备）。
    let kp_c = c
        .invite_key_package("room")
        .expect("kp c")
        .key_package_b64
        .expect("kp c");
    a1.add_member("room", &kp_c, agent_c, false, &mut store_a1)
        .expect("add c");
    let _ = &mut store_c;

    let synced = a2.sync_watermark("room", &mut store_a2).expect("a2 sync");
    assert_eq!(
        synced.mls_epoch, 2,
        "same-agent commit from another device must advance A2's epoch"
    );
    assert!(synced.members.contains(&format!("agent:{agent_c}")));
}

#[test]
fn invite_before_sync_still_surfaces_peer_constraint() {
    let mut room = three_member_room();
    // 对端先写入一条语义约束（seq 1，当前纪元）。
    let seq = post_as_peer(
        &room.mock,
        "room",
        room.agent_b,
        room.device_b,
        2,
        "constraint_update",
        "Y29uc3RyYWludA==",
        false,
        serde_json::json!([{"kind":"all_agents"}]),
    );
    // 群主在同步之前先邀请新成员（自己的发布绝不能被当成“已读”）。
    let home_d = temp_home("invite-before-sync-d");
    let agent_d = AgentId::new_v4();
    let mut fresh_d = GroupRoomRuntime::new(home_d, agent_d, DeviceId::new_v4(), "5a".repeat(32));
    let kp = fresh_d
        .invite_key_package("room")
        .expect("kp")
        .key_package_b64
        .expect("kp bytes");
    room.runtime_a
        .add_member("room", &kp, agent_d, false, &mut room.store_a)
        .expect("invite");

    let synced = room
        .runtime_a
        .sync_watermark("room", &mut room.store_a)
        .expect("sync");
    assert_eq!(
        synced.pending_semantic_group_seq,
        Some(seq),
        "own publishes must never skip an unread peer constraint"
    );
    let err = room
        .runtime_a
        .send(
            "room",
            "blocked",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            &mut room.store_a,
        )
        .expect_err("pending constraint must block");
    match err {
        quetzalcoatl_types::QuetzalcoatlError::WatermarkConflict {
            last_seen_seq,
            head_seq,
        } => assert!(
            head_seq >= last_seen_seq,
            "conflict range must never invert: last_seen={last_seen_seq} head={head_seq}"
        ),
        other => panic!("expected WatermarkConflict, got {other:?}"),
    }
}

#[test]
fn corrupted_proposal_fails_closed_without_advancing_cursor() {
    let mut room = three_member_room();
    // 当前纪元的 MLS 控制消息，但载荷是垃圾：必须报错且不得推进游标。
    post_as_peer(
        &room.mock,
        "room",
        room.agent_b,
        room.device_b,
        2,
        "mls_commit",
        "bm90LWFuLW1scy1wYXlsb2Fk",
        false,
        serde_json::json!([]),
    );
    let err = room
        .runtime_a
        .sync_watermark("room", &mut room.store_a)
        .expect_err("corrupted proposal must fail closed");
    assert!(
        matches!(
            err,
            quetzalcoatl_types::QuetzalcoatlError::IntegrityViolation { .. }
                | quetzalcoatl_types::QuetzalcoatlError::WatermarkConflict { .. }
        ),
        "expected a typed failure, got {err:?}"
    );
    assert_eq!(
        room.runtime_a
            .summary("room")
            .expect("summary")
            .mls_cursor_group_seq,
        0,
        "failed sync must not advance the MLS cursor"
    );
}

#[test]
fn read_consumes_by_default_so_read_send_loops_never_deadlock() {
    let mut room = three_member_room();
    room.runtime_b
        .sync_watermark("room", &mut room.store_b)
        .expect("b sync");
    // B 用真实 MLS 明文发布一条语义约束：消费必须由“交付并解密这一行”驱动。
    let prepared = room
        .runtime_b
        .prepare_send(
            "room",
            "不要花生",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            "constraint_update",
            0,
        )
        .expect("prepare constraint message");
    let ciphertext = quetzalcoatl_daemon::base64_encode(&prepared.mls_ciphertext);
    let seq = post_as_peer(
        &room.mock,
        "room",
        room.agent_b,
        room.device_b,
        2,
        "constraint_update",
        &ciphertext,
        false,
        serde_json::json!([{"kind":"all_agents"}]),
    );
    let synced = room
        .runtime_a
        .sync_watermark("room", &mut room.store_a)
        .expect("a sync");
    assert_eq!(synced.pending_semantic_group_seq, Some(seq));

    // history 能取回该行的密文与元数据。
    let rows = room
        .runtime_a
        .history("room", seq.saturating_sub(1), 10)
        .expect("history");
    let row = rows
        .iter()
        .find(|row| row.server_seq == seq && row.kind == "constraint_update")
        .expect("constraint row in history");
    assert_eq!(row.author_device_id, room.device_b.to_string());

    // peek 只读不消费：明文送达了，但水位线不动，发送仍冲突。
    let peeked = room
        .runtime_a
        .decrypt_room_message(
            "room",
            &row.ciphertext_b64,
            Some(row.server_seq),
            false,
            &mut room.store_a,
        )
        .expect("peek decrypts the constraint");
    assert_eq!(peeked, "不要花生");
    assert_eq!(
        room.runtime_a
            .summary("room")
            .expect("summary")
            .pending_semantic_group_seq,
        Some(seq),
        "peek must not consume the semantic watermark"
    );
    assert!(matches!(
        room.runtime_a.acknowledge_delivered("room", 0),
        Ok(())
    ));
    assert_eq!(
        room.runtime_a
            .summary("room")
            .expect("summary")
            .pending_semantic_group_seq,
        Some(seq),
        "an unrelated seq must never clear the pending constraint"
    );

    // 确认这一行已交付并解密 → 消费到该行，发送恢复。
    room.runtime_a
        .acknowledge_delivered("room", seq)
        .expect("ack delivered row");
    assert_eq!(
        room.runtime_a
            .summary("room")
            .expect("summary")
            .pending_semantic_group_seq,
        None
    );
    let sent = room
        .runtime_a
        .send(
            "room",
            "auto-reply",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            &mut room.store_a,
        )
        .expect("send after delivered+consumed must succeed");
    assert!(sent.server_seq.is_some());
}

#[test]
fn pending_merge_only_for_same_device() {
    let device = DeviceId::new_v4();
    assert!(
        quetzalcoatl_daemon::group::pending_commit_belongs_to_device(&device.to_string(), device)
    );
    assert!(
        !quetzalcoatl_daemon::group::pending_commit_belongs_to_device(
            &DeviceId::new_v4().to_string(),
            device
        )
    );
}

#[test]
fn legacy_registry_can_claim_ownership_and_then_commit_leaves() {
    let home_a = temp_home("legacy-owner-a");
    let home_b = temp_home("legacy-owner-b");
    let mock = MockHub::start();
    let agent_a = AgentId::new_v4();
    let agent_b = AgentId::new_v4();
    let device_a = DeviceId::new_v4();
    let device_b = DeviceId::new_v4();
    let mut store_a = open_store(&home_a);
    let mut store_b = open_store(&home_b);
    let mut runtime_a = GroupRoomRuntime::new(home_a.clone(), agent_a, device_a, "6a".repeat(32));
    let mut runtime_b = GroupRoomRuntime::new(home_b.clone(), agent_b, device_b, "6b".repeat(32));
    write_session(&home_a, mock.base_url(), agent_a, device_a);
    write_session(&home_b, mock.base_url(), agent_b, device_b);
    runtime_a.with_hub(mock.binding()).expect("hub a");
    runtime_b.with_hub(mock.binding()).expect("hub b");

    runtime_a.create("room", 1, &mut store_a).expect("create");
    let kp = runtime_b
        .invite_key_package("room")
        .expect("kp")
        .key_package_b64
        .expect("kp bytes");
    let handoff = runtime_a
        .add_member("room", &kp, agent_b, true, &mut store_a)
        .expect("add b");
    runtime_b
        .join(
            "room",
            handoff.welcome_b64.as_deref().expect("welcome"),
            handoff.ratchet_tree_b64.as_deref().expect("tree"),
            &mut store_b,
        )
        .expect("join");
    runtime_b
        .sync_watermark("room", &mut store_b)
        .expect("b sync");

    // 模拟旧注册表：抹掉 is_owner 后重启恢复。
    let registry_path = home_a.join("group-rooms/registry.json");
    let mut registry: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&registry_path).expect("registry"))
            .expect("registry json");
    if let Some(rooms) = registry["rooms"].as_array_mut() {
        for entry in rooms {
            if entry["room_id"] == "room" {
                entry["is_owner"] = serde_json::json!(false);
            }
        }
    }
    std::fs::write(
        &registry_path,
        serde_json::to_vec(&registry).expect("encode"),
    )
    .expect("write registry");

    drop(runtime_a);
    let mut restored = GroupRoomRuntime::new(home_a.clone(), agent_a, device_a, "6a".repeat(32));
    restored.restore(&store_a).expect("restore");
    restored.with_hub(mock.binding()).expect("hub a restored");
    assert!(
        !restored.summary("room").expect("summary").is_owner,
        "legacy registry must not assume ownership"
    );

    let claimed = restored.claim_owner("room").expect("claim owner");
    assert!(claimed.is_owner);

    // 升级后的房主必须能替离群成员提交，使其真正离开名单。
    let identity_b = format!("agent:{agent_b}");
    assert!(runtime_b.leave("room", &mut store_b).expect("leave").left);
    let synced = restored
        .sync_watermark("room", &mut store_a)
        .expect("owner sync");
    assert!(!synced.members.contains(&identity_b));
}

/// 同一 Agent 的两台设备：A1 发布的离群提案必须被 A2 暂存，群主按引用提交后 A2 能解析。
#[test]
fn same_agent_other_device_proposal_is_staged_and_resolves() {
    let home_o = temp_home("xdev-o");
    let home_a1 = temp_home("xdev-a1");
    let home_a2 = temp_home("xdev-a2");
    let mock = MockHub::start();
    let agent_o = AgentId::new_v4();
    let agent_a = AgentId::new_v4();
    let device_o = DeviceId::new_v4();
    let device_a1 = DeviceId::new_v4();
    let device_a2 = DeviceId::new_v4();
    let mut store_o = open_store(&home_o);
    let mut store_a1 = open_store(&home_a1);
    let mut store_a2 = open_store(&home_a2);
    let mut owner = GroupRoomRuntime::new(home_o.clone(), agent_o, device_o, "71".repeat(32));
    let mut a1 = GroupRoomRuntime::new(home_a1.clone(), agent_a, device_a1, "72".repeat(32));
    let mut a2 = GroupRoomRuntime::new(home_a2.clone(), agent_a, device_a2, "73".repeat(32));
    for (home, agent, device) in [
        (&home_o, agent_o, device_o),
        (&home_a1, agent_a, device_a1),
        (&home_a2, agent_a, device_a2),
    ] {
        write_session(home, mock.base_url(), agent, device);
    }
    owner.with_hub(mock.binding()).expect("hub o");
    a1.with_hub(mock.binding()).expect("hub a1");
    a2.with_hub(mock.binding()).expect("hub a2");

    owner.create("room", 1, &mut store_o).expect("create");
    for (runtime, store) in [(&mut a1, &mut store_a1), (&mut a2, &mut store_a2)] {
        let kp = runtime
            .invite_key_package("room")
            .expect("kp")
            .key_package_b64
            .expect("kp bytes");
        let handoff = owner
            .add_member("room", &kp, agent_a, false, &mut store_o)
            .expect("add device");
        runtime
            .join(
                "room",
                handoff.welcome_b64.as_deref().expect("welcome"),
                handoff.ratchet_tree_b64.as_deref().expect("tree"),
                store,
            )
            .expect("join");
    }
    // 两台设备都追平到当前纪元，A1 才能发布当前纪元的离群提案。
    a1.sync_watermark("room", &mut store_a1).expect("a1 sync");
    a2.sync_watermark("room", &mut store_a2).expect("a2 sync");

    assert!(a1.leave("room", &mut store_a1).expect("a1 leave").left);

    // A2 必须暂存同一 Agent 另一台设备发布的提案（而不是当作“自己的”跳过）。
    a2.sync_watermark("room", &mut store_a2).expect("a2 sync");
    assert!(
        a2.has_staged_proposals("room"),
        "cross-device proposal must be staged on the peer device"
    );

    // 群主按引用提交该提案；A2 必须能解析引用并继续同步（绝不 wedge）。
    let epoch_before = owner.summary("room").expect("summary").mls_epoch;
    let committed = owner
        .sync_watermark("room", &mut store_o)
        .expect("owner commits staged proposal");
    assert_eq!(
        committed.mls_epoch,
        epoch_before + 1,
        "owner must commit the proposal"
    );
    let a2_after = a2
        .sync_watermark("room", &mut store_a2)
        .expect("a2 must resolve the referenced proposal");
    assert_eq!(a2_after.mls_epoch, committed.mls_epoch);
    // 再同步一次仍然干净。
    a2.sync_watermark("room", &mut store_a2).expect("a2 resync");
}

#[test]
fn quarantine_is_owner_only_and_recovers_sync() {
    let mut room = three_member_room();
    // 对端发布一条无法解析的 mls_commit：默认必须 wedge 同步。
    let seq = post_as_peer(
        &room.mock,
        "room",
        room.agent_b,
        room.device_b,
        2,
        "mls_commit",
        "cG9pc29uZWQtbWxz",
        false,
        serde_json::json!([]),
    );
    room.runtime_a
        .sync_watermark("room", &mut room.store_a)
        .expect_err("poisoned commit must wedge sync by default");

    // 非群主不得隔离。
    let denied = room
        .runtime_c
        .quarantine_commit("room", seq, "测试越权", &mut room.store_c)
        .expect_err("non-owner must not quarantine");
    assert!(matches!(
        denied,
        quetzalcoatl_types::QuetzalcoatlError::PermissionDenied { .. }
    ));

    // 群主审计隔离后：同步与发送恢复，且记录在状态与脊柱审计块中可见。
    let quarantined = room
        .runtime_a
        .quarantine_commit("room", seq, "对端载荷损坏，无法解析", &mut room.store_a)
        .expect("owner quarantine");
    assert_eq!(
        quarantined
            .quarantined
            .iter()
            .map(|record| record.server_seq)
            .collect::<Vec<_>>(),
        vec![seq]
    );
    let audit = room
        .store_a
        .get_private_blob("groups/audit/quarantine/room")
        .expect("audit read")
        .expect("audit blob");
    assert!(audit.contains("对端载荷损坏，无法解析"));
    assert!(audit.contains(&seq.to_string()));

    let synced = room
        .runtime_a
        .sync_watermark("room", &mut room.store_a)
        .expect("sync resumes past quarantined row");
    assert_eq!(synced.quarantined.len(), 1);
    let sent = room
        .runtime_a
        .send(
            "room",
            "after-quarantine",
            all_agents_mention(),
            SenderKind::OwnerHuman,
            0,
            false,
            &mut room.store_a,
        )
        .expect("send resumes after quarantine");
    assert!(sent.server_seq.is_some());
}
