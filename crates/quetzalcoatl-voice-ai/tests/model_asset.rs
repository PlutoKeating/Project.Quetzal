#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 内置 VAD 模型资产的来源真实性、单分支常量折叠与 `tract-onnx` 数值一致性。

use quetzalcoatl_voice_ai::onnx_graph::{
    ASSET_FILE_NAME, asset_bytes, bundled_model_asset, folded_probability, model_constants,
};
use tract_onnx::prelude::*;

struct Lcg(u64);

impl Lcg {
    fn next_f32(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 40) as f32 / 8_388_608.0) - 1.0
    }
}

#[test]
fn committed_asset_is_exactly_the_deterministic_generator_output() {
    let committed = include_bytes!("../assets/energy_periodicity_vad_16k.onnx");
    let generated = asset_bytes();
    assert_eq!(
        committed.as_slice(),
        generated.as_slice(),
        "提交的 {} 必须与确定性生成器逐字节一致",
        ASSET_FILE_NAME
    );
    assert_eq!(
        bundled_model_asset(),
        generated.as_slice(),
        "编译进二进制的内置图必须与生成器一致"
    );
    assert!(
        committed.len() < 32 * 1024,
        "内置 VAD 图必须极小，实际 {} B",
        committed.len()
    );
    for forbidden in [b"If".as_slice(), b"Loop".as_slice(), b"Scan".as_slice()] {
        assert!(
            !contains(committed, forbidden),
            "内置 VAD 图禁止嵌套控制流算子: {}",
            String::from_utf8_lossy(forbidden)
        );
    }
}

#[test]
fn tract_onnx_folds_single_branch_and_matches_folded_evaluator() {
    let mut cursor = std::io::Cursor::new(asset_bytes());
    let model = tract_onnx::onnx()
        .model_for_read(&mut cursor)
        .expect("ONNX 图可被 tract 解析");
    let optimized = model.into_optimized().expect("常量折叠成功");
    assert!(
        optimized.nodes().len() < 64,
        "常量折叠后节点数应保持单分支紧凑，实际 {}",
        optimized.nodes().len()
    );
    let runnable = optimized.into_runnable().expect("规划成功");

    let mut rng = Lcg(0xC0FF_EE00_1234_5678);
    let constants = model_constants();
    for round in 0..64 {
        let mut frame = vec![0.0_f32; 320];
        let amplitude = if round % 3 == 0 { 0.0005 } else { 0.35 };
        let f0 = constants.periodicity_lag_hz_hint;
        for (index, sample) in frame.iter_mut().enumerate() {
            let t = index as f32 / 16_000.0;
            *sample = amplitude * (core::f32::consts::TAU * f0 * t).sin() + 0.01 * rng.next_f32();
        }
        let floor_db = -60.0 + 0.5 * (round as f32);
        let expected = folded_probability(&frame, floor_db);

        let input = Tensor::from_shape(&[1, 320], frame.as_slice())
            .expect("输入张量")
            .into_tvalue();
        let floor = Tensor::from_shape(&[1, 1], &[floor_db])
            .expect("底噪张量")
            .into_tvalue();
        let outputs = runnable.run(tvec!(input, floor)).expect("推理成功");
        let actual = *outputs[0]
            .to_plain_array_view::<f32>()
            .expect("概率张量")
            .first()
            .expect("单输出");
        assert!(
            (expected - actual).abs() < 1e-4,
            "第 {round} 帧 tract 与折叠求值器不一致: tract={actual} folded={expected}"
        );
    }
}

#[test]
fn folded_evaluator_is_monotonic_in_signal_energy() {
    let tone = |amplitude: f32| -> Vec<f32> {
        (0..320)
            .map(|index| {
                amplitude * (core::f32::consts::TAU * 160.0 * index as f32 / 16_000.0).sin()
            })
            .collect()
    };
    let floor = -60.0;
    let quiet = folded_probability(&tone(0.001), floor);
    let speech = folded_probability(&tone(0.4), floor);
    assert!(quiet < 0.1, "极弱信号不应触发: {quiet}");
    assert!(speech > 0.9, "类语音信号必须触发: {speech}");
    assert!(speech > quiet);
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}
