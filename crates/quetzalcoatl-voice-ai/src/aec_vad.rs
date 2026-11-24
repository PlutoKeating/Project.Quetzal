//! 双工声学门：`sonora-aec3` 回声消除 + 常量折叠 16 kHz VAD + 声学打断语义。

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use sonora_aec3::block::Block;
use sonora_aec3::block_processor::BlockProcessor;
use sonora_aec3::common::num_bands_for_rate;
use sonora_aec3::config::EchoCanceller3Config;

use crate::onnx_graph::{FRAME_MS, FRAME_SAMPLES, folded_probability};

/// 采样率（16 kHz 单声道）。
pub const SAMPLE_RATE_HZ: u32 = 16_000;
/// 帧长（样本数，20 ms）。
pub const FRAME_LEN: usize = FRAME_SAMPLES;
/// AEC3 处理块（64 样本 = 4 ms）。
pub const AEC_BLOCK_LEN: usize = 64;

/// 自适应底噪下限（dBFS）。
const FLOOR_FLOOR_DB: f32 = -95.0;
/// 自适应底噪上限（dBFS）。
const FLOOR_CEIL_DB: f32 = -12.0;

/// 声学门配置。
#[derive(Clone, Debug, PartialEq)]
pub struct GateConfig {
    /// 打断所需的持续语音时长（毫秒，默认 400）。
    pub barge_in_ms: u32,
    /// VAD 概率判决阈值。
    pub speech_threshold: f32,
    /// 语音起始确认帧数（防单帧抖动）。
    pub onset_confirm_frames: u32,
    /// 语音结束挂起（毫秒），用于起止事件而不影响打断计数。
    pub speech_end_hangover_ms: u32,
    /// 启动期自适应底噪校准窗口（毫秒），窗口内不产生任何事件。
    pub warmup_ms: u32,
    /// 打断持续计数允许的语音间歇帧数（200 ms 以内的音节间隙不打断连续性）。
    pub barge_in_gap_frames: u32,
    /// 是否启用 AEC3（关闭时仅做 VAD，供无回声场景使用）。
    pub echo_cancellation: bool,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            barge_in_ms: 400,
            speech_threshold: 0.55,
            onset_confirm_frames: 2,
            speech_end_hangover_ms: 300,
            warmup_ms: 1000,
            barge_in_gap_frames: 10,
            echo_cancellation: true,
        }
    }
}

/// 语音起始事件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpeechStartEvent {
    pub frame_index: u64,
}

/// 语音结束事件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpeechEndEvent {
    pub frame_index: u64,
    pub duration_ms: u32,
}

/// 打断事件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BargeInEvent {
    /// 确认打断时的绝对帧号。
    pub frame_index: u64,
    /// 确认打断时已持续的语音帧数（含当前帧）。
    pub speech_run_frames: usize,
    /// 打断帧相对语音起始帧的偏移（帧数，含当前帧）。
    pub interrupting_frame_offset: usize,
    /// 语音起始的绝对帧号。
    pub speech_onset_frame: u64,
}

/// 声学门事件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateEvent {
    SpeechStart(SpeechStartEvent),
    SpeechEnd(SpeechEndEvent),
    BargeIn(BargeInEvent),
}

/// 单帧判决结果。
#[derive(Clone, Debug, PartialEq)]
pub struct FrameDecision {
    pub frame_index: u64,
    /// 常量折叠 VAD 输出的语音概率。
    pub vad_probability: f32,
    /// 当前是否处于语音（含挂起）。
    pub speech: bool,
    /// 当前自适应底噪（dBFS）。
    pub noise_floor_db: f32,
    /// AEC3 估算的回声返回损耗增强（dB）。
    pub echo_return_loss_db: f32,
    /// 本帧产生的事件。
    pub events: Vec<GateEvent>,
}

/// 双工音频门（1 Agent = 1 独占实例）。
pub struct DuplexAudioGate {
    config: GateConfig,
    aec: Option<BlockProcessor>,
    frame_index: u64,
    warmup_frames: u64,
    warmup_seen: bool,
    noise_floor_db: f32,
    probability: f32,
    voiced: bool,
    onset_run: u32,
    speech_active: bool,
    speech_started_frame: u64,
    hangover_left: u32,
    barge_start: Option<u64>,
    barge_gap: u32,
    barge_armed: bool,
    barge_frames: usize,
    echo_return_loss_db: f32,
}

