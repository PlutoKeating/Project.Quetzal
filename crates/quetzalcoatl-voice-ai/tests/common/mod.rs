#![allow(dead_code)]

//! 确定性合成音频夹具（零真实人声、零外部素材）。
//!
//! 所有信号由固定种子线性同余发生器与解析谐波合成器生成，跨平台逐样本可复现。

/// 16 kHz / 20 ms 帧长。
pub const FRAME_SAMPLES: usize = 320;
pub const SAMPLE_RATE: f32 = 16_000.0;

/// 确定性 64 位线性同余发生器（Knuth MMIX 常数）。
pub struct Lcg(u64);

impl Lcg {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u32(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 40) as u32
    }

    /// 均匀分布 `[-1.0, 1.0)`。
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() as f32 / 8_388_608.0) - 1.0
    }

    /// 近似高斯噪声（12 个均匀变量求和，Irwin–Hall）。
    pub fn next_gauss(&mut self) -> f32 {
        let mut acc = 0.0_f32;
        for _ in 0..12 {
            acc += self.next_f32();
        }
        acc * 0.5
    }
}

/// 解析式“类语音”发声器：基频谐波 + 4 Hz 音节包络 + 缓慢基频漂移。
///
/// 用于替代真实人声夹具；输出严格确定性且具有类语音的周期性与能量包络。
pub struct SpeechSynth {
    phase: f32,
    f0_hz: f32,
    amplitude: f32,
    sample_index: u64,
    active: bool,
}

impl SpeechSynth {
    pub fn new(f0_hz: f32, amplitude: f32) -> Self {
        Self {
            phase: 0.0,
            f0_hz,
            amplitude,
            sample_index: 0,
            active: true,
        }
    }

    pub fn set_active(&mut self, active: bool) {
        self.active = active;
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// 生成 320 个样本（20 ms）。
    pub fn next_frame(&mut self, out: &mut [f32; FRAME_SAMPLES]) {
        for sample in out.iter_mut() {
            if !self.active {
                *sample = 0.0;
                self.sample_index += 1;
                continue;
            }
            let t = self.sample_index as f32 / SAMPLE_RATE;
            // 4 Hz 音节包络，抬升到 [0.5, 1.0]，保留音节起伏但避免长段能量塌陷。
            let envelope = 0.75 + 0.25 * (core::f32::consts::TAU * 4.0 * t).sin();
            // 缓慢基频漂移（±6 Hz），保持局部周期性。
            let drift = 6.0 * (core::f32::consts::TAU * 0.7 * t).sin();
            let f0 = self.f0_hz + drift;
            self.phase += core::f32::consts::TAU * f0 / SAMPLE_RATE;
            if self.phase > core::f32::consts::TAU {
                self.phase -= core::f32::consts::TAU;
            }
            let harmonic = self.phase.sin()
                + 0.45 * (2.0 * self.phase).sin()
                + 0.22 * (3.0 * self.phase).sin();
            *sample = self.amplitude * envelope * harmonic / 1.67;
            self.sample_index += 1;
        }
    }
}

/// 扬声器→麦克风回声路径：固定延迟 + 线性衰减 + 低幅背景噪声。
pub struct EchoPath {
    delay_samples: usize,
    gain: f32,
    ring: Vec<f32>,
    cursor: usize,
    noise: Lcg,
}

impl EchoPath {
    pub fn new(delay_ms: u32, gain: f32, seed: u64) -> Self {
        let delay_samples = (SAMPLE_RATE * delay_ms as f32 / 1000.0) as usize;
        Self {
            delay_samples,
            gain,
            ring: vec![0.0; delay_samples.max(1)],
            cursor: 0,
            noise: Lcg::new(seed),
        }
    }

    /// 由远端渲染帧生成麦克风采集帧（回声 + 底噪）。
    pub fn capture_frame(
        &mut self,
        render: &[f32; FRAME_SAMPLES],
        near_end: &[f32; FRAME_SAMPLES],
        out: &mut [f32; FRAME_SAMPLES],
    ) {
        for (idx, sample) in out.iter_mut().enumerate() {
            let delayed = self.ring[self.cursor];
            self.ring[self.cursor] = render[idx];
            self.cursor = (self.cursor + 1) % self.ring.len();
            // 延迟 20 ms 帧粒度之外补一个样本级偏移，使 AEC 必须自估延迟。
            let echo = self.gain * delayed;
            *sample = echo + near_end[idx] + 1.5e-4 * self.noise.next_gauss();
        }
        let _ = self.delay_samples;
    }
}
