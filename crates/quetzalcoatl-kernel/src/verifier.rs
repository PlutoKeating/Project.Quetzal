#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 断网只读洁净室客观校验 DAG（`CleanRoomVerifierDag`）、反空跑（Anti-Vacuity）与防篡改 `VerificationMark`。

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};

use quetzalcoatl_sandbox::{CleanRoomSpec, SandboxCommand, SandboxManager};
use quetzalcoatl_types::{ArtifactId, HlcTimestamp, QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};

use crate::registry::compute_workspace_tree_blake3;

const VERIFICATION_MARK_DOMAIN: &str = "quetzalcoatl/v2/kernel-verification-mark-v1";
const VERIFIER_SUITE_SET_DOMAIN: &str = "quetzalcoatl/v2/kernel-verifier-suite-set-v1";

/// 洁净室客观校验 DAG 单个校验节点。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifierNode {
    pub node_id: String,
    pub depends_on: Vec<String>,
    pub verifier_suite_dir: PathBuf,
    pub command: SandboxCommand,
    pub expected_suite_blake3: Option<ArtifactId>,
}

/// 洁净室客观校验有向无环图。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanRoomVerifierDag {
    nodes: Vec<VerifierNode>,
}

impl CleanRoomVerifierDag {
    /// 校验节点唯一性与无环拓扑顺序后构造 `CleanRoomVerifierDag`。
    pub fn new(nodes: Vec<VerifierNode>) -> Result<Self> {
        if nodes.is_empty() {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: String::from("洁净室 Verifier DAG 不能为空"),
            });
        }

        let mut index_by_id = BTreeMap::<String, usize>::new();
        for (idx, node) in nodes.iter().enumerate() {
            if node.node_id.trim().is_empty() {
                return Err(QuetzalcoatlError::VerificationFailed {
                    detail: String::from("洁净室 Verifier 节点 ID 不能为空"),
                });
            }
            if index_by_id.insert(node.node_id.clone(), idx).is_some() {
                return Err(QuetzalcoatlError::VerificationFailed {
                    detail: format!("洁净室 Verifier DAG 存在重复节点 ID `{}`", node.node_id),
                });
            }
        }

        let mut indegree = vec![0usize; nodes.len()];
        let mut dependents = vec![Vec::<usize>::new(); nodes.len()];
        for (idx, node) in nodes.iter().enumerate() {
            let mut seen_deps = BTreeSet::<&str>::new();
            for dep_id in &node.depends_on {
                if !seen_deps.insert(dep_id.as_str()) {
                    continue;
                }
                let Some(&dep_idx) = index_by_id.get(dep_id) else {
                    return Err(QuetzalcoatlError::VerificationFailed {
                        detail: format!(
                            "洁净室 Verifier 节点 `{}` 引用了不存在的前置依赖 `{dep_id}`",
                            node.node_id
                        ),
                    });
                };
                indegree[idx] = indegree[idx].saturating_add(1);
                dependents[dep_idx].push(idx);
            }
        }

        let mut queue = VecDeque::<usize>::new();
        for (idx, &deg) in indegree.iter().enumerate() {
            if deg == 0 {
                queue.push_back(idx);
            }
        }

        let mut ordered = Vec::<VerifierNode>::with_capacity(nodes.len());
        while let Some(curr) = queue.pop_front() {
            ordered.push(nodes[curr].clone());
            for &next_idx in &dependents[curr] {
                indegree[next_idx] = indegree[next_idx].saturating_sub(1);
                if indegree[next_idx] == 0 {
                    queue.push_back(next_idx);
                }
            }
        }

        if ordered.len() != nodes.len() {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: String::from("洁净室 Verifier DAG 检测到循环依赖"),
            });
        }

        Ok(Self { nodes: ordered })
    }

    #[must_use]
    pub fn single(
        node_id: impl Into<String>,
        verifier_suite_dir: PathBuf,
        command: SandboxCommand,
    ) -> Self {
        Self {
            nodes: vec![VerifierNode {
                node_id: node_id.into(),
                depends_on: Vec::new(),
                verifier_suite_dir,
                command,
                expected_suite_blake3: None,
            }],
        }
    }

    #[must_use]
    pub fn nodes(&self) -> &[VerifierNode] {
        &self.nodes
    }
}

