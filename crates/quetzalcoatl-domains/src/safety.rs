#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 监护人安全信封运行期执行器：外发频率/静默时段/预算门禁、紧急告警穿透与安全审计日志，
//! 以及跨重启的配额状态持久化（SQLite/状态脊柱签名 HLC 事件）。

use std::collections::BTreeMap;

use quetzalcoatl_crypto::PackCompartment;
use quetzalcoatl_kernel::{HeartScheduler, LeasePosture, RunRecord, WakeSignalResult};
use quetzalcoatl_spine::{MaterializedStore, SpineEngine};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::manifest::{DomainPack, GuardianKey, SafetyEnvelope};
use crate::verifier::DeliverableCandidate;

const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;
/// 安全审计日志保留的最大条目数（防止脊柱事件无界膨胀）。
const MAX_JOURNAL_EVENTS: usize = 256;
/// 配额状态持久化事件 schema。
pub const SAFETY_STATE_SCHEMA: &str = "quetzalcoatl.domain.safety.v1";

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

/// 单次外发裁决的宿主上下文（生物钟、租约姿态、时间与预估成本）。
pub struct OutboundContext<'a> {
    pub heart: &'a mut HeartScheduler,
    pub local_hour: f64,
    pub lease: LeasePosture,
    pub now_ms: u64,
    pub estimated_cost_micros: u64,
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

/// 可持久化的外发配额与安全日志状态（跨重启恢复，杜绝"重启即清空硬上限"）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyPersistedState {
    pub pack_id: String,
    pub channel_sends: BTreeMap<String, Vec<u64>>,
    pub budget_spent_micros: u64,
    pub journal: Vec<SafetyEvent>,
}

/// 配额状态持久化端口（守护进程用状态脊柱实现，测试可用内存实现）。
pub trait SafetyStateSink {
    fn load_state(&mut self, pack_id: &str) -> Result<Option<SafetyPersistedState>>;
    fn append_state(
        &mut self,
        pack_id: &str,
        state: &SafetyPersistedState,
        now_ms: u64,
    ) -> Result<()>;
}

/// 进程内配额状态（仅用于认证测试与纯内存场景；不跨重启）。
#[derive(Clone, Debug, Default)]
pub struct MemorySafetySink {
    states: BTreeMap<String, SafetyPersistedState>,
}

impl MemorySafetySink {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn state(&self, pack_id: &str) -> Option<&SafetyPersistedState> {
        self.states.get(pack_id)
    }
}

impl SafetyStateSink for MemorySafetySink {
    fn load_state(&mut self, pack_id: &str) -> Result<Option<SafetyPersistedState>> {
        Ok(self.states.get(pack_id).cloned())
    }

    fn append_state(
        &mut self,
        pack_id: &str,
        state: &SafetyPersistedState,
        _now_ms: u64,
    ) -> Result<()> {
        self.states.insert(String::from(pack_id), state.clone());
        Ok(())
    }
}

/// 基于本地 SQLite 状态脊柱签名 HLC 事件的配额持久化（单调追加，跨重启可恢复）。
pub struct SpineSafetySink<'a, S: MaterializedStore> {
    spine: &'a mut SpineEngine<S>,
}

impl<'a, S: MaterializedStore> SpineSafetySink<'a, S> {
    #[must_use]
    pub fn new(spine: &'a mut SpineEngine<S>) -> Self {
        Self { spine }
    }
}

