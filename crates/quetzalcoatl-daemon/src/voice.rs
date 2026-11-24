//! `quetzalcoatld` 可选声学语音门（`QUETZALCOATL_VOICE_AI=1` 时启用）。
//!
//! 事件以 `PackCompartment::Core` 签名脊柱事件写入与群组/良知审计同源的既有活动链路，
//! 不新增任何网络依赖；禁用时既不构造 AEC/VAD，也不写文件、不起线程。

use std::collections::{BTreeMap, VecDeque};
use std::fmt;

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use quetzalcoatl_voice_ai::aec_vad::{
    BargeInEvent, DuplexAudioGate, FRAME_LEN, GateConfig, GateEvent, SpeechEndEvent,
    SpeechStartEvent,
};

/// 启用声学语音门的 opt-in 环境变量。
pub const VOICE_AI_ENV: &str = "QUETZALCOATL_VOICE_AI";

/// 语音门配置快照。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct VoiceAiConfig {
    /// 仅在显式 `QUETZALCOATL_VOICE_AI=1` 时启用。
    pub enabled: bool,
}

impl VoiceAiConfig {
    /// 从纯环境映射解析（便于单测，不修改进程环境）。
    #[must_use]
    pub fn resolve(environment: &BTreeMap<String, String>) -> Self {
        let enabled = environment
            .get(VOICE_AI_ENV)
            .is_some_and(|value| value.trim() == "1");
        Self { enabled }
    }

    /// 从当前进程环境解析（只读）。
    #[must_use]
    pub fn from_process_env() -> Self {
        let enabled = std::env::var(VOICE_AI_ENV).is_ok_and(|value| value.trim() == "1");
        Self { enabled }
    }
}

/// 写入脊柱活动的单条语音事件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonVoiceEvent {
    pub kind: &'static str,
    pub frame_index: u64,
    pub duration_ms: Option<u32>,
    pub speech_run_ms: Option<u32>,
    pub interrupting_frame_offset_ms: Option<u32>,
}

impl DaemonVoiceEvent {
    /// 与既有活动链路同构的 JSON 载荷。
    #[must_use]
    pub fn spine_payload(&self) -> String {
        serde_json::json!({
            "kind": self.kind,
            "frame_index": self.frame_index,
            "duration_ms": self.duration_ms,
            "speech_run_ms": self.speech_run_ms,
            "interrupting_frame_offset_ms": self.interrupting_frame_offset_ms,
        })
        .to_string()
    }
}

/// 单帧声学判决报告。
#[derive(Clone, Debug, PartialEq)]
pub struct VoiceTurnReport {
    pub frame_index: u64,
    pub speech: bool,
    pub vad_probability: f32,
    pub noise_floor_db: f32,
    pub barge_in: bool,
    pub interrupting_frame_offset_ms: Option<u32>,
    pub events: Vec<DaemonVoiceEvent>,
}

impl VoiceTurnReport {
    /// 待写入脊柱的事件载荷（按产生顺序）。
    #[must_use]
    pub fn spine_payloads(&self) -> Vec<String> {
        self.events
            .iter()
            .map(DaemonVoiceEvent::spine_payload)
            .collect()
    }
}

/// `quetzalcoatld` 独占的语音活动运行态。
pub struct VoiceActivityRuntime {
    gate: DuplexAudioGate,
}

impl VoiceActivityRuntime {
    /// 构造默认配置的语音门。
    pub fn new() -> Result<Self> {
        Ok(Self {
            gate: DuplexAudioGate::new(GateConfig::default())?,
        })
    }

    /// 根据 opt-in 配置构造（禁用时返回 `None`，零副作用）。
    pub fn from_config(config: VoiceAiConfig) -> Result<Option<Self>> {
        if config.enabled {
            Self::new().map(Some)
        } else {
            Ok(None)
        }
    }

    /// 当前是否处于语音态。
    #[must_use]
    pub const fn speech_active(&self) -> bool {
        self.gate.is_speech_active()
    }

