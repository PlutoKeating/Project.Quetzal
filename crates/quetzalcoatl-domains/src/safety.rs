#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 监护人安全信封运行期执行器：外发频率/静默时段/预算门禁、紧急告警穿透与安全审计日志。

use std::collections::BTreeMap;

use quetzalcoatl_kernel::{HeartScheduler, LeasePosture, RunRecord, WakeSignalResult};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::manifest::{DomainPack, GuardianKey, SafetyEnvelope};
use crate::verifier::DeliverableCandidate;

const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

/// 外发意图种类。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundKind {
    /// 紧急看护告警（跌倒/急症），受监护人信封的穿透策略保护。
    EmergencyAlert,
    /// 例行消息（问候、提醒、日程），受全部抑制器与配额约束。
    RoutineMessage,
}

/// 外发抑制原因。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuppressionReason {
    EmergencyDisabled,
    EmergencyContactsUnavailable,
    QuietHours,
    ChannelFrequencyCap,
    BudgetCeilingExhausted,
    SleepOrHostInhibition,
    PartitionLocalPublicQueue,
}

impl SuppressionReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EmergencyDisabled => "emergency_disabled",
            Self::EmergencyContactsUnavailable => "emergency_contacts_unavailable",
            Self::QuietHours => "quiet_hours",
            Self::ChannelFrequencyCap => "channel_frequency_cap",
            Self::BudgetCeilingExhausted => "budget_ceiling_exhausted",
            Self::SleepOrHostInhibition => "sleep_or_host_inhibition",
            Self::PartitionLocalPublicQueue => "partition_local_public_queue",
        }
    }
}

/// 单次外发请求。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboundRequest {
    pub kind: OutboundKind,
    pub channel_id: String,
    /// 不透明联系人/接收者 ID（绝不包含真实手机号、邮箱或姓名）。
    pub recipient_ids: Vec<String>,
    pub text: String,
    /// 是否为断网分区下不可幂等重放的公网外发。
    pub is_non_idempotent_public: bool,
}

/// 外发裁决结果。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundOutcome {
    Delivered,
    /// 断网分区下仅完成本地告警投递，公网升级待重获见证纪元后补发。
    DeliveredLocalOnly,
    Suppressed(SuppressionReason),
}

impl OutboundOutcome {
    #[must_use]
    pub fn as_journal_str(self) -> String {
        match self {
            Self::Delivered => String::from("delivered"),
            Self::DeliveredLocalOnly => String::from("delivered_local_only"),
            Self::Suppressed(reason) => format!("suppressed:{}", reason.as_str()),
        }
    }
}

/// 外发裁决回执。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundDecision {
    pub event_id: Uuid,
    pub outcome: OutboundOutcome,
    pub bypassed_sleep_inhibition: bool,
    pub guardian_visible: bool,
}

/// 安全事件种类。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyEventKind {
    EmergencyAlert,
    RoutineMessage,
    VerifierBlocked,
}

impl SafetyEventKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EmergencyAlert => "emergency_alert",
            Self::RoutineMessage => "routine_message",
            Self::VerifierBlocked => "verifier_blocked",
        }
    }
}

/// 不可变安全审计日志条目。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyEvent {
    pub event_id: Uuid,
    pub at_ms: u64,
    pub kind: SafetyEventKind,
    pub outcome: String,
    pub channel_id: Option<String>,
    pub recipients: Vec<String>,
    pub guardian_visible: bool,
    pub detail: String,
}

/// 领域包安全监护执行器（外发门禁状态 + 安全审计日志）。
#[derive(Clone, Debug)]
pub struct SafetySupervisor {
    pack: DomainPack,
    journal: Vec<SafetyEvent>,
    channel_sends: BTreeMap<String, Vec<u64>>,
    budget_spent_micros: u64,
}

impl SafetySupervisor {
    #[must_use]
    pub fn new(pack: &DomainPack) -> Self {
        Self {
            pack: pack.clone(),
            journal: Vec::new(),
            channel_sends: BTreeMap::new(),
            budget_spent_micros: 0,
        }
    }

    #[must_use]
    pub fn pack(&self) -> &DomainPack {
        &self.pack
    }

    #[must_use]
    pub fn journal(&self) -> &[SafetyEvent] {
        &self.journal
    }

    #[must_use]
    pub const fn budget_spent_micros(&self) -> u64 {
        self.budget_spent_micros
    }

    fn guardian_visible(&self, kind: SafetyEventKind) -> bool {
        self.pack
            .safety_envelope
            .payload
            .safety_events
            .guardian_visible_event_kinds
            .iter()
            .any(|k| k == kind.as_str())
    }

    fn record(
        &mut self,
        kind: SafetyEventKind,
        outcome: String,
        request: Option<&OutboundRequest>,
        at_ms: u64,
        detail: String,
    ) -> SafetyEvent {
        let event = SafetyEvent {
            event_id: Uuid::new_v4(),
            at_ms,
            kind,
            outcome,
            channel_id: request.map(|r| r.channel_id.clone()),
            recipients: request.map(|r| r.recipient_ids.clone()).unwrap_or_default(),
            guardian_visible: self.guardian_visible(kind),
            detail,
        };
        self.journal.push(event.clone());
        event
    }