impl<S: MaterializedStore> SafetyStateSink for SpineSafetySink<'_, S> {
    fn load_state(&mut self, pack_id: &str) -> Result<Option<SafetyPersistedState>> {
        let events = self.spine.store().list_all_events()?;
        let mut latest: Option<SafetyPersistedState> = None;
        for (event, _) in events {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&event.payload_utf8) else {
                continue;
            };
            if value["schema"].as_str() != Some(SAFETY_STATE_SCHEMA) {
                continue;
            }
            if value["packId"].as_str() != Some(pack_id) {
                continue;
            }
            if let Ok(state) =
                serde_json::from_value::<SafetyPersistedState>(value["state"].clone())
            {
                latest = Some(state);
            }
        }
        Ok(latest)
    }

    fn append_state(
        &mut self,
        pack_id: &str,
        state: &SafetyPersistedState,
        now_ms: u64,
    ) -> Result<()> {
        let payload = serde_json::json!({
            "schema": SAFETY_STATE_SCHEMA,
            "packId": pack_id,
            "state": state,
        });
        let encoded =
            serde_json::to_string(&payload).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("编码安全配额状态事件失败: {e}"),
            })?;
        let _ = self
            .spine
            .append_event(PackCompartment::Core, &encoded, now_ms)?;
        Ok(())
    }
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

    /// 从持久化配额状态恢复（重启后绝不可重置监护人的硬上限）。
    pub fn restore(pack: &DomainPack, sink: &mut dyn SafetyStateSink) -> Result<Self> {
        let mut supervisor = Self::new(pack);
        if let Some(state) = sink.load_state(&pack.id)? {
            supervisor.channel_sends = state.channel_sends;
            supervisor.budget_spent_micros = state.budget_spent_micros;
            supervisor.journal = state.journal;
        }
        Ok(supervisor)
    }

    #[must_use]
    pub fn export_state(&self) -> SafetyPersistedState {
        SafetyPersistedState {
            pack_id: self.pack.id.clone(),
            channel_sends: self.channel_sends.clone(),
            budget_spent_micros: self.budget_spent_micros,
            journal: self.journal.clone(),
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
        if self.journal.len() > MAX_JOURNAL_EVENTS {
            let excess = self.journal.len() - MAX_JOURNAL_EVENTS;
            self.journal.drain(0..excess);
        }
        event
    }

    /// 外发总门禁：紧急告警穿越睡眠/预算抑制，例行消息受全部抑制器与配额约束；
    /// 每次裁决后把配额状态追加写入持久化端口（签名 HLC 事件）。
    pub fn route_outbound(
        &mut self,
        request: &OutboundRequest,
        ctx: &mut OutboundContext<'_>,
        sink: &mut dyn SafetyStateSink,
    ) -> Result<OutboundDecision> {
        let decision = match request.kind {
            OutboundKind::EmergencyAlert => self.route_emergency(request, ctx)?,
            OutboundKind::RoutineMessage => self.route_routine(request, ctx)?,
        };
        sink.append_state(&self.pack.id, &self.export_state(), ctx.now_ms)?;
        Ok(decision)
    }

    fn route_emergency(
        &mut self,
        request: &OutboundRequest,
        ctx: &mut OutboundContext<'_>,
    ) -> Result<OutboundDecision> {
        let policy = self.pack.safety_envelope.payload.emergency.clone();
        let recipient_cap = self
            .pack
            .safety_envelope
            .payload
            .outbound
            .max_recipients_per_message;
        let kind = SafetyEventKind::EmergencyAlert;

        if !policy.enabled {
            return Ok(self.suppress(
                kind,
                SuppressionReason::EmergencyDisabled,
                request,
                ctx.now_ms,
            ));
        }
        if policy.contacts.is_empty() {
            return Ok(self.suppress(
                kind,
                SuppressionReason::EmergencyContactsUnavailable,
                request,
                ctx.now_ms,
            ));
        }

        // 监护人只授权部分升级通道：未列出的通道一律拒绝（不得借任意通道外泄健康数据）
        if !policy
            .escalation_channels
            .iter()
            .any(|c| c == &request.channel_id)
        {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "紧急升级通道 `{}` 未经监护人安全信封授权（允许的 escalationChannels: {}）",
                    request.channel_id,
                    policy.escalation_channels.join(", ")
                ),
            });
        }
        // 收件人上限对紧急路径同样生效
        let recipients = u32::try_from(request.recipient_ids.len()).unwrap_or(u32::MAX);
        if recipients > recipient_cap {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("紧急告警收件人数 {recipients} 超过监护人信封上限 {recipient_cap}"),
            });
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
        let wake = ctx.heart.handle_wake_signal(ctx.local_hour, bypass);
        if !bypass && matches!(wake, WakeSignalResult::Suppressed { .. }) {
            return Ok(self.suppress(
                kind,
                SuppressionReason::SleepOrHostInhibition,
                request,
                ctx.now_ms,
            ));
        }
        let bypassed = matches!(
            wake,
            WakeSignalResult::Woken {
                emergency_bypass: true,
                ..
            }
        );

        let partition_local_only = ctx.lease == LeasePosture::PartitionLocal;
        if partition_local_only && !policy.allow_local_alert_under_partition {
            return Ok(self.suppress(
                kind,
                SuppressionReason::PartitionLocalPublicQueue,
                request,
                ctx.now_ms,
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
            .saturating_add(ctx.estimated_cost_micros);
        self.channel_sends
            .entry(request.channel_id.clone())
            .or_default()
            .push(ctx.now_ms);

        let detail = format!(
            "紧急告警已投递（通道={}，断网本地={}，睡眠/预算穿透={bypassed}）",
            request.channel_id, partition_local_only
        );
        let event = self.record(
            kind,
            outcome.as_journal_str(),
            Some(request),
            ctx.now_ms,
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
        ctx: &mut OutboundContext<'_>,
    ) -> Result<OutboundDecision> {
        let kind = SafetyEventKind::RoutineMessage;
        let payload = self.pack.safety_envelope.payload.clone();
        let now_ms = ctx.now_ms;

        if payload.outbound.quiet_hours.contains_hour(ctx.local_hour) {
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
            ctx.heart.handle_wake_signal(ctx.local_hour, false),
            WakeSignalResult::Suppressed { .. }
        ) {
            return Ok(self.suppress(
                kind,
                SuppressionReason::SleepOrHostInhibition,
                request,
                now_ms,
            ));
        }

        let recipients = u32::try_from(request.recipient_ids.len()).unwrap_or(u32::MAX);
        if recipients > payload.outbound.max_recipients_per_message {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "单条消息收件人数 {recipients} 超过监护人信封上限 {}",
                    payload.outbound.max_recipients_per_message
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
            .saturating_add(ctx.estimated_cost_micros)
            > payload.budget.ceiling_micros
        {
            return Ok(self.suppress(
                kind,
                SuppressionReason::BudgetCeilingExhausted,
                request,
                now_ms,
            ));
        }

        if ctx.lease == LeasePosture::PartitionLocal && request.is_non_idempotent_public {
            return Ok(self.suppress(
                kind,
                SuppressionReason::PartitionLocalPublicQueue,
                request,
                now_ms,
            ));
        }

        self.budget_spent_micros = self
            .budget_spent_micros
            .saturating_add(ctx.estimated_cost_micros);
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
