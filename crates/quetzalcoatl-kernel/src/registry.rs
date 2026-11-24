#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 盲内核接口注册表、汇点分级、沙箱本地自演化技能描述符与工作区内容寻址树摘要。

use std::collections::BTreeMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

use quetzalcoatl_sandbox::PROTECTED_WORKSPACE_SUBPATHS;
use quetzalcoatl_types::{ArtifactId, QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};

const BLOB_HASH_DOMAIN: &str = "quetzalcoatl/v2/kernel-artifact-blob-v1";
const SYMLINK_HASH_DOMAIN: &str = "quetzalcoatl/v2/kernel-artifact-symlink-v1";
const WORKSPACE_TREE_DOMAIN: &str = "quetzalcoatl/v2/kernel-workspace-tree-v1";
const EVOLVED_SKILL_DOMAIN: &str = "quetzalcoatl/v2/kernel-evolved-skill-v1";

/// 由内核能力注册表决定的确定性能力汇点（Sink）分类，绝不采信模型自述标签。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SinkClass {
    LocalRead,
    SandboxSelfEvolution,
    RoutineResponse,
    CodeRepositoryMutation,
    HighRiskExternalWrite,
    EmergencyLocalAlert,
}

impl SinkClass {
    /// 判断该汇点在 `Commit Run` 结项前是否必须通过断网只读洁净室校验器。
    #[must_use]
    pub const fn requires_clean_room_verifier(self) -> bool {
        matches!(
            self,
            Self::CodeRepositoryMutation | Self::HighRiskExternalWrite
        )
    }
}

/// 能力执行表面分类（用于架构级剥夺 `Router` 的终端与改文件能力）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionSurface {
    PureMetadata,
    ThreadVoice,
    SandboxShell,
    SandboxFileWrite,
    ExternalChannel,
}

/// 能力注册来源。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CapabilityOrigin {
    HostRegistered,
    SandboxEvolved {
        run_id: RunId,
        script_blake3: ArtifactId,
        relative_script_path: PathBuf,
        interpreter: String,
    },
}

/// 盲内核能力描述符（不含任何具体模型供应商或外部业务 SDK 语义）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityDescriptor {
    pub capability_id: String,
    pub interface_id: String,
    pub sink_class: SinkClass,
    pub surface: ExecutionSurface,
    pub idempotent: bool,
    pub origin: CapabilityOrigin,
}

/// 沙箱内即时合成技能注册请求。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvolvedSkillSpec {
    pub skill_id: String,
    pub interface_id: String,
    pub relative_script_path: PathBuf,
    pub interpreter: String,
    pub description: String,
}

/// 已注册并计算内容哈希锁定的沙箱本地自演化技能描述符。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvolvedSkillDescriptor {
    pub skill_id: String,
    pub run_id: RunId,
    pub relative_script_path: PathBuf,
    pub interpreter: String,
    pub description: String,
    pub script_blake3: ArtifactId,
}

/// 跨任务/跨编队只读交接产物引用。
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ArtifactRef {
    WorkspaceTree(ArtifactId),
    GitTree(String),
    Blob(ArtifactId),
}

/// 工作区清单条目类型。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtifactEntryKind {
    Directory,
    RegularFile { executable: bool },
    Symlink,
}

/// 工作区内容寻址清单单条记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactEntry {
    pub rel_path: String,
    pub kind: ArtifactEntryKind,
    pub size_bytes: u64,
    pub content_blake3: ArtifactId,
}

/// 规范化工作区树内容寻址清单。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactManifest {
    pub tree_blake3: ArtifactId,
    pub entries: Vec<ArtifactEntry>,
}

