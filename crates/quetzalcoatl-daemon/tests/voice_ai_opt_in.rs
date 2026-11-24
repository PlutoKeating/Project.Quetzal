#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! `quetzalcoatld` 声学语音门的 opt-in 语义、确定性合成信号与脊柱事件映射。

use std::collections::BTreeMap;

use quetzalcoatl_daemon::voice::{
    VOICE_AI_ENV, VoiceActivityRuntime, VoiceAiConfig, decode_audio_frame,
};
use quetzalcoatl_voice_ai::aec_vad::FRAME_LEN;

struct Synth {
    phase: f32,
    f0: f32,
    amp: f32,
    sample: u64,
}

impl Synth {
    fn new(f0: f32, amp: f32) -> Self {
        Self {
            phase: 0.0,
            f0,
            amp,
            sample: 0,
        }
    }

    fn next_frame(&mut self) -> [f32; FRAME_LEN] {
        let mut frame = [0.0_f32; FRAME_LEN];
        for sample in frame.iter_mut() {
            let t = self.sample as f32 / 16_000.0;
            let envelope = 0.75 + 0.25 * (core::f32::consts::TAU * 4.0 * t).sin();
            self.phase += core::f32::consts::TAU * self.f0 / 16_000.0;
            if self.phase > core::f32::consts::TAU {
                self.phase -= core::f32::consts::TAU;
            }
            *sample = self.amp * envelope * self.phase.sin();
            self.sample += 1;
        }
        frame
    }
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

#[test]
fn voice_ai_is_strictly_opt_in() {
    assert_eq!(VoiceAiConfig::default(), VoiceAiConfig { enabled: false });
    assert!(!VoiceAiConfig::resolve(&env(&[])).enabled);
    assert!(!VoiceAiConfig::resolve(&env(&[(VOICE_AI_ENV, "0")])).enabled);
    assert!(!VoiceAiConfig::resolve(&env(&[(VOICE_AI_ENV, "true")])).enabled);
    assert!(!VoiceAiConfig::resolve(&env(&[(VOICE_AI_ENV, "")])).enabled);
    assert!(VoiceAiConfig::resolve(&env(&[(VOICE_AI_ENV, "1")])).enabled);

    assert!(
        VoiceActivityRuntime::from_config(VoiceAiConfig { enabled: false })
            .expect("禁用配置")
            .is_none(),
        "禁用时不得构造任何 AEC/VAD 运行态"
    );
    assert!(
        VoiceActivityRuntime::from_config(VoiceAiConfig { enabled: true })
            .expect("启用配置")
            .is_some()
    );
}

#[test]
fn echo_only_frames_produce_no_activity_events() {
    let mut runtime = VoiceActivityRuntime::new().expect("语音门");
    let mut render = Synth::new(160.0, 0.42);
    let mut delay = vec![0.0_f32; 2400];
    let mut cursor = 0_usize;
    for _ in 0..160 {
        let playback = render.next_frame();
        let mut capture = [0.0_f32; FRAME_LEN];
        for index in 0..FRAME_LEN {
            let delayed = delay[cursor];
            delay[cursor] = playback[index];
            cursor = (cursor + 1) % delay.len();
            capture[index] = 0.55 * delayed;
        }
        let report = runtime
            .ingest(&playback, &capture, true)
            .expect("处理回声帧");
        assert!(!report.barge_in, "纯回声不得触发打断");
        assert!(
            report.events.is_empty(),
            "纯回声不得产生语音活动事件: {:?}",
            report.events
        );
    }
}

#[test]
fn near_end_speech_emits_barge_in_event_into_spine_payloads() {
    let mut runtime = VoiceActivityRuntime::new().expect("语音门");
    let mut render = Synth::new(160.0, 0.42);
    let mut near = Synth::new(233.0, 0.62);
    let mut delay = vec![0.0_f32; 2400];
    let mut cursor = 0_usize;
    let mut barge_in = None;
    for frame in 0..170_u32 {
        let playback = render.next_frame();
        let near_frame = near.next_frame();
        let mut capture = [0.0_f32; FRAME_LEN];
        for index in 0..FRAME_LEN {
            let delayed = delay[cursor];
            delay[cursor] = playback[index];
            cursor = (cursor + 1) % delay.len();
            let near_end = if (100..140).contains(&frame) {
                near_frame[index]
            } else {
                0.0
            };
            capture[index] = 0.55 * delayed + near_end;
        }
        let report = runtime
            .ingest(&playback, &capture, true)
            .expect("处理语音帧");
        if report.barge_in {
            barge_in = Some(report.clone());
            break;
        }
    }
    let report = barge_in.expect("持续真人语音必须打断助手播报");
    let offset_ms = report
        .interrupting_frame_offset_ms
        .expect("打断事件必须带帧偏移");
    assert!(
        (400..=460).contains(&offset_ms),
        "打断偏移应约为 400 ms，实际 {offset_ms} ms"
    );
    let payloads = report.spine_payloads();
    assert_eq!(payloads.len(), 1);
    let payload: serde_json::Value = serde_json::from_str(&payloads[0]).expect("事件 JSON");
    assert_eq!(payload["kind"], "voice_barge_in");
    assert_eq!(payload["interrupting_frame_offset_ms"], offset_ms);
}

#[test]
fn audio_frame_decoding_is_strict() {
    let raw: Vec<u8> = (0..FRAME_LEN)
        .flat_map(|index| (index as f32 * 0.5).to_le_bytes())
        .collect();
    let encoded = quetzalcoatl_daemon::group::base64_encode(&raw);
    let decoded = decode_audio_frame(&encoded).expect("合法帧");
    assert_eq!(decoded.len(), FRAME_LEN);
    assert_eq!(decoded[3], 1.5);

    let bad = quetzalcoatl_daemon::group::base64_encode(&[0_u8; 8]);
    let error = decode_audio_frame(&bad).expect_err("短帧必须拒绝");
    assert!(matches!(
        error,
        quetzalcoatl_types::QuetzalcoatlError::SerializationError { .. }
    ));
}

use quetzalcoatl_daemon::voice::{VoiceActivitySessions, VoiceStreamError};

/// 单流合成夹具：render 恒定为助手播报，near 可选激活。
struct Sim {
    render: Synth,
    near: Synth,
    delay: Vec<f32>,
    cursor: usize,
    frame_seq: u64,
}

impl Sim {
    fn new() -> Self {
        Self {
            render: Synth::new(160.0, 0.42),
            near: Synth::new(233.0, 0.62),
            delay: vec![0.0_f32; 2400],
            cursor: 0,
            frame_seq: 0,
        }
    }