/// 从洁净室校验器标准输出解析出的客观用例统计（0 用例一律按 Anti-Vacuity 判败）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedTestCounts {
    pub executed_tests: u64,
    pub passed_tests: u64,
    pub failed_tests: u64,
}

#[derive(Deserialize)]
struct StructuredVerifierReport {
    executed_tests: u64,
    passed_tests: u64,
    #[serde(default)]
    failed_tests: u64,
}

fn parse_rust_test_result_line(line: &str) -> Option<ParsedTestCounts> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("test result:")?;
    let mut passed: Option<u64> = None;
    let mut failed: Option<u64> = None;

    for segment in rest.split(';') {
        let tokens: Vec<&str> = segment.split_whitespace().collect();
        for pair in tokens.windows(2) {
            if pair[1] == "passed"
                && let Ok(n) = pair[0].parse::<u64>()
            {
                passed = Some(n);
            } else if pair[1] == "failed"
                && let Ok(n) = pair[0].parse::<u64>()
            {
                failed = Some(n);
            }
        }
    }

    let p = passed?;
    let f = failed?;
    Some(ParsedTestCounts {
        executed_tests: p.saturating_add(f),
        passed_tests: p,
        failed_tests: f,
    })
}

/// 解析结构化 `QZ_VERIFIER_REPORT: {...}` 或标准测试框架 `test result: ...` 用例统计输出。
#[must_use]
pub fn parse_verifier_test_counts(output_text: &str) -> Option<ParsedTestCounts> {
    let mut found_any = false;
    let mut total_executed = 0u64;
    let mut total_passed = 0u64;
    let mut total_failed = 0u64;

    for line in output_text.lines() {
        let trimmed = line.trim();
        if let Some(json_part) = trimmed.strip_prefix("QZ_VERIFIER_REPORT:") {
            if let Ok(parsed) = serde_json::from_str::<StructuredVerifierReport>(json_part.trim()) {
                found_any = true;
                total_executed = total_executed.saturating_add(parsed.executed_tests);
                total_passed = total_passed.saturating_add(parsed.passed_tests);
                total_failed = total_failed.saturating_add(parsed.failed_tests);
            }
            continue;
        }

        if let Some(counts) = parse_rust_test_result_line(trimmed) {
            found_any = true;
            total_executed = total_executed.saturating_add(counts.executed_tests);
            total_passed = total_passed.saturating_add(counts.passed_tests);
            total_failed = total_failed.saturating_add(counts.failed_tests);
        }
    }

    if found_any {
        Some(ParsedTestCounts {
            executed_tests: total_executed,
            passed_tests: total_passed,
            failed_tests: total_failed,
        })
    } else {
        None
    }
}

fn compute_mark_id(
    run_id: RunId,
    candidate_tree_blake3: ArtifactId,
    verifier_suite_blake3: ArtifactId,
    executed_test_count: u64,
    passed_test_count: u64,
    hlc: HlcTimestamp,
) -> ArtifactId {
    let mut hasher = blake3::Hasher::new_derive_key(VERIFICATION_MARK_DOMAIN);
    hasher.update(run_id.as_bytes());
    hasher.update(candidate_tree_blake3.as_bytes());
    hasher.update(verifier_suite_blake3.as_bytes());
    hasher.update(&executed_test_count.to_be_bytes());
    hasher.update(&passed_test_count.to_be_bytes());
    hasher.update(&hlc.to_be_bytes());
    ArtifactId::from_bytes(*hasher.finalize().as_bytes())
}

/// 洁净室校验通过后的候选状态收据（签发 `VerificationMark` 前须再次复核工作区 `BLAKE3` 树摘要防 TOCTOU 篡改）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCandidateReceipt {
    pub run_id: RunId,
    pub candidate_workspace: PathBuf,
    pub candidate_tree_blake3: ArtifactId,
    pub verifier_suite_blake3: ArtifactId,
    pub executed_test_count: u64,
    pub passed_test_count: u64,
    pub verifier_runs: u64,
}