impl DuplexAudioGate {
    /// 构造声学门；配置非法时返回 `IntegrityViolation`。
    pub fn new(config: GateConfig) -> Result<Self> {
        if !(0.0..1.0).contains(&config.speech_threshold) || config.speech_threshold <= 0.0 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("VAD 概率阈值必须位于 (0, 1)"),
            });
        }
        if config.onset_confirm_frames == 0 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("语音起始确认帧数必须 ≥ 1"),
            });
        }
        if config.barge_in_ms == 0 || !config.barge_in_ms.is_multiple_of(FRAME_MS) {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!("打断时长必须是 {FRAME_MS} ms 的整数倍"),
            });
        }
        if config.warmup_ms < 2 * FRAME_MS {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("底噪校准窗口不得短于 40 ms"),
            });
        }
        let aec = config.echo_cancellation.then(Self::build_aec);
        Ok(Self {
            warmup_frames: u64::from(config.warmup_ms / FRAME_MS),
            barge_frames: (config.barge_in_ms / FRAME_MS) as usize,
            hangover_left: 0,
            config,
            aec,
            frame_index: 0,
            warmup_seen: false,
            noise_floor_db: -60.0,
            probability: 0.0,
            voiced: false,
            onset_run: 0,
            speech_active: false,
            speech_started_frame: 0,
            barge_start: None,
            barge_gap: 0,
            barge_armed: true,
            echo_return_loss_db: 0.0,
        })
    }

    fn build_aec() -> BlockProcessor {
        let config = EchoCanceller3Config::default();
        let mut processor = BlockProcessor::new(&config, SAMPLE_RATE_HZ as usize, 1, 1);
        processor.set_capture_output_usage(true);
        processor
    }

    /// 配置快照。
    #[must_use]
    pub const fn config(&self) -> &GateConfig {
        &self.config
    }

    /// 当前自适应底噪（dBFS）。
    #[must_use]
    pub const fn noise_floor_db(&self) -> f32 {
        self.noise_floor_db
    }

    /// AEC3 回声返回损耗增强（dB）。
    #[must_use]
    pub const fn echo_return_loss_db(&self) -> f32 {
        self.echo_return_loss_db
    }

    /// 当前是否处于语音态（含挂起）。
    #[must_use]
    pub const fn is_speech_active(&self) -> bool {
        self.speech_active
    }

    /// 重置所有自适应状态（新会话/音频设备切换时调用）。
    pub fn reset(&mut self) {
        self.aec = self.config.echo_cancellation.then(Self::build_aec);
        self.frame_index = 0;
        self.warmup_seen = false;
        self.noise_floor_db = -60.0;
        self.probability = 0.0;
        self.voiced = false;
        self.onset_run = 0;
        self.speech_active = false;
        self.speech_started_frame = 0;
        self.hangover_left = 0;
        self.barge_start = None;
        self.barge_gap = 0;
        self.barge_armed = true;
        self.echo_return_loss_db = 0.0;
    }

    /// 处理一帧（`render` 为扬声器参考，`capture` 为麦克风采集）。
    ///
    /// `assistant_speaking` 为真时，持续 ≥ `barge_in_ms` 的真人语音会触发 [`GateEvent::BargeIn`]。
    pub fn process_frame(
        &mut self,
        render: &[f32],
        capture: &[f32],
        assistant_speaking: bool,
    ) -> Result<FrameDecision> {
        if render.len() != FRAME_LEN || capture.len() != FRAME_LEN {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "双工帧长必须为 {FRAME_LEN} 样本（20 ms @16 kHz），实际 render={} capture={}",
                    render.len(),
                    capture.len()
                ),
            });
        }

        let residual = self.cancel_echo(render, capture);
        let edb = frame_energy_db(&residual);
        self.update_noise_floor(edb);
        self.probability = folded_probability(&residual, self.noise_floor_db);

        let in_warmup = self.frame_index < self.warmup_frames;
        let voiced = !in_warmup && self.probability >= self.config.speech_threshold;
        self.voiced = voiced;

        let mut events = Vec::new();
        self.update_speech_state(voiced, in_warmup, &mut events);
        self.update_barge_in(voiced, assistant_speaking, &mut events);

        let decision = FrameDecision {
            frame_index: self.frame_index,
            vad_probability: self.probability,
            speech: self.speech_active,
            noise_floor_db: self.noise_floor_db,
            echo_return_loss_db: self.echo_return_loss_db,
            events,
        };
        self.frame_index += 1;
        Ok(decision)
    }

    fn cancel_echo(&mut self, render: &[f32], capture: &[f32]) -> [f32; FRAME_LEN] {
        let Some(processor) = self.aec.as_mut() else {
            let mut passthrough = [0.0_f32; FRAME_LEN];
            passthrough.copy_from_slice(capture);
            return passthrough;
        };
        let num_bands = num_bands_for_rate(SAMPLE_RATE_HZ as usize);
        let mut residual = [0.0_f32; FRAME_LEN];
        for block_index in 0..FRAME_LEN / AEC_BLOCK_LEN {
            let offset = block_index * AEC_BLOCK_LEN;
            let mut render_block = Block::new(num_bands, 1);
            render_block
                .view_mut(0, 0)
                .copy_from_slice(&render[offset..offset + AEC_BLOCK_LEN]);
            processor.buffer_render(&render_block);

            let mut capture_block = Block::new(num_bands, 1);
            capture_block
                .view_mut(0, 0)
                .copy_from_slice(&capture[offset..offset + AEC_BLOCK_LEN]);
            processor.process_capture(false, false, None, &mut capture_block);
            residual[offset..offset + AEC_BLOCK_LEN].copy_from_slice(capture_block.view(0, 0));
        }
        self.echo_return_loss_db = processor.get_metrics().echo_return_loss_enhancement as f32;
        residual
    }

    fn update_noise_floor(&mut self, edb: f32) {
        if self.frame_index < self.warmup_frames {
            // 校准窗口内用指数滑动平均估计稳态底噪（回声在 150 ms 后才到达，
            // 单取最小值会把“回声尚未到达的静音”误当成底噪）。
            if self.warmup_seen {
                self.noise_floor_db = 0.85 * self.noise_floor_db + 0.15 * edb;
            } else {
                self.noise_floor_db = edb;
                self.warmup_seen = true;
            }
            self.noise_floor_db = self.noise_floor_db.clamp(FLOOR_FLOOR_DB, FLOOR_CEIL_DB);
            return;
        }
        if edb < self.noise_floor_db {
            // 能量下降立即跟随（房间变安静 / AEC 收敛）。
            self.noise_floor_db = edb.clamp(FLOOR_FLOOR_DB, FLOOR_CEIL_DB);
        } else {
            // 缓慢上升，避免把人声自适应成底噪。
            self.noise_floor_db = (self.noise_floor_db + 0.02)
                .min(edb)
                .clamp(FLOOR_FLOOR_DB, FLOOR_CEIL_DB);
        }
    }

    fn update_speech_state(&mut self, voiced: bool, in_warmup: bool, events: &mut Vec<GateEvent>) {
        if in_warmup {
            return;
        }
        if voiced {
            self.onset_run = self.onset_run.saturating_add(1);
            self.hangover_left = self.config.speech_end_hangover_ms / FRAME_MS;
            if !self.speech_active && self.onset_run >= self.config.onset_confirm_frames {
                self.speech_active = true;
                self.speech_started_frame = self.frame_index + 1
                    - u64::from(self.onset_run.min(self.config.onset_confirm_frames));
                events.push(GateEvent::SpeechStart(SpeechStartEvent {
                    frame_index: self.speech_started_frame,
                }));
            }
        } else {
            self.onset_run = 0;
            if self.speech_active {
                if self.hangover_left > 0 {
                    self.hangover_left -= 1;
                } else {
                    self.speech_active = false;
                    let duration_ms =
                        (self.frame_index - self.speech_started_frame) as u32 * FRAME_MS;
                    events.push(GateEvent::SpeechEnd(SpeechEndEvent {
                        frame_index: self.frame_index,
                        duration_ms,
                    }));
                }
            }
        }
    }

    fn update_barge_in(
        &mut self,
        voiced: bool,
        assistant_speaking: bool,
        events: &mut Vec<GateEvent>,
    ) {
        if !assistant_speaking {
            self.barge_start = None;
            self.barge_gap = 0;
            self.barge_armed = true;
            return;
        }
        if voiced {
            self.barge_gap = 0;
            let start = *self.barge_start.get_or_insert(self.frame_index);
            if self.barge_armed {
                let elapsed = (self.frame_index - start + 1) as usize;
                if elapsed >= self.barge_frames {
                    events.push(GateEvent::BargeIn(BargeInEvent {
                        frame_index: self.frame_index,
                        speech_run_frames: elapsed,
                        interrupting_frame_offset: elapsed,
                        speech_onset_frame: start,
                    }));
                    self.barge_armed = false;
                }
            }
        } else if self.barge_start.is_some() {
            self.barge_gap += 1;
            if self.barge_gap > self.config.barge_in_gap_frames {
                self.barge_start = None;
                self.barge_gap = 0;
                self.barge_armed = true;
            }
        } else {
            self.barge_armed = true;
        }
    }
}

fn frame_energy_db(frame: &[f32]) -> f32 {
    let mut sum = 0.0_f32;
    for sample in frame {
        sum += sample * sample;
    }
    let mean = sum / frame.len().max(1) as f32;
    // 20*log10(sqrt(mean)) = 10*log10(mean)
    10.0 * (mean.max(1e-12)).log10()
}
