#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! 物理隔离（Pitfall #19 / D-19）、踢人纪元前向安全、StewardGrant 可吊销托管与
//! 异构编队零拷贝交接集成测试。

use std::path::{Path, PathBuf};
use std::process::Command;

use quetzalcoatl_group::a2a_mandate::{
    AgentCard, AttenuatedMandate, MandateRequest, SignedAgentCard, jcs_canonicalize,
};
use quetzalcoatl_group::mls_room::{GroupRoomEngine, MlsIdentity};
use quetzalcoatl_group::squad::{
    ArtifactRef, GitCliSquadWorkspace, HeterogeneousSquadCoordinator, SquadMember, SquadRole,
    SquadWorkspace,
};
use quetzalcoatl_group::steward::{
    GroupTrustDomain, SharedRoleAgentBinding, StewardGrant, StewardRegistry,
};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore};
use quetzalcoatl_types::{AgentId, ErrorCode, QuetzalcoatlError};

fn temp_dir(tag: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("quetzalcoatl-group-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn one_shared_role_instance_binds_to_exactly_one_group_trust_domain() {
    let agent_id = AgentId::new_v4();
    let mut binding = SharedRoleAgentBinding::new(agent_id, 1);
    binding
        .bind(GroupTrustDomain {
            group_id: String::from("family-room"),
            secrecy_level: 1,
        })
        .expect("first binding succeeds");
    binding
        .bind(GroupTrustDomain {
            group_id: String::from("family-room"),
            secrecy_level: 1,
        })
        .expect("idempotent rebinding of the same domain");

    let err = binding
        .bind(GroupTrustDomain {
            group_id: String::from("company-room"),
            secrecy_level: 3,
        })
        .expect_err("a shared-role instance must never join a second trust domain");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);

    let secrecy_err = binding
        .bind(GroupTrustDomain {
            group_id: String::from("family-room"),
            secrecy_level: 4,
        })
        .expect_err("secrecy level cannot be silently raised on the same instance");
    assert_eq!(secrecy_err.code(), ErrorCode::ConscienceViolation);
}

