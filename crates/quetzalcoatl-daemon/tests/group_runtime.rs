#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 守护进程群运行时接线测试：建群、ANP-P9 发言门禁、密文提交与脊柱重启恢复。

use std::path::PathBuf;

use quetzalcoatl_daemon::{GroupRoomRuntime, base64_decode};
use quetzalcoatl_group::floor_control::{Mention, MentionKind, SenderKind};
use quetzalcoatl_spine::RusqliteWalStore;
use quetzalcoatl_types::{AgentId, DeviceId};

fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "quetzalcoatl-daemon-group-{tag}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp home");
    dir
}

#[test]
fn group_runtime_creates_room_sends_encrypted_commit_and_restores_from_spine() {
    let home = temp_home("runtime");
    let db_path = home.join("spine.sqlite");
    let mut store = RusqliteWalStore::open(&db_path).expect("open spine");
    let agent_id = AgentId::new_v4();
    let device_id = DeviceId::new_v4();
    let seed_hex = "11".repeat(32);

    let mut runtime = GroupRoomRuntime::new(home.clone(), agent_id, device_id, seed_hex.clone());
    let summary = runtime
        .create("daemon-room", 2, &mut store)
        .expect("create room");
    assert_eq!(summary.room_id, "daemon-room");
    assert_eq!(summary.mls_epoch, 0);
    assert_eq!(summary.members, vec![format!("agent:{agent_id}")]);

    let outcome = runtime
        .send(
            "daemon-room",
            "本轮结构化同步",
            vec![Mention {
                kind: MentionKind::AllAgents,
                target_agent_id: None,
            }],
            SenderKind::OwnerHuman,
            0,
            false,
            &mut store,
        )
        .expect("owner send");
    assert_eq!(outcome.floor_action, "RESPOND_STRUCTURED_CARD_ONCE");
    assert_eq!(outcome.authority_envelope, "OWNER_VERIFIED");
    let ciphertext = outcome.ciphertext_b64.expect("ciphertext present");
    let raw = base64_decode(&ciphertext).expect("base64 decode");
    assert!(!raw.is_empty());

    let silent = runtime
        .send(
            "daemon-room",
            "旁观光看",
            Vec::new(),
            SenderKind::OtherHuman,
            1,
            false,
            &mut store,
        )
        .expect("silent send");
    assert_eq!(silent.floor_action, "SILENT_PASS");
    assert!(silent.ciphertext_b64.is_none());

    drop(runtime);
    let mut restored = GroupRoomRuntime::new(home, agent_id, device_id, seed_hex);
    restored
        .restore(&store)
        .expect("restore rooms from spine snapshot");
    assert_eq!(restored.room_count(), 1);
    let restored_summary = restored.summary("daemon-room").expect("summary");
    assert_eq!(restored_summary.mls_epoch, 0);
    assert_eq!(restored_summary.members, vec![format!("agent:{agent_id}")]);
}
