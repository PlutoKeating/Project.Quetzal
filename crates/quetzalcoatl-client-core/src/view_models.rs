#![forbid(unsafe_code)]

//! 三档认知密度（`Companion` / `Workbench` / `Inspector`）的响应式**差分**视图模型。
//!
//! 客户端从不接收整棵状态树：守护进程只推送 [`ViewPatch`]，客户端按 `from_rev → to_rev`
//! 幂等重放即可重建与源端逐字节一致的 [`ViewState`] 快照。同一补丁可安全重发
//! （网络抖动、断线重连、双端并发拉取都不会造成状态漂移），而乱序补丁被显式拒绝。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 三档认知密度：同一份状态在三种界面语境下的披露层级。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CognitionDensity {
    /// 陪伴态：长辈/移动端随身场景，只披露一句话摘要。
    Companion,
    /// 工作台态：桌面默认，披露摘要与可操作细节。
    #[default]
    Workbench,
    /// 检视态：开发者/审计场景，披露全部原始载荷。
    Inspector,
}

/// 视图行的三个披露层级。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetailLayer {
    Summary,
    Detail,
    Raw,
}

impl CognitionDensity {
    /// 该密度允许披露的层级（严格嵌套：Companion ⊂ Workbench ⊂ Inspector）。
    #[must_use]
    pub const fn layers(self) -> &'static [DetailLayer] {
        match self {
            Self::Companion => &[DetailLayer::Summary],
            Self::Workbench => &[DetailLayer::Summary, DetailLayer::Detail],
            Self::Inspector => &[DetailLayer::Summary, DetailLayer::Detail, DetailLayer::Raw],
        }
    }

    #[must_use]
    pub const fn includes(self, layer: DetailLayer) -> bool {
        match layer {
            DetailLayer::Summary => true,
            DetailLayer::Detail => matches!(self, Self::Workbench | Self::Inspector),
            DetailLayer::Raw => matches!(self, Self::Inspector),
        }
    }

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Companion => "companion",
            Self::Workbench => "workbench",
            Self::Inspector => "inspector",
        }
    }

    #[must_use]
    pub const fn next(self) -> Self {
        match self {
            Self::Companion => Self::Workbench,
            Self::Workbench => Self::Inspector,
            Self::Inspector => Self::Companion,
        }
    }
}

/// 视图中的一行状态（由 key 唯一标识，天然去重）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewRow {
    pub key: String,
    pub kind: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_json: Option<String>,
    pub updated_rev: u64,
}

impl ViewRow {
    #[must_use]
    pub fn new(
        key: impl Into<String>,
        kind: impl Into<String>,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            key: key.into(),
            kind: kind.into(),
            summary: summary.into(),
            detail: None,
            raw_json: None,
            updated_rev: 0,
        }
    }

    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    #[must_use]
    pub fn with_raw_json(mut self, raw_json: impl Into<String>) -> Self {
        self.raw_json = Some(raw_json.into());
        self
    }

    #[must_use]
    pub const fn with_updated_rev(mut self, rev: u64) -> Self {
        self.updated_rev = rev;
        self
    }
}

/// 差分操作：按 key 幂等上插或删除。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ViewOp {
    Upsert { row: ViewRow },
    Remove { key: String },
}

/// 一次响应式更新：携带修订区间与操作集。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewPatch {
    pub from_rev: u64,
    pub to_rev: u64,
    pub density: CognitionDensity,
    pub ops: Vec<ViewOp>,
}

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum PatchError {
    #[error("视图补丁序裂: 本地 rev={expected}, 补丁 from_rev={actual}")]
    OutOfSequence { expected: u64, actual: u64 },

    #[error("视图补丁修订区间非法: from_rev={from_rev}, to_rev={to_rev}")]
    InvalidRevision { from_rev: u64, to_rev: u64 },

    #[error("视图补丁操作非法: {detail}")]
    MalformedOp { detail: String },
}

/// 客户端当前持有的完整视图快照；可由若干 [`ViewPatch`] 从任意基线确定性重放得到。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewState {
    pub rev: u64,
    pub density: CognitionDensity,
    /// `BTreeMap` 保证序列化与投影顺序完全确定（不依赖哈希种子）。
    pub rows: BTreeMap<String, ViewRow>,
}

/// 按指定密度裁剪后的行（不含被隐藏层级的字段）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectedRow {
    pub key: String,
    pub kind: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_json: Option<String>,
}

impl ViewState {
    #[must_use]
    pub const fn empty(rev: u64, density: CognitionDensity) -> Self {
        Self {
            rev,
            density,
            rows: BTreeMap::new(),
        }
    }

