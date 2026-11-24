//! `quetzalcoatld` 可选声学语音门（`QUETZALCOATL_VOICE_AI=1` 时启用）。
//!
//! 事件以 `PackCompartment::Core` 签名脊柱事件写入与群组/良知审计同源的既有活动链路，
//! 不新增任何网络依赖；禁用时既不构造 AEC/VAD，也不写文件、不起线程。

use std::collections::BTreeMap;

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
