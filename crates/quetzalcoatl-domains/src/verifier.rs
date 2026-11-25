#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 领域专属客观校验：引用完备性、苏格拉底引导、能力边界、免责披露、危险命令与洁净室凭证门禁。

use quetzalcoatl_kernel::{RunMode, RunRecord, SinkClass};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::manifest::{DeliverableKind, DomainPack, VerifierRule};

/// 单条引用。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Citation {
    pub source_id: String,
    pub locator: String,
}

/// 单条可核验论断。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claim {
    pub statement: String,
    pub citations: Vec<Citation>,
}

/// 待交付候选（模型输出经领域校验器裁决后方可外发）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverableCandidate {
    pub kind: DeliverableKind,
    pub text: String,
    #[serde(default)]
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub questions_asked: u32,
    #[serde(default)]
    pub gives_final_answer: bool,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub deferral: Option<String>,
}

impl DeliverableCandidate {
    #[must_use]
    pub fn new(kind: DeliverableKind, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: text.into(),
            ..Self::default()
        }
    }

    fn contains_marker(&self, marker: &str) -> bool {
        let marker = marker.trim();
        if marker.is_empty() {
            return false;
        }
        self.text.to_lowercase().contains(&marker.to_lowercase())
            || self
                .deferral
                .as_deref()
                .is_some_and(|d| d.to_lowercase().contains(&marker.to_lowercase()))
    }
}

fn command_is_forbidden(command: &str, patterns: &[String]) -> Option<String> {
    let lowered = command.to_lowercase();
    patterns
        .iter()
        .find(|p| !p.trim().is_empty() && lowered.contains(&p.trim().to_lowercase()))
        .cloned()
}

impl DomainPack {
    /// 逐条执行领域客观校验规则；任一红光即拒绝交付。
    pub fn check_deliverable(&self, candidate: &DeliverableCandidate) -> Result<()> {
        let mut violations = Vec::<String>::new();

        for rule in &self.verifier_rules {
            match rule {
                VerifierRule::CitationRequired {
                    directive_id,
                    min_citations_per_claim,
                    applies_to,
                    content_triggers,
                } => {
                    let by_kind = applies_to_candidate(applies_to, candidate.kind);
                    let by_content = content_triggers
                        .iter()
                        .any(|trigger| candidate.contains_marker(trigger));
                    let has_claims = !candidate.claims.is_empty();
                    if !(by_kind || by_content || has_claims) {
                        continue;
                    }
                    if !has_claims {
                        violations.push(format!(
                            "{directive_id}: 交付物未包含任何可核验论断（kind 标签不得绕过引用红线），禁止无引用交付"
                        ));
                        continue;
                    }
                    for claim in &candidate.claims {
                        let have = u32::try_from(claim.citations.len()).unwrap_or(u32::MAX);
                        if have < *min_citations_per_claim {
                            violations.push(format!(
                                "{directive_id}: 论断「{}」仅有 {have} 条引用，低于要求的 {min_citations_per_claim} 条",
                                truncate_for_error(&claim.statement, 48)
                            ));
                        }
                    }
                }
                VerifierRule::SocraticGuidance {
                    directive_id,
                    min_questions,
                    final_answer_markers,
                } => {
                    // 追问数量一律由候选文本派生，绝不采信调用方自述
                    let derived_questions = count_interrogatives(&candidate.text);
                    let marker_hit = final_answer_markers
                        .iter()
                        .find(|m| candidate.contains_marker(m));
                    if candidate.gives_final_answer {
                        violations.push(format!(
                            "{directive_id}: 候选声明自己直接交付了终局答案，违反苏格拉底引导红线"
                        ));
                    }
                    if let Some(marker) = marker_hit {
                        violations.push(format!(
                            "{directive_id}: 候选文本命中终局答案标记「{marker}」"
                        ));
                    }
                    if derived_questions < *min_questions {
                        violations.push(format!(
                            "{directive_id}: 候选文本仅含 {derived_questions} 个引导性追问（问号/疑问措辞派生），低于要求的 {min_questions} 个"
                        ));
                    }
                }
                VerifierRule::CompetenceBoundary {
                    directive_id,
                    topic_keywords,
                    deferral_markers,
                } => {
                    let topic_hits: Vec<&String> = topic_keywords
                        .iter()
                        .filter(|k| candidate.contains_marker(k))
                        .collect();
                    if topic_hits.is_empty() {
                        continue;
                    }
                    let has_deferral = deferral_markers
                        .iter()
                        .any(|m| candidate.contains_marker(m));
                    if !has_deferral {
                        violations.push(format!(
                            "{directive_id}: 候选触及越界专业话题（{}）却未显式转介专业人士",
                            topic_hits
                                .iter()
                                .map(|k| k.as_str())
                                .collect::<Vec<_>>()
                                .join("、")
                        ));
                    }
                }
                VerifierRule::RequiredDisclosure {
                    directive_id,
                    marker,
                    applies_to,
                    content_triggers,
                } => {
                    let by_kind = applies_to_candidate(applies_to, candidate.kind);
                    let by_content = content_triggers
                        .iter()
                        .any(|trigger| candidate.contains_marker(trigger));
                    if (by_kind || by_content) && !candidate.text.contains(marker) {
                        violations.push(format!(
                            "{directive_id}: 交付物缺失必要声明「{marker}」（辖区/执业范围披露，kind 标签不得绕过）"
                        ));
                    }
                }
                VerifierRule::ForbiddenCommandPatterns {
                    directive_id,
                    patterns,
                } => {
                    for command in &candidate.commands {
                        if let Some(hit) = command_is_forbidden(command, patterns) {
                            violations.push(format!(
                                "{directive_id}: 命令 `{}` 命中禁止模式「{hit}」",
                                truncate_for_error(command, 64)
                            ));
                        }
                    }
                }
                VerifierRule::CleanRoomMarkRequired { .. } => {
                    // 洁净室门禁属于 Run 级客观验收，见 `guard_repository_mutation`。
                }
            }
        }

        if violations.is_empty() {
            return Ok(());
        }
        Err(QuetzalcoatlError::VerificationFailed {
            detail: format!(
                "领域包 `{}` 客观校验拒绝交付：{}",
                self.id,
                violations.join("；")
            ),
        })
    }