    /// 幂等应用一个补丁。
    ///
    /// - `to_rev` 等于本地 `rev`：说明补丁已应用过，直接 `Ok(())`（可安全重发）。
    /// - `from_rev` 与本地 `rev` 不一致：乱序补丁必须显式失败，绝不部分合并。
    pub fn apply(&mut self, patch: &ViewPatch) -> Result<(), PatchError> {
        if patch.to_rev < patch.from_rev {
            return Err(PatchError::InvalidRevision {
                from_rev: patch.from_rev,
                to_rev: patch.to_rev,
            });
        }
        if patch.to_rev == self.rev {
            // 已经处于该修订：幂等空操作（同一补丁重放/重发）。
            return Ok(());
        }
        if self.rev != patch.from_rev {
            return Err(PatchError::OutOfSequence {
                expected: self.rev,
                actual: patch.from_rev,
            });
        }

        for op in &patch.ops {
            match op {
                ViewOp::Upsert { row } => {
                    if row.key.trim().is_empty() {
                        return Err(PatchError::MalformedOp {
                            detail: String::from("upsert 的视图行 key 不能为空"),
                        });
                    }
                    self.rows.insert(row.key.clone(), row.clone());
                }
                ViewOp::Remove { key } => {
                    self.rows.remove(key);
                }
            }
        }
        self.rev = patch.to_rev;
        self.density = patch.density;
        Ok(())
    }

    /// 计算到 `next` 的差分补丁；操作按 key 升序输出，结果完全确定。
    pub fn diff(&self, next: &Self) -> Result<ViewPatch, PatchError> {
        if next.rev < self.rev {
            return Err(PatchError::InvalidRevision {
                from_rev: self.rev,
                to_rev: next.rev,
            });
        }
        let to_rev = if next.rev > self.rev {
            next.rev
        } else {
            self.rev.saturating_add(1)
        };

        let mut ops = Vec::new();
        for (key, row) in &next.rows {
            if self.rows.get(key) != Some(row) {
                ops.push(ViewOp::Upsert { row: row.clone() });
            }
        }
        for key in self.rows.keys() {
            if !next.rows.contains_key(key) {
                ops.push(ViewOp::Remove { key: key.clone() });
            }
        }
        ops.sort_by(|left, right| op_key(left).cmp(op_key(right)));

        Ok(ViewPatch {
            from_rev: self.rev,
            to_rev,
            density: next.density,
            ops,
        })
    }

    /// 从基线顺序重放补丁，得到完整快照。
    pub fn replay(base: &Self, patches: &[ViewPatch]) -> Result<Self, PatchError> {
        let mut state = base.clone();
        for patch in patches {
            state.apply(patch)?;
        }
        Ok(state)
    }

    /// 纯密度切换补丁（不产生任何行操作，但可被同一套重放机制应用）。
    #[must_use]
    pub fn density_patch(&self, density: CognitionDensity) -> ViewPatch {
        ViewPatch {
            from_rev: self.rev,
            to_rev: self.rev.saturating_add(1),
            density,
            ops: Vec::new(),
        }
    }

    /// 按当前密度投影（确定性顺序）。
    #[must_use]
    pub fn project(&self) -> Vec<ProjectedRow> {
        self.projected_rows(self.density)
    }

    /// 按指定密度投影出可送达界面的行集合。
    #[must_use]
    pub fn projected_rows(&self, density: CognitionDensity) -> Vec<ProjectedRow> {
        self.rows
            .values()
            .map(|row| ProjectedRow {
                key: row.key.clone(),
                kind: row.kind.clone(),
                summary: row.summary.clone(),
                detail: if density.includes(DetailLayer::Detail) {
                    row.detail.clone()
                } else {
                    None
                },
                raw_json: if density.includes(DetailLayer::Raw) {
                    row.raw_json.clone()
                } else {
                    None
                },
            })
            .collect()
    }

    /// 生成裁剪到指定密度的快照（随身端只持有摘要，绝不下发原始载荷）。
    #[must_use]
    pub fn projected_snapshot(&self, density: CognitionDensity) -> Self {
        let mut snapshot = Self {
            rev: self.rev,
            density,
            rows: BTreeMap::new(),
        };
        for row in self.rows.values() {
            snapshot.rows.insert(
                row.key.clone(),
                ViewRow {
                    key: row.key.clone(),
                    kind: row.kind.clone(),
                    summary: row.summary.clone(),
                    detail: if density.includes(DetailLayer::Detail) {
                        row.detail.clone()
                    } else {
                        None
                    },
                    raw_json: if density.includes(DetailLayer::Raw) {
                        row.raw_json.clone()
                    } else {
                        None
                    },
                    updated_rev: row.updated_rev,
                },
            );
        }
        snapshot
    }
}

fn op_key(op: &ViewOp) -> &str {
    match op {
        ViewOp::Upsert { row } => row.key.as_str(),
        ViewOp::Remove { key } => key.as_str(),
    }
}