    fn step(
        &mut self,
        sessions: &mut VoiceActivitySessions,
        stream_id: &str,
        near_active: bool,
    ) -> quetzalcoatl_daemon::voice::VoiceTurnReport {
        let playback = self.render.next_frame();
        let near_frame = self.near.next_frame();
        let mut capture = [0.0_f32; FRAME_LEN];
        for index in 0..FRAME_LEN {
            let delayed = self.delay[self.cursor];
            self.delay[self.cursor] = playback[index];
            self.cursor = (self.cursor + 1) % self.delay.len();
            capture[index] = 0.55 * delayed + if near_active { near_frame[index] } else { 0.0 };
        }
        let report = sessions
            .ingest(stream_id, self.frame_seq, &playback, &capture, true)
            .expect("处理帧");
        self.frame_seq += 1;
        report
    }
}

/// 两个交错流必须各自维护独立的 AEC/VAD 状态与帧序号。
#[test]
fn interleaved_streams_keep_independent_state() {
    let mut sessions = VoiceActivitySessions::new(4).expect("会话集");
    let mut left = Sim::new();
    let mut right = Sim::new();

    // 两流同时经历 AEC 收敛期（纯回声）。
    for _ in 0..120 {
        let a = left.step(&mut sessions, "left", false);
        let b = right.step(&mut sessions, "right", false);
        assert!(!a.barge_in && !b.barge_in);
    }
    assert_eq!(left.frame_seq, right.frame_seq, "独立流序号各自推进");

    // 仅 left 出现真人语音：只有 left 触发打断。
    let mut left_barge = false;
    let mut right_barge = false;
    for _ in 0..45 {
        left_barge |= left.step(&mut sessions, "left", true).barge_in;
        right_barge |= right.step(&mut sessions, "right", false).barge_in;
    }
    assert!(left_barge, "left 流真人语音必须打断");
    assert!(!right_barge, "right 流纯回声不得被 left 的语音影响");

    // 反向验证：right 流随后说话仍可独立触发。
    let mut right_barge = false;
    for _ in 0..45 {
        let _ = left.step(&mut sessions, "left", false);
        right_barge |= right.step(&mut sessions, "right", true).barge_in;
    }
    assert!(right_barge, "right 流必须拥有独立的打断门");
}

/// `frame_seq` 必须从 0 开始严格连续；缺口/回退必须返回类型化错误。
#[test]
fn non_contiguous_frame_seq_is_rejected() {
    let mut sessions = VoiceActivitySessions::new(2).expect("会话集");
    let frame = [0.0_f32; FRAME_LEN];
    sessions
        .ingest("mic", 0, &frame, &frame, true)
        .expect("首帧 seq=0");
    let error = sessions
        .ingest("mic", 2, &frame, &frame, true)
        .expect_err("缺口必须拒绝");
    match error {
        VoiceStreamError::NonContiguousFrameSeq { expected, actual } => {
            assert_eq!((expected, actual), (1, 2));
        }
        other => panic!("意外错误: {other:?}"),
    }
    sessions
        .ingest("mic", 1, &frame, &frame, true)
        .expect("错误后正确的 seq=1 仍可继续");

    let error = sessions
        .ingest("mic", 1, &frame, &frame, true)
        .expect_err("回退/重复必须拒绝");
    assert!(matches!(
        error,
        VoiceStreamError::NonContiguousFrameSeq {
            expected: 2,
            actual: 1
        }
    ));

    let error = sessions
        .ingest("mic-2", 5, &frame, &frame, true)
        .expect_err("新流必须从 0 开始");
    assert!(matches!(
        error,
        VoiceStreamError::NonContiguousFrameSeq { expected: 0, .. }
    ));
    assert!(!sessions.contains_stream("mic-2"), "畸形首帧不得注册新流");
}

/// 流数量必须有界：超过上限按 LRU 逐出最久未用的流。
#[test]
fn stream_count_is_bounded_with_lru_eviction() {
    let mut sessions = VoiceActivitySessions::new(2).expect("会话集");
    let frame = [0.0_f32; FRAME_LEN];
    sessions.ingest("a", 0, &frame, &frame, false).expect("a");
    sessions.ingest("b", 0, &frame, &frame, false).expect("b");
    assert_eq!(sessions.stream_count(), 2);

    // 畸形首帧（seq=5）必须先被拒绝，绝不能先逐出 a/b 再失败。
    let error = sessions
        .ingest("c", 5, &frame, &frame, false)
        .expect_err("新流非 0 首帧必须拒绝");
    assert!(matches!(
        error,
        VoiceStreamError::NonContiguousFrameSeq {
            expected: 0,
            actual: 5
        }
    ));
    assert_eq!(sessions.stream_count(), 2, "畸形首帧不得改变流集合");
    assert!(
        sessions.contains_stream("a") && sessions.contains_stream("b"),
        "畸形首帧不得逐出既有流的 AEC 状态"
    );

    sessions.ingest("c", 0, &frame, &frame, false).expect("c");
    assert_eq!(sessions.stream_count(), 2, "流数不得超过上限");
    assert!(!sessions.contains_stream("a"), "最久未用的 a 必须被逐出");
    assert!(sessions.contains_stream("b") && sessions.contains_stream("c"));

    // 被逐出的流再次出现视为新流，可从 seq=0 重新开始。
    sessions
        .ingest("a", 0, &frame, &frame, false)
        .expect("逐出后重新建立");
    assert!(sessions.contains_stream("a"));
    assert!(!sessions.contains_stream("b"), "LRU 顺序必须更新");
}

/// 脊柱发布失败必须上抛，不得静默丢弃事件。
#[test]
fn spine_publish_errors_are_propagated() {
    let mut sessions = VoiceActivitySessions::new(2).expect("会话集");
    let mut sim = Sim::new();
    for _ in 0..120 {
        let playback = sim.render.next_frame();
        let mut capture = [0.0_f32; FRAME_LEN];
        for index in 0..FRAME_LEN {
            let delayed = sim.delay[sim.cursor];
            sim.delay[sim.cursor] = playback[index];
            sim.cursor = (sim.cursor + 1) % sim.delay.len();
            capture[index] = 0.55 * delayed;
        }
        sessions
            .ingest("mic", sim.frame_seq, &playback, &capture, true)
            .expect("回声帧");
        sim.frame_seq += 1;
    }

    let mut published = 0usize;
    let mut last_error = None;
    for _ in 0..45 {
        let playback = sim.render.next_frame();
        let near_frame = sim.near.next_frame();
        let mut capture = [0.0_f32; FRAME_LEN];
        for index in 0..FRAME_LEN {
            let delayed = sim.delay[sim.cursor];
            sim.delay[sim.cursor] = playback[index];
            sim.cursor = (sim.cursor + 1) % sim.delay.len();
            capture[index] = 0.55 * delayed + near_frame[index];
        }
        let outcome = sessions.ingest_and_publish(
            "mic",
            sim.frame_seq,
            &playback,
            &capture,
            true,
            |_payload| {
                published += 1;
                Err(quetzalcoatl_types::QuetzalcoatlError::StorageError {
                    detail: String::from("脊柱封存失败"),
                })
            },
        );
        sim.frame_seq += 1;
        if let Err(VoiceStreamError::Spine(error)) = outcome {
            last_error = Some(error);
            break;
        }
    }
    let error = last_error.expect("发布失败必须作为类型化错误上抛");
    assert!(matches!(
        error,
        quetzalcoatl_types::QuetzalcoatlError::StorageError { .. }
    ));
    assert_eq!(published, 1, "失败前只尝试发布一次，绝不吞错继续");
}