#[test]
fn removed_member_cannot_decrypt_next_epoch_and_steward_revocation_rotates_epoch() {
    let alice_id = MlsIdentity::generate("alice").expect("alice identity");
    let bob_id = MlsIdentity::generate("bob").expect("bob identity");
    let mut alice = GroupRoomEngine::create("family-room", &alice_id).expect("create group");
    let bob_pending =
        GroupRoomEngine::prepare_join("family-room", &bob_id).expect("bob key package");
    let handoff = alice
        .add_member(bob_pending.key_package_bytes())
        .expect("invite bob");
    let mut bob = GroupRoomEngine::join(bob_pending, &handoff.welcome, &handoff.ratchet_tree)
        .expect("bob joins");
    alice.commit_pending().expect("alice merges add commit");
    assert_eq!(alice.mls_epoch(), bob.mls_epoch());
    assert_eq!(
        alice.members(),
        vec![String::from("alice"), String::from("bob")]
    );

    let epoch_before = alice.mls_epoch();
    let bob_epoch_secret_before = bob.epoch_secret().expect("bob epoch secret");
    let alice_secret_before = alice.epoch_secret().expect("alice epoch secret");
    assert_eq!(bob_epoch_secret_before, alice_secret_before);
    let plaintext = b"epoch-e application message";
    let ciphertext = alice.encrypt_application(plaintext).expect("encrypt");
    assert_eq!(
        bob.decrypt_application(&ciphertext).expect("bob decrypts"),
        plaintext
    );

    // StewardGrant 绑定 openmls 成员身份；吊销会立即失去管理权并要求轮换 EpochKey[e+1]。
    let mut registry = StewardRegistry::new();
    let grant = StewardGrant::new(
        "family-room",
        bob_id.agent_identity(),
        bob.identity_bytes(),
        alice_id.agent_identity(),
        epoch_before,
        1_800_000_000_000,
    )
    .expect("build steward grant");
    let grant_id = grant.grant_id.clone();
    registry.issue(grant).expect("issue steward grant");
    assert!(registry.get(&grant_id).is_some());
    assert!(
        registry
            .has_management_rights("family-room", &bob.identity_bytes(), 1_800_000_000_100)
            .expect("check rights")
    );

    let revocation = registry
        .revoke(&grant_id, epoch_before, 1_800_000_000_200)
        .expect("revoke steward grant");
    assert!(revocation.dropped_management_rights);
    assert_eq!(revocation.rotated_epoch, epoch_before + 1);
    assert!(
        !registry
            .has_management_rights("family-room", &bob.identity_bytes(), 1_800_000_000_300)
            .expect("check rights after revoke"),
        "revoked co-steward must lose management rights immediately"
    );

    let removal = alice.remove_member("bob").expect("remove bob");
    alice.commit_pending().expect("merge removal commit");
    assert_eq!(alice.mls_epoch(), epoch_before + 1);
    assert_eq!(alice.mls_epoch(), revocation.rotated_epoch);
    assert_eq!(alice.members(), vec![String::from("alice")]);
    assert_eq!(removal.epoch, alice.mls_epoch());

    let new_epoch_secret = alice.epoch_secret().expect("rotated epoch secret");
    assert_ne!(
        new_epoch_secret, alice_secret_before,
        "epoch removal must rotate the group epoch secret"
    );
    let next_ciphertext = alice
        .encrypt_application(b"post-removal secret")
        .expect("encrypt at new epoch");
    let err = bob
        .decrypt_application(&next_ciphertext)
        .expect_err("removed member must not decrypt EpochKey[e+1] traffic");
    assert!(
        matches!(
            err.code(),
            ErrorCode::IntegrityViolation
                | ErrorCode::VerificationFailed
                | ErrorCode::PermissionDenied
                | ErrorCode::SerializationError
                | ErrorCode::StorageError
        ),
        "unexpected forward-secrecy error: {err:?}"
    );
    assert_eq!(
        bob.mls_epoch(),
        epoch_before,
        "removed member is stranded at the old epoch"
    );
}