fn is_executable_metadata(meta: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        (meta.permissions().mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}

fn walk_workspace_dir(
    current_dir: &Path,
    rel_prefix: &str,
    entries_out: &mut Vec<ArtifactEntry>,
) -> Result<()> {
    let read_dir = fs::read_dir(current_dir).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("遍历工作区目录失败 ({}): {e}", current_dir.display()),
    })?;

    let mut dir_children = Vec::<(String, PathBuf, fs::FileType)>::new();
    for item_res in read_dir {
        let item = item_res.map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取目录项失败 ({}): {e}", current_dir.display()),
        })?;
        let name_os = item.file_name();
        let name = name_os
            .to_str()
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: format!("工作区包含非 UTF-8 文件名 ({})", item.path().display()),
            })?
            .to_owned();

        // 排除版本控制内部元数据目录/工作树指针文件 `.git`
        if name == ".git" {
            continue;
        }

        let ftype = item
            .file_type()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取目录项文件类型失败 ({}): {e}", item.path().display()),
            })?;
        dir_children.push((name, item.path(), ftype));
    }

    dir_children.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, full_path, ftype) in dir_children {
        let rel_path = if rel_prefix.is_empty() {
            name
        } else {
            format!("{rel_prefix}/{name}")
        };

        if ftype.is_symlink() {
            let link_target =
                fs::read_link(&full_path).map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("读取符号链接字面路径失败 ({}): {e}", full_path.display()),
                })?;
            let target_str =
                link_target
                    .to_str()
                    .ok_or_else(|| QuetzalcoatlError::SerializationError {
                        detail: format!("符号链接目标包含非 UTF-8 字节 ({})", full_path.display()),
                    })?;
            let mut hasher = blake3::Hasher::new_derive_key(SYMLINK_HASH_DOMAIN);
            hasher.update(target_str.as_bytes());
            let digest = ArtifactId::from_bytes(*hasher.finalize().as_bytes());
            entries_out.push(ArtifactEntry {
                rel_path,
                kind: ArtifactEntryKind::Symlink,
                size_bytes: target_str.len() as u64,
                content_blake3: digest,
            });
        } else if ftype.is_dir() {
            entries_out.push(ArtifactEntry {
                rel_path: rel_path.clone(),
                kind: ArtifactEntryKind::Directory,
                size_bytes: 0,
                content_blake3: ArtifactId::ZERO,
            });
            walk_workspace_dir(&full_path, &rel_path, entries_out)?;
        } else if ftype.is_file() {
            let meta =
                fs::symlink_metadata(&full_path).map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("读取工作区文件元数据失败 ({}): {e}", full_path.display()),
                })?;
            let bytes = fs::read(&full_path).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取工作区文件内容失败 ({}): {e}", full_path.display()),
            })?;
            let mut hasher = blake3::Hasher::new_derive_key(BLOB_HASH_DOMAIN);
            hasher.update(&bytes);
            let digest = ArtifactId::from_bytes(*hasher.finalize().as_bytes());
            entries_out.push(ArtifactEntry {
                rel_path,
                kind: ArtifactEntryKind::RegularFile {
                    executable: is_executable_metadata(&meta),
                },
                size_bytes: bytes.len() as u64,
                content_blake3: digest,
            });
        }
    }

    Ok(())
}

/// 计算工作区规范化内容寻址清单（排除 `.git` 且绝不解引用跟随符号链接）。
pub fn compute_workspace_tree_manifest(workspace_dir: &Path) -> Result<ArtifactManifest> {
    let root_meta =
        fs::symlink_metadata(workspace_dir).map_err(|e| QuetzalcoatlError::SandboxViolation {
            detail: format!(
                "工作区目录不存在或不可访问 ({}): {e}",
                workspace_dir.display()
            ),
        })?;
    if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!(
                "工作区根路径必须为真实目录且严禁为符号链接: {}",
                workspace_dir.display()
            ),
        });
    }

    let mut entries = Vec::<ArtifactEntry>::new();
    walk_workspace_dir(workspace_dir, "", &mut entries)?;
    entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let mut tree_hasher = blake3::Hasher::new_derive_key(WORKSPACE_TREE_DOMAIN);
    tree_hasher.update(&(entries.len() as u64).to_be_bytes());
    for entry in &entries {
        let path_bytes = entry.rel_path.as_bytes();
        tree_hasher.update(&(path_bytes.len() as u64).to_be_bytes());
        tree_hasher.update(path_bytes);
        let kind_tag: u8 = match entry.kind {
            ArtifactEntryKind::Directory => 0,
            ArtifactEntryKind::RegularFile { executable: false } => 1,
            ArtifactEntryKind::RegularFile { executable: true } => 2,
            ArtifactEntryKind::Symlink => 3,
        };
        tree_hasher.update(&[kind_tag]);
        tree_hasher.update(&entry.size_bytes.to_be_bytes());
        tree_hasher.update(entry.content_blake3.as_bytes());
    }
    let tree_blake3 = ArtifactId::from_bytes(*tree_hasher.finalize().as_bytes());

    Ok(ArtifactManifest {
        tree_blake3,
        entries,
    })
}

