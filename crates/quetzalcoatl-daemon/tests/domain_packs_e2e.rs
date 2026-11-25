#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Task 3.4 端到端：`IpcRequest::Domain*`（`qz domain list|show|use`）在真实 `quetzalcoatld` 上的行为。

mod common;

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_daemon::{
    DaemonConfig, DomainPackSummary, IpcClient, IpcRequest, IpcResponse, QuetzalcoatlDaemon,
};
use quetzalcoatl_domains::PackSwitchOutcome;

type TestResult = Result<(), Box<dyn Error>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let path = common::temp_root(prefix)?;
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

fn expect_packs(response: IpcResponse) -> Result<Vec<DomainPackSummary>, Box<dyn Error>> {
    match response {
        IpcResponse::DomainPacks { packs, .. } => Ok(packs),
        other => Err(format!("期望 DomainPacks，实际为 {other:?}").into()),
    }
}

#[test]
fn domain_ipc_defaults_to_personal_companion_switches_with_audit_and_persists_across_restart()
-> TestResult {
    let tmp = TempDirGuard::new("qz_domain_ipc")?;
    let qz_home = tmp.path().join("home");

    let mut daemon = QuetzalcoatlDaemon::start(DaemonConfig::new(qz_home.clone()))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());

    // 1. 默认域：五大领域包齐备，活动包为 personal-companion，且不需要任何显式配置
    let rows = expect_packs(client.call(&IpcRequest::DomainList)?)?;
    assert_eq!(rows.len(), 5, "首次启动必须装载五大首发领域包");
    let active: Vec<&str> = rows
        .iter()
        .filter(|r| r.active)
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(active, vec!["personal-companion"]);
    assert!(
        rows.iter()
            .all(|r| !r.guardian_label.trim().is_empty() && !r.verifier_rule_kinds.is_empty())
    );

    // 2. show：返回种子良知、校验规则与监护人信封摘要
    match client.call(&IpcRequest::DomainShow {
        id: String::from("eldercare-guardian"),
    })? {
        IpcResponse::DomainPack(view) => {
            assert_eq!(view.summary.id, "eldercare-guardian");
            assert!(view.envelope.emergency.enabled);
            assert!(view.envelope.emergency.bypass_sleep_inhibition);
            assert!(view.envelope.emergency.allow_local_alert_under_partition);
            assert!(!view.envelope.immutable_fields.is_empty());
            assert!(
                view.conscience_seed
                    .entries
                    .iter()
                    .any(|e| e.tier.as_str() == "ROOT")
            );
        }
        other => return Err(format!("期望 DomainPack，实际为 {other:?}").into()),
    }

    // 3. use：切换并返回审计回执（from -> to + 监护人标签 + actor）
    match client.call(&IpcRequest::DomainUse {
        id: String::from("eldercare-guardian"),
    })? {
        IpcResponse::DomainActivated(outcome) => match outcome.as_ref() {
            PackSwitchOutcome::Activated(audit) => {
                assert_eq!(audit.from_pack_id, "personal-companion");
                assert_eq!(audit.to_pack_id, "eldercare-guardian");
                assert!(audit.guardian_label.starts_with("guardian:"));
                assert!(audit.at_ms > 0);
                assert!(!audit.actor.is_empty());
            }
            other => {
                return Err(format!("期望 Activated 审计，实际为 {other:?}").into());
            }
        },
        other => return Err(format!("期望 DomainActivated，实际为 {other:?}").into()),
    }
    // 3b. 重复切换到同一领域包必须是幂等空操作（不重复签发审计）
    match client.call(&IpcRequest::DomainUse {
        id: String::from("eldercare-guardian"),
    })? {
        IpcResponse::DomainActivated(outcome) => match outcome.as_ref() {
            PackSwitchOutcome::Unchanged { active_pack_id } => {
                assert_eq!(active_pack_id, "eldercare-guardian");
            }
            other => {
                return Err(format!("期望 Unchanged 空操作，实际为 {other:?}").into());
            }
        },
        other => return Err(format!("期望 DomainActivated，实际为 {other:?}").into()),
    }
    let rows = expect_packs(client.call(&IpcRequest::DomainList)?)?;
    assert_eq!(
        rows.iter()
            .filter(|r| r.active)
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        vec!["eldercare-guardian"]
    );

    // 4. 未知领域包：类型化错误，不改变活动包
    match client.call(&IpcRequest::DomainUse {
        id: String::from("non-existent-domain"),
    })? {
        IpcResponse::Error { code, .. } => assert_eq!(code, "INVALID_ID"),
        other => return Err(format!("未知领域包必须返回 INVALID_ID，实际为 {other:?}").into()),
    }
    match client.call(&IpcRequest::DomainShow {
        id: String::from("non-existent-domain"),
    })? {
        IpcResponse::Error { code, .. } => assert_eq!(code, "INVALID_ID"),
        other => {
            return Err(format!("未知领域包 show 必须返回 INVALID_ID，实际为 {other:?}").into());
        }
    }

    // 5. 活动绑定与审计必须跨守护进程重启持久化
    let state_path = qz_home.join("domains/active.json");
    let persisted = fs::read_to_string(&state_path)?;
    assert!(persisted.contains("eldercare-guardian"));
    daemon.shutdown()?;

    let mut restarted = QuetzalcoatlDaemon::start(DaemonConfig::new(qz_home.clone()))?;
    let client =
        IpcClient::from_runtime_info(restarted.runtime_info(), restarted.ipc_token().to_owned());
    let rows = expect_packs(client.call(&IpcRequest::DomainList)?)?;
    assert_eq!(
        rows.iter()
            .filter(|r| r.active)
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        vec!["eldercare-guardian"],
        "重启后必须恢复该 Agent 的领域包绑定"
    );
    restarted.shutdown()?;

    Ok(())
}
