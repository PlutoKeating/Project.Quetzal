//! 要你拍板的事：交给后台做完、在洁净室里验收通过的改动，合进你的工作目录之前先等你一句话。
//!
//! 拍板的地方有三个：桌面通知上的两个键（Linux 上经 `notify-send --action`），终端里的
//! `qz approve`，以及治理面总览上的计数。没拍板之前，改动只在它自己的工作树里，你的目录一个字节都没动。
//! 守护进程重启后，没拍板的事作废（工作树随之删除），要做就再交一次。

use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use quetzalcoatl_harness::drivers::WorktreeLease;
use quetzalcoatl_types::{QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};

use crate::daemon::{SharedDaemonCore, now_unix_ms};

/// 一件等你拍板的事（给界面与命令行看的样子）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalView {
    pub id: String,
    /// 交给后台的那件事。
    pub task: String,
    /// 会改到你目录里的哪些文件。
    pub files: Vec<String>,
    pub created_ms: u64,
}

/// 拍板的结果。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalOutcome {
    pub id: String,
    pub approved: bool,
    /// 合进去的文件（不要时为空）。
    pub applied_files: Vec<String>,
}

struct PendingApply {
    view: ApprovalView,
    lease: WorktreeLease,
}

#[derive(Default)]
pub(crate) struct ApprovalQueue {
    items: Mutex<Vec<PendingApply>>,
}

impl ApprovalQueue {
    pub(crate) fn len(&self) -> usize {
        self.items.lock().map_or(0, |items| items.len())
    }
}

/// 有没有桌面通知可用：配置里打开了、有会话总线与 `notify-send`，且没有被环境变量关掉。
fn notifications_available(enabled: bool) -> bool {
    if !enabled || std::env::var("QUETZALCOATL_NOTIFY").is_ok_and(|v| v == "0") {
        return false;
    }
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return false;
    }
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| dir.join("notify-send").is_file())
    })
}

fn short(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        text.chars().take(max).collect::<String>() + "…"
    } else {
        String::from(text)
    }
}

impl SharedDaemonCore {
    /// 验收通过的改动先停在这里，等你拍板。返回编号与会改到的文件。
    pub(crate) fn hold_for_approval(
        self: &Arc<Self>,
        run_id: RunId,
        task: &str,
        lease: WorktreeLease,
    ) -> Result<(String, Vec<String>)> {
        let (files, _) = lease.capture_diff()?;
        let id = format!("a{}", &run_id.to_string()[..8]);
        let view = ApprovalView {
            id: id.clone(),
            task: short(task.trim(), 200),
            files: files.clone(),
            created_ms: now_unix_ms(),
        };
        {
            let mut items =
                self.approvals
                    .items
                    .lock()
                    .map_err(|_| QuetzalcoatlError::StorageError {
                        detail: String::from("拍板队列锁中毒"),
                    })?;
            items.push(PendingApply {
                view: view.clone(),
                lease,
            });
        }
        self.refresh_pending_count();
        if notifications_available(self.config.desktop_notifications) {
            let weak = Arc::downgrade(self);
            let notice_id = id.clone();
            let _ = std::thread::Builder::new()
                .name(String::from("quetzalcoatl-approval"))
                .spawn(move || ask_on_desktop(&weak, &notice_id, &view));
        }
        Ok((id, files))
    }

    pub(crate) fn pending_approvals(&self) -> Vec<ApprovalView> {
        self.approvals.items.lock().map_or_else(
            |_| Vec::new(),
            |items| items.iter().map(|item| item.view.clone()).collect(),
        )
    }

    /// 拍板：同意就把改动合进你的目录，不要就连工作树一起删掉。
    pub(crate) fn decide_approval(&self, id: &str, approve: bool) -> Result<ApprovalOutcome> {
        let item = {
            let mut items =
                self.approvals
                    .items
                    .lock()
                    .map_err(|_| QuetzalcoatlError::StorageError {
                        detail: String::from("拍板队列锁中毒"),
                    })?;
            let Some(index) = items.iter().position(|item| item.view.id == id) else {
                return Err(QuetzalcoatlError::invalid_id(
                    "ApprovalId",
                    format!("没有等你拍板的 {id}（可能已经拍过板，或者守护进程重启过）"),
                ));
            };
            items.remove(index)
        };
        self.refresh_pending_count();
        let applied_files = if approve {
            let applied = item.lease.apply_verified_to_repo();
            let _ = item.lease.cleanup();
            applied?
        } else {
            item.lease.cleanup()?;
            Vec::new()
        };
        Ok(ApprovalOutcome {
            id: String::from(id),
            approved: approve,
            applied_files,
        })
    }

    fn refresh_pending_count(&self) {
        self.host_sessions
            .pending_approvals
            .store(self.approvals.len(), Ordering::Relaxed);
    }
}

/// 桌面通知上两个键；点了哪个就照办，关掉通知就留着等别处拍板。
fn ask_on_desktop(core: &std::sync::Weak<SharedDaemonCore>, id: &str, view: &ApprovalView) {
    let body = format!(
        "{}\n改了 {} 个文件，洁净室验收通过。合进你的目录吗？",
        view.task,
        view.files.len()
    );
    let Ok(output) = Command::new("notify-send")
        .args([
            "--app-name=Quetzalcoatl",
            "--urgency=normal",
            "--action=approve=合进去",
            "--action=deny=不要",
            "委托的事做完了",
            &body,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return;
    };
    let choice = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let approve = match choice.as_str() {
        "approve" => true,
        "deny" => false,
        _ => return,
    };
    if let Some(core) = core.upgrade() {
        let _ = core.decide_approval(id, approve);
    }
}
