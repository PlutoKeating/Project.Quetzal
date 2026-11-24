//! 单用户异构专长编队（Topology ③，Pitfall #22）：共享只读良知快照，
//! 通过 `refs/qz/squad/<id>/<role>` 下的不可变 Git tree 引用零拷贝交接未提交工作，
//! 绝不修改目标仓库工作树。

use std::path::{Path, PathBuf};
use std::process::Command;

use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

fn git_error(context: &str, err: impl std::fmt::Display) -> QuetzalcoatlError {
    QuetzalcoatlError::StorageError {
        detail: format!("{context}: {err}"),
    }
}

/// 编队角色。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SquadRole {
    Architect,
    Main,
    Reviewer,
}

impl SquadRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Architect => "architect",
            Self::Main => "main",
            Self::Reviewer => "reviewer",
        }
    }

    const fn rank(self) -> u8 {
        match self {
            Self::Architect => 0,
            Self::Main => 1,
            Self::Reviewer => 2,
        }
    }
}

/// 编队成员（异构 harness 绑定）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadMember {
    pub role: SquadRole,
    pub harness: String,
    pub agent_id: AgentId,
}

impl SquadMember {
    #[must_use]
    pub fn new(role: SquadRole, harness: impl Into<String>, agent_id: AgentId) -> Self {
        Self {
            role,
            harness: harness.into(),
            agent_id,
        }
    }
}

/// 不可变产物引用：仅允许 Git tree（拒绝可变工作树路径）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "oid", rename_all = "snake_case")]
pub enum ArtifactRef {
    GitTree(String),
}

impl ArtifactRef {
    #[must_use]
    pub fn oid(&self) -> &str {
        match self {
            Self::GitTree(oid) => oid,
        }
    }

    fn validate(&self) -> Result<()> {
        let oid = self.oid();
        let valid = (oid.len() == 40 || oid.len() == 64)
            && oid.bytes().all(|byte| byte.is_ascii_hexdigit());
        if !valid {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!("ArtifactRef 不是合法不可变 Git tree OID: {oid}"),
            });
        }
        Ok(())
    }
}

/// 交接回执。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffReceipt {
    pub squad_id: String,
    pub from: SquadRole,
    pub to: SquadRole,
    pub artifact: ArtifactRef,
    pub ref_name: String,
    pub conscience_digest: [u8; 32],
}

/// 编队工作区抽象（真实实现为 `git` CLI；测试可注入内存实现）。
pub trait SquadWorkspace {
    fn capture_uncommitted_tree(&mut self) -> Result<ArtifactRef>;
    fn publish_tree_ref(&mut self, ref_name: &str, oid: &str) -> Result<()>;
    fn resolve_ref(&self, ref_name: &str) -> Result<Option<String>>;
    fn read_blob(&self, artifact: &ArtifactRef, path: &str) -> Result<String>;
}

/// 异构编队协调器：只读良知快照 + 单向角色交接。
#[derive(Clone, Debug)]
pub struct HeterogeneousSquadCoordinator {
    squad_id: String,
    members: Vec<SquadMember>,
    conscience_digest: [u8; 32],
    history: Vec<HandoffReceipt>,
}

impl HeterogeneousSquadCoordinator {
    pub fn new(
        squad_id: impl Into<String>,
        members: Vec<SquadMember>,
        conscience_digest: [u8; 32],
    ) -> Result<Self> {
        let squad_id = squad_id.into();
        if squad_id.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "HeterogeneousSquadCoordinator",
                "编队 ID 不能为空",
            ));
        }
        for role in [SquadRole::Architect, SquadRole::Main, SquadRole::Reviewer] {
            let count = members.iter().filter(|member| member.role == role).count();
            if count != 1 {
                return Err(QuetzalcoatlError::invalid_id(
                    "HeterogeneousSquadCoordinator",
                    format!("角色 {} 必须恰好一个成员", role.as_str()),
                ));
            }
        }
        Ok(Self {
            squad_id,
            members,
            conscience_digest,
            history: Vec::new(),
        })
    }

    #[must_use]
    pub fn conscience_digest(&self) -> [u8; 32] {
        self.conscience_digest
    }

    #[must_use]
    pub fn members(&self) -> &[SquadMember] {
        &self.members
    }

    #[must_use]
    pub fn history_len(&self) -> usize {
        self.history.len()
    }

    #[must_use]
    pub fn ref_name_for(&self, role: SquadRole) -> String {
        format!(
            "refs/qz/squad/{}/{role}",
            self.squad_id,
            role = role.as_str()
        )
    }

    /// 将不可变产物从一个角色交接给下一个角色；只发布 ref，不触碰工作树。
    pub fn handoff(
        &mut self,
        workspace: &mut dyn SquadWorkspace,
        from: SquadRole,
        to: SquadRole,
        artifact: ArtifactRef,
    ) -> Result<HandoffReceipt> {
        artifact.validate()?;
        if from == to {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("编队交接不得指向同一角色"),
            });
        }
        if to.rank() <= from.rank() {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "编队交接只能沿架构 → 主程 → 审阅方向推进，拒绝 {} → {}",
                    from.as_str(),
                    to.as_str()
                ),
            });
        }
        for role in [from, to] {
            if !self.members.iter().any(|member| member.role == role) {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: format!("编队缺少角色 {}", role.as_str()),
                });
            }
        }
        let ref_name = self.ref_name_for(to);
        workspace.publish_tree_ref(&ref_name, artifact.oid())?;
        let receipt = HandoffReceipt {
            squad_id: self.squad_id.clone(),
            from,
            to,
            artifact,
            ref_name,
            conscience_digest: self.conscience_digest,
        };
        self.history.push(receipt.clone());
        Ok(receipt)
    }
}