/// 仅在外部断网只读洁净室校验通过且树摘要未发生漂移时由内核签发的客观验收凭证。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationMark {
    pub mark_id: ArtifactId,
    pub run_id: RunId,
    pub candidate_tree_blake3: ArtifactId,
    pub verifier_suite_blake3: ArtifactId,
    pub executed_test_count: u64,
    pub passed_test_count: u64,
    pub hlc: HlcTimestamp,
}

impl VerificationMark {
    pub fn verify_integrity(&self) -> Result<()> {
        if self.executed_test_count == 0 || self.passed_test_count != self.executed_test_count {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("VerificationMark 违反 Anti-Vacuity 非零全通过不变量"),
            });
        }
        let expected = compute_mark_id(
            self.run_id,
            self.candidate_tree_blake3,
            self.verifier_suite_blake3,
            self.executed_test_count,
            self.passed_test_count,
            self.hlc,
        );
        if self.mark_id != expected {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("VerificationMark 摘要校验不匹配（疑似伪造或篡改）"),
            });
        }
        Ok(())
    }
}

/// 洁净室客观校验执行器（跟踪真实洁净室子进程拉起计数）。
#[derive(Clone, Debug, Default)]
pub struct CleanRoomVerifierEngine {
    total_verifier_runs: u64,
}

impl CleanRoomVerifierEngine {
    #[must_use]
    pub fn new() -> Self {
        Self {
            total_verifier_runs: 0,
        }
    }

    #[must_use]
    pub const fn total_verifier_runs(&self) -> u64 {
        self.total_verifier_runs
    }