#[test]
fn mls_group_state_persists_to_spine_and_resumes_after_restart() {
    let dir = temp_dir("persist");
    let db_path = dir.join("spine.sqlite");
    let alice_id = MlsIdentity::generate("alice").expect("alice identity");
    let bob_id = MlsIdentity::generate("bob").expect("bob identity");
    let mut alice = GroupRoomEngine::create("restart-room", &alice_id).expect("create");
    let bob_pending = GroupRoomEngine::prepare_join("restart-room", &bob_id).expect("bob kp");
    let handoff = alice
        .add_member(bob_pending.key_package_bytes())
        .expect("invite");
    let mut bob =
        GroupRoomEngine::join(bob_pending, &handoff.welcome, &handoff.ratchet_tree).expect("join");
    alice.commit_pending().expect("merge");

    let mut store = RusqliteWalStore::open(&db_path).expect("open spine store");
    alice.persist_to(&mut store).expect("persist mls state");
    // MLS 私钥材料只能进入不可导出的私有状态块，绝不能混入可读 Markdown/ZIP 导出。
    let exported_docs = store.list_markdown_docs().expect("list markdown docs");
    assert!(
        exported_docs
            .iter()
            .all(|(path, _)| !path.contains("groups/mls")),
        "MLS private state must never appear in readable exports"
    );
    assert!(
        store
            .get_private_blob("groups/mls/restart-room")
            .expect("private blob lookup")
            .is_some(),
        "MLS state must be stored in the non-exportable private blob table"
    );
    drop(store);
    drop(alice);

    let store = RusqliteWalStore::open(&db_path).expect("reopen spine store");
    let mut resumed =
        GroupRoomEngine::restore("restart-room", &alice_id, &store).expect("restore engine");
    assert_eq!(resumed.mls_epoch(), bob.mls_epoch());
    let ciphertext = resumed
        .encrypt_application(b"resumed after restart")
        .expect("encrypt after restore");
    assert_eq!(
        bob.decrypt_application(&ciphertext).expect("bob decrypts"),
        b"resumed after restart"
    );
    let response = bob
        .encrypt_application(b"welcome back")
        .expect("bob encrypts");
    assert_eq!(
        resumed
            .decrypt_application(&response)
            .expect("resumed decrypts"),
        b"welcome back"
    );
    cleanup(&dir);
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

#[test]
fn heterogeneous_squad_hands_off_uncommitted_work_via_immutable_git_tree_refs() {
    let dir = temp_dir("squad");
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "user.email", "squad@example.invalid"]);
    git(&dir, &["config", "user.name", "Squad"]);
    std::fs::write(dir.join("design.md"), "v1\n").expect("write design");
    git(&dir, &["add", "design.md"]);
    git(&dir, &["commit", "-q", "-m", "initial"]);

    // 架构 Agent 产出未提交修改：只通过不可变 Git tree 交接，不碰目标仓库工作树。
    std::fs::write(dir.join("design.md"), "v2-uncommitted\n").expect("write uncommitted");
    let head_before = git(&dir, &["rev-parse", "HEAD"]);
    let status_before = git(&dir, &["status", "--porcelain"]);

    let conscience_digest = [42u8; 32];
    let members = vec![
        SquadMember::new(SquadRole::Architect, "claude-code", AgentId::new_v4()),
        SquadMember::new(SquadRole::Main, "opencode", AgentId::new_v4()),
        SquadMember::new(SquadRole::Reviewer, "codex", AgentId::new_v4()),
    ];
    let mut coordinator = HeterogeneousSquadCoordinator::new("squad-1", members, conscience_digest)
        .expect("build coordinator");
    let mut workspace = GitCliSquadWorkspace::open(&dir).expect("open git workspace");
    let artifact = workspace
        .capture_uncommitted_tree()
        .expect("capture uncommitted work as immutable tree");
    assert!(matches!(artifact, ArtifactRef::GitTree(_)));

    let receipt = coordinator
        .handoff(
            &mut workspace,
            SquadRole::Architect,
            SquadRole::Main,
            artifact.clone(),
        )
        .expect("handoff");
    assert_eq!(
        receipt.ref_name,
        format!("refs/qz/squad/squad-1/{}", receipt.to.as_str())
    );
    assert_eq!(
        workspace
            .resolve_ref(&receipt.ref_name)
            .expect("resolve ref"),
        Some(artifact.oid().to_owned())
    );
    assert_eq!(receipt.conscience_digest, conscience_digest);
    assert_eq!(
        coordinator.conscience_digest(),
        conscience_digest,
        "conscience snapshot must stay read-only"
    );

    // 审阅方用同一不可变 tree 读取，不依赖工作树；工作树与 HEAD 均未发生变更。
    let reviewed = workspace
        .read_blob(&artifact, "design.md")
        .expect("read blob");
    assert_eq!(reviewed, "v2-uncommitted\n");
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head_before);
    assert_eq!(git(&dir, &["status", "--porcelain"]), status_before);

    // 换一个角色继续交接同一个不可变 tree，仍零拷贝。
    let receipt2 = coordinator
        .handoff(
            &mut workspace,
            SquadRole::Main,
            SquadRole::Reviewer,
            artifact.clone(),
        )
        .expect("second handoff");
    assert_eq!(
        workspace
            .resolve_ref(&receipt2.ref_name)
            .expect("resolve ref"),
        Some(artifact.oid().to_owned())
    );
    assert!(coordinator.history_len() >= 2);

    // 角色越权（审阅者直接向架构者派活）被拒绝。
    let err = coordinator
        .handoff(
            &mut workspace,
            SquadRole::Reviewer,
            SquadRole::Architect,
            artifact,
        )
        .expect_err("reviewer cannot assign work back to architect");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    cleanup(&dir);
}

