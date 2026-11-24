#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-capabilities` — 基础能力包实现集合。
//!
//! 声明式描述符位于 `packages/capabilities/<id>/capability.json`，
//! 本 crate 的 [`manifests`] 是唯一可执行实现事实源；两者由契约测试逐字段对齐。

pub mod artifacts;
pub mod deliverables;
pub mod doc_reader;
pub mod hands_desktop;
pub mod sayit_ingestor;
pub mod web_research;

pub use sayit_ingestor::{
    SayItBatchOutcome, SayItIngestReceipt, SayItIngestor, SayItSnapshotMeta, SayItTarget,
    SovereignScope, ingest_batch_into_graph, ingest_file_into_graph, ingest_snapshot_into_graph,
    snapshot_embedder_meta,
};

use serde::{Deserialize, Serialize};

/// 能力包实现引用。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationRef {
    #[serde(rename = "crate")]
    pub crate_name: String,
    pub module: String,
}

/// 能力包声明的最小权限面。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityPermissions {
    pub network: bool,
    pub filesystem: Vec<String>,
    pub sinks: Vec<String>,
}

/// 单个基础能力包描述符。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDescriptor {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub implementation: ImplementationRef,
    pub permissions: CapabilityPermissions,
    pub status: String,
}

impl CapabilityDescriptor {
    fn new(
        id: &str,
        display_name: &str,
        description: &str,
        module: &str,
        network: bool,
        filesystem: &[&str],
        sinks: &[&str],
    ) -> Self {
        Self {
            id: String::from(id),
            display_name: String::from(display_name),
            description: String::from(description),
            implementation: ImplementationRef {
                crate_name: String::from("quetzalcoatl-capabilities"),
                module: String::from(module),
            },
            permissions: CapabilityPermissions {
                network,
                filesystem: filesystem.iter().map(|s| String::from(*s)).collect(),
                sinks: sinks.iter().map(|s| String::from(*s)).collect(),
            },
            status: String::from("declared"),
        }
    }
}

/// 六大基础能力包的完整声明（不含任何额外虚构能力）。
#[must_use]
pub fn manifests() -> Vec<CapabilityDescriptor> {
    vec![
        CapabilityDescriptor::new(
            "deliverables",
            "交付物生成",
            "在受限工作区内生成文档、表格与演示文稿交付物并登记 ArtifactRef。",
            "deliverables",
            false,
            &["workspace/artifacts"],
            &["file.write", "artifact.register"],
        ),
        CapabilityDescriptor::new(
            "web-research",
            "联网研究",
            "经外部只读检索与抓取收敛来源，输出带引用的研究报告；写外发需 Router 授权。",
            "web_research",
            true,
            &[],
            &["network.read", "memory.observe"],
        ),
        CapabilityDescriptor::new(
            "doc-reader",
            "文档读取",
            "解析用户授权目录内的 PDF/Office/文本，提取结构化内容，不修改原文件。",
            "doc_reader",
            false,
            &["workspace/read-only"],
            &["file.read"],
        ),
        CapabilityDescriptor::new(
            "hands-desktop",
            "桌面操作",
            "在用户显式授权下经 OS 沙箱执行桌面自动化，所有高危动作强制二次确认。",
            "hands_desktop",
            false,
            &[],
            &["desktop.interact"],
        ),
        CapabilityDescriptor::new(
            "artifacts",
            "产物登记",
            "以不可变 ArtifactRef 登记构建产物与 Git Tree 引用，供跨 Worktree 零拷贝交接。",
            "artifacts",
            false,
            &["workspace/artifacts"],
            &["artifact.register", "artifact.read"],
        ),
        sayit_ingestor::descriptor(),
    ]
}

/// 按 ID 查找能力包描述符。
#[must_use]
pub fn manifest(id: &str) -> Option<CapabilityDescriptor> {
    manifests().into_iter().find(|m| m.id == id)
}