/// 计算工作区规范化 `BLAKE3` 树摘要。
pub fn compute_workspace_tree_blake3(workspace_dir: &Path) -> Result<ArtifactId> {
    compute_workspace_tree_manifest(workspace_dir).map(|m| m.tree_blake3)
}

/// 校验自演化技能脚本路径严格限制在沙箱工作区内部、非受保护目录且不含符号链接。
pub(crate) fn validate_and_hash_evolved_skill_script(
    workspace_dir: &Path,
    relative_script_path: &Path,
) -> Result<(PathBuf, ArtifactId)> {
    if relative_script_path.as_os_str().is_empty() || relative_script_path.is_absolute() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!(
                "自演化技能脚本必须使用非空相对路径: {}",
                relative_script_path.display()
            ),
        });
    }

    let mut normalized_parts = Vec::<String>::new();
    for comp in relative_script_path.components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg
                    .to_str()
                    .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                        detail: String::from("自演化技能脚本路径包含非 UTF-8 片段"),
                    })?;
                if s.is_empty() || s.contains('\0') {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: String::from("自演化技能脚本路径包含空片段或 NUL 字节"),
                    });
                }
                normalized_parts.push(s.to_owned());
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!(
                        "自演化技能脚本路径严禁包含目录穿越或根前缀: {}",
                        relative_script_path.display()
                    ),
                });
            }
        }
    }

    let normalized_rel = normalized_parts.join("/");
    if normalized_rel == ".git" || normalized_rel.starts_with(".git/") {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: String::from("严禁在版本控制目录内注册自演化技能脚本"),
        });
    }
    for protected in PROTECTED_WORKSPACE_SUBPATHS {
        if normalized_rel == *protected || normalized_rel.starts_with(&format!("{protected}/")) {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!(
                    "严禁在受保护配置/钩子子路径内注册自演化技能脚本: {normalized_rel}"
                ),
            });
        }
    }

    let ws_meta =
        fs::symlink_metadata(workspace_dir).map_err(|e| QuetzalcoatlError::SandboxViolation {
            detail: format!("读取沙箱工作区失败 ({}): {e}", workspace_dir.display()),
        })?;
    if ws_meta.file_type().is_symlink() || !ws_meta.is_dir() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: String::from("沙箱工作区根路径必须为非符号链接目录"),
        });
    }

    let mut cursor = workspace_dir.to_path_buf();
    for (idx, seg) in normalized_parts.iter().enumerate() {
        cursor.push(seg);
        let meta =
            fs::symlink_metadata(&cursor).map_err(|e| QuetzalcoatlError::SandboxViolation {
                detail: format!("自演化技能脚本路径不可访问 ({}): {e}", cursor.display()),
            })?;
        if meta.file_type().is_symlink() {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("自演化技能脚本路径禁止包含符号链接: {}", cursor.display()),
            });
        }
        let is_last = idx + 1 == normalized_parts.len();
        if is_last && !meta.is_file() {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("自演化技能脚本目标必须为普通文件: {}", cursor.display()),
            });
        }
        if !is_last && !meta.is_dir() {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("自演化技能脚本中间路径必须为目录: {}", cursor.display()),
            });
        }
    }

    let script_bytes = fs::read(&cursor).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("读取自演化技能脚本失败 ({}): {e}", cursor.display()),
    })?;
    let mut hasher = blake3::Hasher::new_derive_key(EVOLVED_SKILL_DOMAIN);
    hasher.update(&script_bytes);
    let script_blake3 = ArtifactId::from_bytes(*hasher.finalize().as_bytes());
    Ok((cursor, script_blake3))
}

/// 盲内核接口与能力注册表。
#[derive(Clone, Debug, Default)]
pub struct InterfaceRegistry {
    capabilities: BTreeMap<String, CapabilityDescriptor>,
    evolved_skills: BTreeMap<String, EvolvedSkillDescriptor>,
}