#[test]
fn signed_agent_card_uses_rfc8785_jcs_and_ed25519_jws() {
    let identity = MlsIdentity::generate("a2a-card").expect("identity");
    let card = AgentCard {
        agent_id: AgentId::new_v4(),
        organisation: String::from("quetzalcoatl.example"),
        display_name: String::from("群组协调 Agent"),
        capabilities: vec![String::from("group.facilitate"), String::from("a2a.card")],
        public_key_hex: identity.public_key_hex(),
        issued_at_ms: 1_800_000_000_000,
        expires_at_ms: 1_800_000_600_000,
    };
    let signed = SignedAgentCard::sign(card.clone(), identity.signing_key()).expect("sign card");
    signed.verify().expect("signature verifies");
    let canonical = signed.canonical_payload().expect("canonical payload");
    assert!(canonical.starts_with('{'));
    assert!(
        canonical.find("\"agent_id\"").expect("agent_id")
            < canonical.find("\"capabilities\"").expect("capabilities")
    );
    assert!(
        !canonical.contains("display_name\": \"群组协调 Agent\""),
        "JCS must not ASCII-escape non-control UTF-8"
    );

    let mut tampered = signed.clone();
    tampered.card.display_name = String::from("冒名者");
    assert_eq!(
        tampered.verify().expect_err("tamper must fail").code(),
        ErrorCode::VerificationFailed
    );

    let jcs = jcs_canonicalize(&serde_json::json!({
        "b": 1,
        "a": {"z": true, "y": null},
        "unicode": "é",
        "esc": "line\nbreak"
    }))
    .expect("canonicalize");
    assert_eq!(
        jcs,
        "{\"a\":{\"y\":null,\"z\":true},\"b\":1,\"esc\":\"line\\nbreak\",\"unicode\":\"é\"}"
    );
}

#[test]
fn attenuated_mandate_never_exceeds_parent_and_escalation_requires_human_approval() {
    let issuer = MlsIdentity::generate("org-issuer").expect("issuer");
    let root_scope: std::collections::BTreeSet<String> = [
        String::from("calendar.read"),
        String::from("calendar.propose"),
        String::from("files.read:shared/*"),
    ]
    .into_iter()
    .collect();
    let root = AttenuatedMandate::root(
        AgentId::new_v4(),
        AgentId::new_v4(),
        root_scope.clone(),
        4,
        1_800_000_000_000,
        1_800_000_600_000,
        issuer.signing_key(),
    )
    .expect("root mandate");

    let narrowed: std::collections::BTreeSet<String> = [
        String::from("calendar.read"),
        String::from("calendar.propose"),
    ]
    .into_iter()
    .collect();
    let child = root
        .attenuate(
            MandateRequest {
                scope: narrowed.clone(),
                expires_at_ms: 1_800_000_300_000,
                max_hops: 2,
            },
            issuer.signing_key(),
        )
        .expect("attenuation within parent scope");
    assert!(child.verify(Some(&root)).is_ok());
    child
        .authorize("calendar.read", 1_800_000_100_000)
        .expect("narrowed scope allows read");
    assert_eq!(
        child
            .authorize("calendar.write", 1_800_000_100_000)
            .expect_err("out-of-scope action")
            .code(),
        ErrorCode::PermissionDenied
    );

    let escalation: std::collections::BTreeSet<String> = [
        String::from("calendar.read"),
        String::from("files.write:all/*"),
    ]
    .into_iter()
    .collect();
    let err = child
        .attenuate(
            MandateRequest {
                scope: escalation,
                expires_at_ms: 1_800_000_300_000,
                max_hops: 2,
            },
            issuer.signing_key(),
        )
        .expect_err("delegated mandate must never exceed parent");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    let ticket = AttenuatedMandate::escalation_ticket(&err).expect("escalation ticket");
    assert!(ticket.auth_required);
    assert!(ticket.ticket_id.starts_with("authreq-"));
    assert!(
        root.attenuate(
            MandateRequest {
                scope: narrowed,
                expires_at_ms: 1_800_001_000_000,
                max_hops: 1,
            },
            issuer.signing_key(),
        )
        .is_err(),
        "expiry cannot be extended past the parent"
    );
}

#[test]
fn hlc_style_untrusted_group_error_is_typed_not_stringly() {
    let err = QuetzalcoatlError::PermissionDenied {
        detail: String::from("D-19 shared role cannot join second trust domain"),
    };
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
}
