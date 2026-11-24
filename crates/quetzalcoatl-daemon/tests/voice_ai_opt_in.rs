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