    pub fn execute_dag(
        &mut self,
        sandbox: &SandboxManager,
        run_id: RunId,
        candidate_workspace: &Path,
        dag: &CleanRoomVerifierDag,
    ) -> Result<VerifiedCandidateReceipt> {
        if dag.nodes().is_empty() {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: String::from("洁净室 Verifier DAG 无可执行节点"),
            });
        }

        let initial_tree_blake3 = compute_workspace_tree_blake3(candidate_workspace)?;
        let ws_path_str = candidate_workspace.to_string_lossy().into_owned();

        let mut unique_suite_digests = BTreeSet::<ArtifactId>::new();
        let mut total_executed = 0u64;
        let mut total_passed = 0u64;
        let mut runs_in_dag = 0u64;

        for node in dag.nodes() {
            let suite_blake3 = compute_workspace_tree_blake3(&node.verifier_suite_dir)?;
            if let Some(expected_suite) = node.expected_suite_blake3
                && suite_blake3 != expected_suite
            {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!(
                        "洁净室节点 `{}` 校验套件摘要不匹配 (expected={expected_suite}, actual={suite_blake3})",
                        node.node_id
                    ),
                });
            }
            unique_suite_digests.insert(suite_blake3);

            let mut cmd = node.command.clone();
            cmd.extra_env.insert(
                String::from("QUETZALCOATL_CANDIDATE_WORKSPACE"),
                ws_path_str.clone(),
            );
            cmd.extra_env.insert(
                String::from("QUETZALCOATL_VERIFIER_SUITE_DIR"),
                node.verifier_suite_dir.to_string_lossy().into_owned(),
            );

            self.total_verifier_runs = self.total_verifier_runs.saturating_add(1);
            runs_in_dag = runs_in_dag.saturating_add(1);

            let output = sandbox.spawn_clean_room(&CleanRoomSpec {
                run_id,
                candidate_workspace: candidate_workspace.to_path_buf(),
                verifier_suite_dir: node.verifier_suite_dir.clone(),
                command: cmd,
            })?;

            let combined_out = format!("{}\n{}", output.stdout_lossy(), output.stderr_lossy());
            if !output.success() {
                return Err(QuetzalcoatlError::VerificationFailed {
                    detail: format!(
                        "洁净室节点 `{}` 校验未通过 (exit_code={}): {}",
                        node.node_id,
                        output.exit_code,
                        combined_out.trim()
                    ),
                });
            }

            let counts = parse_verifier_test_counts(&combined_out).ok_or_else(|| {
                QuetzalcoatlError::VerificationFailed {
                    detail: format!(
                        "Anti-Vacuity 拦截：洁净室节点 `{}` 未输出任何可核验的测试用例执行计数",
                        node.node_id
                    ),
                }
            })?;

            if counts.executed_tests == 0 {
                return Err(QuetzalcoatlError::VerificationFailed {
                    detail: format!(
                        "Anti-Vacuity 拦截：洁净室节点 `{}` 运行用例数为 0（拒绝空跑通过）",
                        node.node_id
                    ),
                });
            }
            if counts.failed_tests > 0 || counts.passed_tests != counts.executed_tests {
                return Err(QuetzalcoatlError::VerificationFailed {
                    detail: format!(
                        "洁净室节点 `{}` 存在失败用例 (executed={}, passed={}, failed={})",
                        node.node_id,
                        counts.executed_tests,
                        counts.passed_tests,
                        counts.failed_tests
                    ),
                });
            }

            total_executed = total_executed.saturating_add(counts.executed_tests);
            total_passed = total_passed.saturating_add(counts.passed_tests);
        }

        let post_dag_tree_blake3 = compute_workspace_tree_blake3(candidate_workspace)?;
        if post_dag_tree_blake3 != initial_tree_blake3 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("洁净室校验期间检测到宿主侧并发篡改候选工作区树"),
            });
        }

        let verifier_suite_blake3 = if unique_suite_digests.len() == 1 {
            unique_suite_digests
                .into_iter()
                .next()
                .unwrap_or(ArtifactId::ZERO)
        } else {
            let mut h = blake3::Hasher::new_derive_key(VERIFIER_SUITE_SET_DOMAIN);
            h.update(&(unique_suite_digests.len() as u64).to_be_bytes());
            for d in unique_suite_digests {
                h.update(d.as_bytes());
            }
            ArtifactId::from_bytes(*h.finalize().as_bytes())
        };

        Ok(VerifiedCandidateReceipt {
            run_id,
            candidate_workspace: candidate_workspace.to_path_buf(),
            candidate_tree_blake3: initial_tree_blake3,
            verifier_suite_blake3,
            executed_test_count: total_executed,
            passed_test_count: total_passed,
            verifier_runs: runs_in_dag,
        })
    }

    /// 在签发 `VerificationMark` 瞬间复核候选工作区树摘要（阻断校验通过后落盘前的 TOCTOU 调包）。
    pub fn mint_mark_for_receipt(
        &self,
        receipt: &VerifiedCandidateReceipt,
        hlc: HlcTimestamp,
    ) -> Result<VerificationMark> {
        if receipt.executed_test_count == 0
            || receipt.passed_test_count != receipt.executed_test_count
        {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: String::from("拒绝为 0 用例或未全量通过的收据签发 VerificationMark"),
            });
        }

        let current_tree_blake3 = compute_workspace_tree_blake3(&receipt.candidate_workspace)?;
        if current_tree_blake3 != receipt.candidate_tree_blake3 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "检测到候选工作区在校验通过后发生篡改：verified={} != current={}",
                    receipt.candidate_tree_blake3, current_tree_blake3
                ),
            });
        }

        let mark_id = compute_mark_id(
            receipt.run_id,
            receipt.candidate_tree_blake3,
            receipt.verifier_suite_blake3,
            receipt.executed_test_count,
            receipt.passed_test_count,
            hlc,
        );

        Ok(VerificationMark {
            mark_id,
            run_id: receipt.run_id,
            candidate_tree_blake3: receipt.candidate_tree_blake3,
            verifier_suite_blake3: receipt.verifier_suite_blake3,
            executed_test_count: receipt.executed_test_count,
            passed_test_count: receipt.passed_test_count,
            hlc,
        })
    }
}