    /// 仓库变更 Commit Run 的洁净室凭证门禁：无有效 `VerificationMark` 一律拒绝。
    pub fn guard_repository_mutation(&self, run: &RunRecord) -> Result<()> {
        let Some(required) = self.verifier_rules.iter().find_map(|rule| match rule {
            VerifierRule::CleanRoomMarkRequired {
                directive_id,
                repository_mutation,
            } => Some((directive_id, *repository_mutation)),
            _ => None,
        }) else {
            return Ok(());
        };
        let (directive_id, repository_mutation) = required;

        // 未触及仓库变更汇点或非 Commit 态：保持既有行为不变
        if !repository_mutation
            || run.mode != RunMode::Commit
            || !run
                .touched_sinks
                .contains(&SinkClass::CodeRepositoryMutation)
        {
            return Ok(());
        }

        let Some(mark) = &run.verification_mark else {
            return Err(QuetzalcoatlError::VerificationFailed {
                detail: format!(
                    "领域包 `{}` 拒绝无洁净室凭证的仓库变更（拒绝指令 `{directive_id}`）：Commit Run `{}` 必须先通过断网只读 CleanRoomVerifierDag 并签发 VerificationMark",
                    self.id, run.run_id
                ),
            });
        };

        mark.verify_integrity()?;
        if mark.run_id != run.run_id {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "VerificationMark 归属 Run `{}` 与目标 Commit Run `{}` 不一致",
                    mark.run_id, run.run_id
                ),
            });
        }
        Ok(())
    }
}

fn applies_to_candidate(applies_to: &[DeliverableKind], kind: DeliverableKind) -> bool {
    applies_to.is_empty() || applies_to.contains(&kind)
}

/// 从候选文本派生引导性追问数量（问号 + 中文疑问措辞），绝不采信调用方自述字段。
fn count_interrogatives(text: &str) -> u32 {
    const INTERROGATIVES: [&str; 7] = ["吗", "呢", "为什么", "怎么", "如何", "是否", "哪一"];
    let marks = text.chars().filter(|c| *c == '?' || *c == '？').count();
    let hits = INTERROGATIVES.iter().filter(|w| text.contains(**w)).count();
    u32::try_from(marks.max(hits)).unwrap_or(u32::MAX)
}

fn truncate_for_error(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return String::from(trimmed);
    }
    let head: String = trimmed.chars().take(limit).collect();
    format!("{head}…")
}
