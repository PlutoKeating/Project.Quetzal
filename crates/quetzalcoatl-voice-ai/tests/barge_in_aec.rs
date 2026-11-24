#![forbid(unsafe_code)]
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing
)]

//! 回声消除不自激、150 ms 延迟真人插嘴识别与 ≥400 ms 持续打断语义（纯合成信号）。

mod common;

use common::{EchoPath, FRAME_SAMPLES, SpeechSynth};
use quetzalcoatl_voice_ai::aec_vad::{DuplexAudioGate, GateConfig, GateEvent};

struct Rig {
    gate: DuplexAudioGate,
    echo: EchoPath,
    render: SpeechSynth,
    near: SpeechSynth,
    frame_index: u64,
    decisions: Vec<quetzalcoatl_voice_ai::aec_vad::FrameDecision>,
}

impl Rig {
    fn new(echo_gain: f32) -> Self {
        Self::with_echo(EchoPath::linear(150, echo_gain, 0x5EED_0001))
    }

    fn with_echo(echo: EchoPath) -> Self {
        Self {
            gate: DuplexAudioGate::new(GateConfig::default()).expect("构造双工音频门"),
            echo,
            render: SpeechSynth::new(160.0, 0.42),
            near: SpeechSynth::new(233.0, 0.85),
            frame_index: 0,
            decisions: Vec::new(),
        }
    }

    /// 推进一帧：`near_end` 为近端人声是否激活。
    fn step(&mut self, near_end_active: bool, assistant_speaking: bool) {
        let mut render = [0.0_f32; FRAME_SAMPLES];
        let mut near = [0.0_f32; FRAME_SAMPLES];
        let mut capture = [0.0_f32; FRAME_SAMPLES];
        self.render.next_frame(&mut render);
        self.near.set_active(near_end_active);
        self.near.next_frame(&mut near);
        self.echo.capture_frame(&render, &near, &mut capture);
        let decision = self
            .gate
            .process_frame(&render, &capture, assistant_speaking)
            .expect("处理帧");
        self.decisions.push(decision);
        self.frame_index += 1;
    }

    fn run(&mut self, frames: usize, near_end_active: bool, assistant_speaking: bool) {
        for _ in 0..frames {
            self.step(near_end_active, assistant_speaking);
        }
    }

    fn speech_frames_since(&self, from: usize) -> usize {
        self.decisions[from..]
            .iter()
            .filter(|decision| decision.speech)
            .count()
    }

    fn barge_ins_since(
        &self,
        from: usize,
    ) -> Vec<(usize, quetzalcoatl_voice_ai::aec_vad::BargeInEvent)> {
        let mut out = Vec::new();
        for (offset, decision) in self.decisions[from..].iter().enumerate() {
            for event in &decision.events {
                if let GateEvent::BargeIn(payload) = event {
                    out.push((from + offset, *payload));
                }
            }
        }
        out
    }
}

/// 纯扬声器回环（含 150 ms 声学延迟与底噪）绝不自激为真人语音。
#[test]
fn mixed_loopback_echo_does_not_self_trigger() {
    let mut rig = Rig::new(0.55);
    // 2 s 收敛期，AEC 自适应回声路径。
    rig.run(100, false, true);
    let after_convergence = rig.decisions.len();
    // 再持续 4 s 纯回声。
    rig.run(200, false, true);

    assert_eq!(
        rig.speech_frames_since(after_convergence),
        0,
        "回声残余被误判为真人语音（自激）"
    );
    assert!(
        rig.barge_ins_since(after_convergence).is_empty(),
        "纯回声不得触发打断事件"
    );
    let max_probability = rig.decisions[after_convergence..]
        .iter()
        .map(|decision| decision.vad_probability)
        .fold(0.0_f32, f32::max);
    assert!(
        max_probability < 0.5,
        "回声期间 VAD 概率上界应低于 0.5，实际 {max_probability}"
    );
    assert!(
        rig.gate.echo_return_loss_db().abs() < 200.0,
        "AEC 必须给出有限 ERLE 估算"
    );
}

/// 150 ms 声学延迟下，真人语音必须在 150 ms 内被识别。
#[test]
fn real_speech_after_150ms_echo_latency_is_detected() {
    let mut rig = Rig::new(0.55);
    rig.run(100, false, true);
    let onset = rig.decisions.len();
    rig.run(50, true, true);

    let first_speech = rig.decisions[onset..]
        .iter()
        .position(|decision| decision.speech)
        .expect("150 ms 延迟的真人语音必须触发 VAD");
    assert!(
        first_speech <= 7,
        "检测延迟超过 150 ms（{first_speech} 帧 ≈ {} ms）",
        first_speech * 20
    );
}

/// 打断必须持续 ≥ 400 ms；短促 260 ms 插入不得触发。
#[test]
fn barge_in_requires_400ms_sustained_speech() {
    let mut rig = Rig::new(0.5);
    rig.run(100, false, true);

    // 两次 260 ms 短促插入，中间 300 ms 静默：不得打断。
    rig.run(13, true, true);
    rig.run(15, false, true);
    rig.run(13, true, true);
    rig.run(15, false, true);
    assert!(
        rig.barge_ins_since(100).is_empty(),
        "不足 400 ms 的短促语音不得触发打断"
    );

    // 持续 600 ms：必须在 ~400 ms 处触发一次且仅一次。
    let onset = rig.decisions.len();
    rig.run(30, true, true);
    let barge_ins = rig.barge_ins_since(onset);
    assert_eq!(barge_ins.len(), 1, "持续语音应恰好触发一次打断");

    let (absolute_frame, event) = &barge_ins[0];
    assert_eq!(
        *absolute_frame,
        onset + event.speech_run_frames - 1,
        "打断帧号必须等于语音起始帧 + 持续帧数 - 1"
    );
    assert!(
        (20..=22).contains(&event.speech_run_frames),
        "打断应在 400±40 ms 处确认，实际 {} ms",
        event.speech_run_frames * 20
    );
    assert!(
        (20..=22).contains(&event.interrupting_frame_offset),
        "打断帧偏移应在 400±40 ms，实际 {} 帧",
        event.interrupting_frame_offset
    );
}