    /// 送入一帧（`render` = 助手播报参考，`capture` = 麦克风采集，均为 320 个 `f32`）。
    pub fn ingest(
        &mut self,
        render: &[f32],
        capture: &[f32],
        assistant_speaking: bool,
    ) -> Result<VoiceTurnReport> {
        let decision = self
            .gate
            .process_frame(render, capture, assistant_speaking)?;
        let mut events = Vec::with_capacity(decision.events.len());
        let mut barge_in = false;
        let mut interrupting_frame_offset_ms = None;
        for event in &decision.events {
            match event {
                GateEvent::SpeechStart(SpeechStartEvent { frame_index }) => {
                    events.push(DaemonVoiceEvent {
                        kind: "voice_speech_start",
                        frame_index: *frame_index,
                        duration_ms: None,
                        speech_run_ms: None,
                        interrupting_frame_offset_ms: None,
                    });
                }
                GateEvent::SpeechEnd(SpeechEndEvent {
                    frame_index,
                    duration_ms,
                }) => {
                    events.push(DaemonVoiceEvent {
                        kind: "voice_speech_end",
                        frame_index: *frame_index,
                        duration_ms: Some(*duration_ms),
                        speech_run_ms: None,
                        interrupting_frame_offset_ms: None,
                    });
                }
                GateEvent::BargeIn(BargeInEvent {
                    frame_index,
                    speech_run_frames,
                    interrupting_frame_offset,
                    ..
                }) => {
                    barge_in = true;
                    let run_ms = u32::try_from(*speech_run_frames).unwrap_or(u32::MAX) * 20;
                    let offset_ms =
                        u32::try_from(*interrupting_frame_offset).unwrap_or(u32::MAX) * 20;
                    interrupting_frame_offset_ms = Some(offset_ms);
                    events.push(DaemonVoiceEvent {
                        kind: "voice_barge_in",
                        frame_index: *frame_index,
                        duration_ms: None,
                        speech_run_ms: Some(run_ms),
                        interrupting_frame_offset_ms: Some(offset_ms),
                    });
                }
            }
        }
        Ok(VoiceTurnReport {
            frame_index: decision.frame_index,
            speech: decision.speech,
            vad_probability: decision.vad_probability,
            noise_floor_db: decision.noise_floor_db,
            barge_in,
            interrupting_frame_offset_ms,
            events,
        })
    }
}

/// 把 base64 小端 `f32` 帧解码为固定 320 样本。
pub fn decode_audio_frame(encoded: &str) -> Result<Vec<f32>> {
    let bytes = crate::group::base64_decode(encoded)?;
    if bytes.len() != FRAME_LEN * 4 {
        return Err(QuetzalcoatlError::SerializationError {
            detail: format!(
                "语音帧必须为 {} 字节小端 f32（320 样本），实际 {}",
                FRAME_LEN * 4,
                bytes.len()
            ),
        });
    }
    let mut samples = Vec::with_capacity(FRAME_LEN);
    let (chunks, remainder) = bytes.as_chunks::<4>();
    debug_assert!(remainder.is_empty());
    for chunk in chunks {
        samples.push(f32::from_le_bytes(*chunk));
    }
    Ok(samples)
}

/// 单进程并发语音流上限。
pub const MAX_VOICE_STREAMS: usize = 8;

/// 语音流键控错误（与通用存储错误分离，便于 IPC 精确映射）。
#[derive(Debug)]
pub enum VoiceStreamError {
    /// 流 ID 为空/超长/含控制字符。
    InvalidStreamId { detail: String },
    /// 流内帧序号必须从 0 开始严格连续；缺口或回退均拒绝。
    NonContiguousFrameSeq { expected: u64, actual: u64 },
    /// 声学门处理失败。
    Frame(QuetzalcoatlError),
    /// 脊柱活动写入失败（不得静默丢弃事件）。
    Spine(QuetzalcoatlError),
}