/// 基于 `git` CLI 的零拷贝工作区实现。
#[derive(Clone, Debug)]
pub struct GitCliSquadWorkspace {
    repo_root: PathBuf,
}

impl GitCliSquadWorkspace {
    pub fn open(repo_root: &Path) -> Result<Self> {
        let workspace = Self {
            repo_root: repo_root.to_path_buf(),
        };
        workspace.run(&["rev-parse", "--git-dir"])?;
        Ok(workspace)
    }

    fn run(&self, args: &[&str]) -> Result<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.repo_root)
            .output()
            .map_err(|err| git_error("启动 git 失败", err))?;
        if !output.status.success() {
            return Err(git_error(
                "git 命令失败",
                String::from_utf8_lossy(&output.stderr),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    fn run_raw(&self, args: &[&str]) -> Result<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.repo_root)
            .output()
            .map_err(|err| git_error("启动 git 失败", err))?;
        if !output.status.success() {
            return Err(git_error(
                "git 命令失败",
                String::from_utf8_lossy(&output.stderr),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn try_run(&self, args: &[&str]) -> Result<Option<String>> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.repo_root)
            .output()
            .map_err(|err| git_error("启动 git 失败", err))?;
        if !output.status.success() {
            return Ok(None);
        }
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    }
}

impl SquadWorkspace for GitCliSquadWorkspace {
    /// 使用 `git stash create` 生成包含未提交修改的临时提交，再取其 tree OID。
    /// 该操作只写对象库，不修改工作树与索引。
    fn capture_uncommitted_tree(&mut self) -> Result<ArtifactRef> {
        let stash_commit = self.try_run(&["stash", "create"])?;
        let commit_oid = match stash_commit {
            Some(oid) if !oid.is_empty() => oid,
            _ => self.run(&["rev-parse", "HEAD"])?,
        };
        let tree_oid = self.run(&["rev-parse", &format!("{commit_oid}^{{tree}}")])?;
        Ok(ArtifactRef::GitTree(tree_oid))
    }

    fn publish_tree_ref(&mut self, ref_name: &str, oid: &str) -> Result<()> {
        if !ref_name.starts_with("refs/qz/squad/") {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("编队 ref 必须位于 refs/qz/squad/ 命名空间: {ref_name}"),
            });
        }
        ArtifactRef::GitTree(oid.to_owned()).validate()?;
        self.run(&["update-ref", ref_name, oid])?;
        Ok(())
    }

    fn resolve_ref(&self, ref_name: &str) -> Result<Option<String>> {
        if !ref_name.starts_with("refs/qz/squad/") {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("只允许解析 refs/qz/squad/ 命名空间: {ref_name}"),
            });
        }
        self.try_run(&["rev-parse", "--verify", ref_name])
    }

    fn read_blob(&self, artifact: &ArtifactRef, path: &str) -> Result<String> {
        artifact.validate()?;
        if path.trim().is_empty() || path.contains("..") {
            return Err(QuetzalcoatlError::invalid_id(
                "GitCliSquadWorkspace",
                "非法 blob 路径",
            ));
        }
        self.run_raw(&["show", &format!("{}:{path}", artifact.oid())])
    }
}