impl InterfaceRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_host_capability(&mut self, descriptor: CapabilityDescriptor) -> Result<()> {
        if descriptor.capability_id.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "capability_id",
                "能力标识符不能为空",
            ));
        }
        if descriptor.interface_id.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "interface_id",
                "接口组标识符不能为空",
            ));
        }
        if matches!(descriptor.origin, CapabilityOrigin::SandboxEvolved { .. }) {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("宿主能力注册入口禁止伪造 SandboxEvolved 来源"),
            });
        }
        self.capabilities
            .insert(descriptor.capability_id.clone(), descriptor);
        Ok(())
    }

    pub fn register_evolved_skill(
        &mut self,
        run_id: RunId,
        workspace_dir: &Path,
        spec: EvolvedSkillSpec,
    ) -> Result<EvolvedSkillDescriptor> {
        if spec.skill_id.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "skill_id",
                "自演化技能标识符不能为空",
            ));
        }
        if spec.interface_id.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "interface_id",
                "自演化技能接口组不能为空",
            ));
        }
        if spec.interpreter.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "interpreter",
                "自演化技能解释器路径不能为空",
            ));
        }
        if let Some(existing) = self.capabilities.get(&spec.skill_id)
            && matches!(existing.origin, CapabilityOrigin::HostRegistered)
        {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("禁止自演化技能覆盖宿主已注册的固定能力 `{}`", spec.skill_id),
            });
        }

        let (_, script_blake3) =
            validate_and_hash_evolved_skill_script(workspace_dir, &spec.relative_script_path)?;

        let evolved = EvolvedSkillDescriptor {
            skill_id: spec.skill_id.clone(),
            run_id,
            relative_script_path: spec.relative_script_path.clone(),
            interpreter: spec.interpreter.clone(),
            description: spec.description,
            script_blake3,
        };

        // 自演化技能强制锁定为 SandboxSelfEvolution 汇点，绝不可自行提升至外部写或仓库提交等级
        let cap_desc = CapabilityDescriptor {
            capability_id: spec.skill_id.clone(),
            interface_id: spec.interface_id,
            sink_class: SinkClass::SandboxSelfEvolution,
            surface: ExecutionSurface::SandboxShell,
            idempotent: false,
            origin: CapabilityOrigin::SandboxEvolved {
                run_id,
                script_blake3,
                relative_script_path: spec.relative_script_path,
                interpreter: spec.interpreter,
            },
        };

        self.capabilities.insert(spec.skill_id.clone(), cap_desc);
        self.evolved_skills.insert(spec.skill_id, evolved.clone());
        Ok(evolved)
    }

    /// 重水合恢复已持久化的自演化技能注册项。
    pub(crate) fn restore_evolved_skill(&mut self, skill: EvolvedSkillDescriptor) {
        let cap_desc = CapabilityDescriptor {
            capability_id: skill.skill_id.clone(),
            interface_id: String::from("sandbox.evolved"),
            sink_class: SinkClass::SandboxSelfEvolution,
            surface: ExecutionSurface::SandboxShell,
            idempotent: false,
            origin: CapabilityOrigin::SandboxEvolved {
                run_id: skill.run_id,
                script_blake3: skill.script_blake3,
                relative_script_path: skill.relative_script_path.clone(),
                interpreter: skill.interpreter.clone(),
            },
        };
        self.capabilities.insert(skill.skill_id.clone(), cap_desc);
        self.evolved_skills.insert(skill.skill_id.clone(), skill);
    }

    #[must_use]
    pub fn get_capability(&self, capability_id: &str) -> Option<&CapabilityDescriptor> {
        self.capabilities.get(capability_id)
    }

    #[must_use]
    pub fn get_evolved_skill(&self, skill_id: &str) -> Option<&EvolvedSkillDescriptor> {
        self.evolved_skills.get(skill_id)
    }

    #[must_use]
    pub fn list_capabilities(&self) -> Vec<&CapabilityDescriptor> {
        self.capabilities.values().collect()
    }

    pub fn resolve_authoritative_sink(&self, capability_id: &str) -> Result<SinkClass> {
        self.capabilities
            .get(capability_id)
            .map(|c| c.sink_class)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!("未注册的能力标识符 `{capability_id}`"),
            })
    }
}