impl fmt::Display for VoiceStreamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidStreamId { detail } => write!(formatter, "非法语音流 ID: {detail}"),
            Self::NonContiguousFrameSeq { expected, actual } => write!(
                formatter,
                "语音流帧序号不连续: 期望 {expected} 实际 {actual}"
            ),
            Self::Frame(error) | Self::Spine(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for VoiceStreamError {}

impl From<QuetzalcoatlError> for VoiceStreamError {
    fn from(error: QuetzalcoatlError) -> Self {
        Self::Frame(error)
    }
}

struct VoiceStreamState {
    runtime: VoiceActivityRuntime,
    last_frame_seq: Option<u64>,
}

/// 按客户端 `stream_id` 隔离的多流语音门集合（有界 LRU）。
pub struct VoiceActivitySessions {
    streams: BTreeMap<String, VoiceStreamState>,
    order: VecDeque<String>,
    max_streams: usize,
}

impl VoiceActivitySessions {
    /// 构造最多 `max_streams` 条并发流的会话集合。
    pub fn new(max_streams: usize) -> Result<Self> {
        if max_streams == 0 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("语音流上限必须 ≥ 1"),
            });
        }
        Ok(Self {
            streams: BTreeMap::new(),
            order: VecDeque::new(),
            max_streams,
        })
    }

    /// 根据 opt-in 配置构造（禁用时返回 `None`，零状态零副作用）。
    pub fn from_config(config: VoiceAiConfig) -> Result<Option<Self>> {
        if config.enabled {
            Self::new(MAX_VOICE_STREAMS).map(Some)
        } else {
            Ok(None)
        }
    }

    /// 当前活跃流数量。
    #[must_use]
    pub fn stream_count(&self) -> usize {
        self.streams.len()
    }

    /// 指定流是否仍在集合中。
    #[must_use]
    pub fn contains_stream(&self, stream_id: &str) -> bool {
        self.streams.contains_key(stream_id)
    }

    fn validate_stream_id(stream_id: &str) -> std::result::Result<(), VoiceStreamError> {
        let valid = !stream_id.is_empty()
            && stream_id.len() <= 128
            && !stream_id.chars().any(char::is_control);
        if valid {
            Ok(())
        } else {
            Err(VoiceStreamError::InvalidStreamId {
                detail: String::from("流 ID 长度必须为 1..=128 且不得包含控制字符"),
            })
        }
    }

    fn touch(&mut self, stream_id: &str) {
        self.order.retain(|existing| existing != stream_id);
        self.order.push_back(stream_id.to_string());
    }

    /// 送入一帧：每流独立 AEC/VAD 状态，帧序号必须严格连续。
    pub fn ingest(
        &mut self,
        stream_id: &str,
        frame_seq: u64,
        render: &[f32],
        capture: &[f32],
        assistant_speaking: bool,
    ) -> std::result::Result<VoiceTurnReport, VoiceStreamError> {
        Self::validate_stream_id(stream_id)?;
        // 先校验帧序号，再注册/逐出：畸形首帧不得让其他客户端丢失 AEC 状态。
        if !self.streams.contains_key(stream_id) && frame_seq != 0 {
            return Err(VoiceStreamError::NonContiguousFrameSeq {
                expected: 0,
                actual: frame_seq,
            });
        }
        if !self.streams.contains_key(stream_id) {
            while self.streams.len() >= self.max_streams {
                let Some(evicted) = self.order.pop_front() else {
                    break;
                };
                self.streams.remove(&evicted);
            }
            let runtime = VoiceActivityRuntime::new().map_err(VoiceStreamError::Frame)?;
            self.streams.insert(
                stream_id.to_string(),
                VoiceStreamState {
                    runtime,
                    last_frame_seq: None,
                },
            );
        }
        self.touch(stream_id);

        let state =
            self.streams
                .get_mut(stream_id)
                .ok_or_else(|| VoiceStreamError::InvalidStreamId {
                    detail: String::from("语音流状态缺失"),
                })?;
        let expected = state
            .last_frame_seq
            .map_or(0, |last| last.saturating_add(1));
        if frame_seq != expected {
            return Err(VoiceStreamError::NonContiguousFrameSeq {
                expected,
                actual: frame_seq,
            });
        }
        let report = state
            .runtime
            .ingest(render, capture, assistant_speaking)
            .map_err(VoiceStreamError::Frame)?;
        state.last_frame_seq = Some(frame_seq);
        Ok(report)
    }

    /// 处理一帧并把语音活动事件写入脊柱；任何发布失败都上抛。
    pub fn ingest_and_publish(
        &mut self,
        stream_id: &str,
        frame_seq: u64,
        render: &[f32],
        capture: &[f32],
        assistant_speaking: bool,
        mut publish: impl FnMut(&str) -> Result<()>,
    ) -> std::result::Result<VoiceTurnReport, VoiceStreamError> {
        let report = self.ingest(stream_id, frame_seq, render, capture, assistant_speaking)?;
        for payload in report.spine_payloads() {
            publish(&payload).map_err(VoiceStreamError::Spine)?;
        }
        Ok(report)
    }
}