/// 长时间纯回声（8 s）在任何时刻都不产生打断，语音结束后可重新触发。
#[test]
fn echo_only_never_barges_in_and_gate_rearms() {
    let mut rig = Rig::new(0.7);
    rig.run(100, false, true);
    rig.run(300, false, true);
    assert!(rig.barge_ins_since(0).is_empty(), "8 s 纯回声零打断");

    // 真人持续说话 700 ms -> 一次打断。
    rig.run(35, true, true);
    let first = rig.barge_ins_since(400);
    assert_eq!(first.len(), 1, "真人语音应触发一次打断");

    // 静默 500 ms 后再次说话：门必须重新武装。
    rig.run(25, false, true);
    rig.run(35, true, true);
    let all = rig.barge_ins_since(400);
    assert_eq!(all.len(), 2, "静默后 barge-in 门必须重新武装");
    assert!(all[1].0 > all[0].0 + 25, "两次打断之间必须有静默间隔");
}

/// 未处于播报状态时不得产生打断事件（仅记录语音起止）。
#[test]
fn no_barge_in_when_assistant_is_silent() {
    let mut rig = Rig::new(0.4);
    rig.run(100, false, false);
    rig.run(40, true, false);
    assert!(rig.barge_ins_since(0).is_empty());
    assert_eq!(rig.speech_frames_since(110), 30, "语音帧应被识别");
}

/// 软饱和（功放/扬声器非线性）回声路径不得自激，真人语音仍须打断。
#[test]
fn saturated_echo_path_does_not_self_trigger() {
    let mut rig = Rig::with_echo(EchoPath::saturated(150, 0.55, 0x5EED_0002, 2.6));
    rig.run(120, false, true);
    rig.run(250, false, true);
    assert!(
        rig.barge_ins_since(0).is_empty(),
        "软饱和回声不得在任何时刻触发打断"
    );
    assert_eq!(
        rig.speech_frames_since(50),
        0,
        "软饱和回声不得被识别为语音（含 AEC 收敛期后）"
    );

    let onset = rig.decisions.len();
    rig.run(40, true, true);
    assert!(
        !rig.barge_ins_since(onset).is_empty(),
        "软饱和路径下真人语音仍须触发打断"
    );
}

/// 回声路径增益中途 +6 dB 阶跃：AEC 重收敛后不得持续自激，真人语音仍须打断。
#[test]
fn echo_gain_step_does_not_self_trigger() {
    let mut rig = Rig::with_echo(EchoPath::linear(150, 0.55, 0x5EED_0003));
    rig.run(120, false, true);
    // +6 dB 阶跃，AEC3 需重新估计回声路径。
    rig.echo.set_gain(1.1);
    rig.run(250, false, true);
    assert!(
        rig.barge_ins_since(0).is_empty(),
        "增益 +6 dB 阶跃（含重收敛期）不得触发打断"
    );
    assert_eq!(rig.speech_frames_since(50), 0, "增益阶跃不得被识别为语音");

    let onset = rig.decisions.len();
    rig.run(40, true, true);
    assert!(
        !rig.barge_ins_since(onset).is_empty(),
        "增益阶跃后真人语音仍须触发打断"
    );
}

/// 短 FIR 混响尾（扬声器→墙面→麦克风）不得自激，真人语音仍须打断。
#[test]
fn reverberant_echo_path_does_not_self_trigger() {
    let gain = 0.5_f32;
    let taps = [1.0_f32, 0.45, 0.22, 0.11, 0.05];
    let mut rig = Rig::with_echo(EchoPath::reverberant(150, gain, 0x5EED_0004, &taps, 40));
    rig.run(140, false, true);
    rig.run(260, false, true);
    assert!(
        rig.barge_ins_since(0).is_empty(),
        "混响尾回声不得在任何时刻触发打断"
    );
    assert_eq!(rig.speech_frames_since(50), 0, "混响尾回声不得被识别为语音");

    let onset = rig.decisions.len();
    rig.run(40, true, true);
    assert!(
        !rig.barge_ins_since(onset).is_empty(),
        "混响路径下真人语音仍须触发打断"
    );
}

/// 非线性 + 混响 + 增益阶跃叠加的最坏合成路径：真人语音仍须在 ~400 ms 打断。
#[test]
fn genuine_speech_triggers_under_combined_nonlinear_reverb_echo() {
    let mut rig = Rig::with_echo(EchoPath::build(
        150,
        0.5,
        0x5EED_0005,
        Some(2.2),
        vec![1.0, 0.4, 0.18, 0.08],
        55,
    ));
    rig.run(120, false, true);
    rig.echo.set_gain(0.9);
    rig.run(40, false, true);

    let onset = rig.decisions.len();
    rig.run(40, true, true);
    let barge_ins = rig.barge_ins_since(onset);
    assert_eq!(
        barge_ins.len(),
        1,
        "叠加非线性/混响/增益阶跃后，持续真人语音仍须恰好打断一次"
    );
    assert!(
        (400..=480).contains(&(barge_ins[0].1.interrupting_frame_offset * 20)),
        "打断偏移应约为 400 ms，实际 {} ms",
        barge_ins[0].1.interrupting_frame_offset * 20
    );
}