    /// 外发总门禁：紧急告警穿越睡眠/预算抑制，例行消息受全部抑制器与配额约束。
    pub fn route_outbound(
        &mut self,
        request: &OutboundRequest,
        heart: &mut HeartScheduler,
        local_hour: f64,
        lease: LeasePosture,
        now_ms: u64,
        estimated_cost_micros: u64,
    ) -> Result<OutboundDecision> {
        match request.kind {
            OutboundKind::EmergencyAlert => self.route_emergency(
                request,
                heart,
                local_hour,
                lease,
                now_ms,
                estimated_cost_micros,
            ),
            OutboundKind::RoutineMessage => self.route_routine(
                request,
                heart,
                local_hour,
                lease,
                now_ms,
                estimated_cost_micros,
            ),
        }
    }

    fn route_emergency(
        &mut self,
        request: &OutboundRequest,
        heart: &mut HeartScheduler,
        local_hour: f64,
        lease: LeasePosture,
        now_ms: u64,
        estimated_cost_micros: u64,
    ) -> Result<OutboundDecision> {
        let policy = self.pack.safety_envelope.payload.emergency.clone();
        let kind = SafetyEventKind::EmergencyAlert;

        if !policy.enabled {
            return Ok(self.suppress(kind, SuppressionReason::EmergencyDisabled, request, now_ms));
        }
        if policy.contacts.is_empty() {
            return Ok(self.suppress(
                kind,
                SuppressionReason::EmergencyContactsUnavailable,
                request,
                now_ms,
            ));
        }
        for recipient in &request.recipient_ids {
            if !policy.contacts.contains(recipient) {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: format!(
                        "紧急告警目标 `{recipient}` 未经监护人安全信封授权：严禁向任意联系人转发健康/看护数据"
                    ),
                });
            }
        }

        let bypass = policy.bypass_sleep_inhibition;
        let wake = heart.handle_wake_signal(local_hour, bypass);
        if !bypass && matches!(wake, WakeSignalResult::Suppressed { .. }) {
            return Ok(self.suppress(
                kind,
                SuppressionReason::SleepOrHostInhibition,
                request,
                now_ms,
            ));
        }
        let bypassed = matches!(
            wake,
            WakeSignalResult::Woken {
                emergency_bypass: true,
                ..
            }
        );

        let partition_local_only = lease == LeasePosture::PartitionLocal;
        if partition_local_only && !policy.allow_local_alert_under_partition {
            return Ok(self.suppress(
                kind,
                SuppressionReason::PartitionLocalPublicQueue,
                request,
                now_ms,
            ));
        }

        let outcome = if partition_local_only && request.is_non_idempotent_public {
            OutboundOutcome::DeliveredLocalOnly
        } else {
            OutboundOutcome::Delivered
        };

        // 紧急告警穿透预算限流，但仍如实记账以便监护人复核总量
        self.budget_spent_micros = self
            .budget_spent_micros
            .saturating_add(estimated_cost_micros);
        self.channel_sends
            .entry(request.channel_id.clone())
            .or_default()
            .push(now_ms);

        let detail = format!(
            "紧急告警已投递（通道={}，断网本地={}，睡眠/预算穿透={bypassed}）",
            request.channel_id, partition_local_only
        );
        let event = self.record(
            kind,
            outcome.as_journal_str(),
            Some(request),
            now_ms,
            detail,
        );
        Ok(OutboundDecision {
            event_id: event.event_id,
            outcome,
            bypassed_sleep_inhibition: bypassed,
            guardian_visible: event.guardian_visible,
        })
    }

    fn route_routine(
        &mut self,
        request: &OutboundRequest,
        heart: &mut HeartScheduler,
        local_hour: f64,
        lease: LeasePosture,
        now_ms: u64,
        estimated_cost_micros: u64,
    ) -> Result<OutboundDecision> {
        let kind = SafetyEventKind::RoutineMessage;
        let payload = self.pack.safety_envelope.payload.clone();

        if payload.outbound.quiet_hours.contains_hour(local_hour) {
            return Ok(self.suppress(kind, SuppressionReason::QuietHours, request, now_ms));
        }

        let Some(cap) = payload
            .outbound
            .per_channel_caps
            .iter()
            .find(|c| c.channel_id == request.channel_id)
        else {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "通道 `{}` 未经监护人安全信封授权，禁止作为例行外发通道",
                    request.channel_id
                ),
            });
        };

        if matches!(
            heart.handle_wake_signal(local_hour, false),
            WakeSignalResult::Suppressed { .. }
        ) {
            return Ok(self.suppress(
                kind,
                SuppressionReason::SleepOrHostInhibition,
                request,
                now_ms,
            ));
        }

        let max_recipients = payload.outbound.max_recipients_per_message;
        if u32::try_from(request.recipient_ids.len()).unwrap_or(u32::MAX) > max_recipients {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "单条消息收件人数 {} 超过监护人信封上限 {max_recipients}",
                    request.recipient_ids.len()
                ),
            });
        }

        let recent = self
            .channel_sends
            .get(&request.channel_id)
            .cloned()
            .unwrap_or_default();
        let last_hour = recent
            .iter()
            .filter(|t| now_ms.saturating_sub(**t) < HOUR_MS)
            .count();
        let last_day = recent
            .iter()
            .filter(|t| now_ms.saturating_sub(**t) < DAY_MS)
            .count();
        if u32::try_from(last_hour).unwrap_or(u32::MAX) >= cap.max_per_hour
            || u32::try_from(last_day).unwrap_or(u32::MAX) >= cap.max_per_day
        {
            return Ok(self.suppress(
                kind,
                SuppressionReason::ChannelFrequencyCap,
                request,
                now_ms,
            ));
        }

        if self
            .budget_spent_micros
            .saturating_add(estimated_cost_micros)
            > payload.budget.ceiling_micros
        {
            return Ok(self.suppress(
                kind,
                SuppressionReason::BudgetCeilingExhausted,
                request,
                now_ms,
            ));
        }

        if lease == LeasePosture::PartitionLocal && request.is_non_idempotent_public {
            return Ok(self.suppress(
                kind,
                SuppressionReason::PartitionLocalPublicQueue,
                request,
                now_ms,
            ));
        }

        self.budget_spent_micros = self
            .budget_spent_micros
            .saturating_add(estimated_cost_micros);
        self.channel_sends
            .entry(request.channel_id.clone())
            .or_default()
            .push(now_ms);

        let event = self.record(
            kind,
            OutboundOutcome::Delivered.as_journal_str(),
            Some(request),
            now_ms,
            String::from("例行消息已投递"),
        );
        Ok(OutboundDecision {
            event_id: event.event_id,
            outcome: OutboundOutcome::Delivered,
            bypassed_sleep_inhibition: false,
            guardian_visible: event.guardian_visible,
        })
    }

    fn suppress(
        &mut self,
        kind: SafetyEventKind,
        reason: SuppressionReason,
        request: &OutboundRequest,
        now_ms: u64,
    ) -> OutboundDecision {
        let outcome = OutboundOutcome::Suppressed(reason);
        let event = self.record(
            kind,
            outcome.as_journal_str(),
            Some(request),
            now_ms,
            format!("外发被抑制: {}", reason.as_str()),
        );
        OutboundDecision {
            event_id: event.event_id,
            outcome,
            bypassed_sleep_inhibition: false,
            guardian_visible: event.guardian_visible,
        }
    }

    /// 交付物客观校验：拦截时把违规事实写入安全日志（可按信封策略对监护人可见）。
    pub fn check_deliverable(
        &mut self,
        candidate: &DeliverableCandidate,
        at_ms: u64,
    ) -> Result<()> {
        match self.pack.check_deliverable(candidate) {
            Ok(()) => Ok(()),
            Err(err) => {
                self.record(
                    SafetyEventKind::VerifierBlocked,
                    String::from("blocked"),
                    None,
                    at_ms,
                    err.to_string(),
                );
                Err(err)
            }
        }
    }

    /// 仓库变更洁净室凭证门禁（Run 级客观验收）。
    pub fn guard_repository_mutation(&self, run: &RunRecord) -> Result<()> {
        self.pack.guard_repository_mutation(run)
    }

    /// 监护人重新签名的信封变更：不可变字段即便监护人重签也禁止经代理侧接口放宽。
    pub fn apply_envelope_amendment(
        &mut self,
        amended: &SafetyEnvelope,
        guardians: &[GuardianKey],
    ) -> Result<()> {
        let keyring: BTreeMap<String, GuardianKey> = guardians
            .iter()
            .map(|g| (g.normalized(), g.clone()))
            .collect();
        amended.verify(&keyring)?;

        if amended.payload.pack_id != self.pack.id {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("被修订信封绑定的领域包 ID 与当前领域包不一致"),
            });
        }
        if !amended
            .payload
            .pack_blake3_hex
            .trim()
            .eq_ignore_ascii_case(&self.pack.body_digest_hex()?)
        {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("被修订信封绑定的领域包正文摘要与当前领域包不一致"),
            });
        }

        for field in &self.pack.safety_envelope.payload.immutable_fields {
            if amended.payload.field_value(field)
                != self.pack.safety_envelope.payload.field_value(field)
            {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: format!(
                        "安全信封不可变字段 `{field}` 严禁被代理侧接口改写（须脱机由监护人重签并重新下发整个领域包）"
                    ),
                });
            }
        }

        self.pack.safety_envelope = amended.clone();
        Ok(())
    }
}
