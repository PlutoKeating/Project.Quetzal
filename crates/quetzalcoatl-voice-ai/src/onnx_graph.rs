//! 内置 16 kHz VAD 的确定性 ONNX 图生成器与常量折叠求值器。
//!
//! # 模型真实来源（重要）
//!
//! 本 crate **不附带 Silero VAD 权重**：Silero 官方 `silero_vad.onnx`（v4/v5）包含嵌套
//! `If`/`Scan` 控制流，无法在 `tract-onnx` 中做常量折叠，也无法在 `<3MB: 体积预算内
//! 以纯 Rust 规划执行。按任务书允许的替代路径，这里提交／生成一个**自研、确定性、
//! 单分支**的 ONNX 图，实现「帧对数能量 + 归一化自相关周期性」的 VAD 判定函数：
//!
//! ```text
//! rms       = sqrt(max(mean(x^2), 1e-8))
//! edb       = 20*log10(rms)                       (≈ 8.6858896 * ln(rms))
//! rel       = edb - noise_floor_db                (自适应底噪由 Rust 侧输入)
//! e_score   = (rel - 8.0) * 0.8
//! ac        = mean(x[0..220] * x[100..320]) / mean(x^2)
//! act       = clamp((rel - 12.0) * 0.3, 0, 1)
//! p         = sigmoid(e_score + 4.0 * max(ac - 0.35, 0) * act - 1.5)
//! ```
//!
//! 常数集中在 [`model_constants`]，图与折叠求值器共用同一来源，禁止各自硬编码。
//!
//! 该图只有 `Mul / ReduceMean / Sqrt / Add / Log / Sub / Div / Max / Clip / Sigmoid / Slice`
//! 单分支数据流，不含 `If`、`Loop`、`Scan`，可被 `tract-onnx` 完整常量折叠；运行时由
//! [`folded_probability`] 以同一组常量直接求值（零外部动态库、零 ONNX Runtime 遥测）。
//! `tests/model_asset.rs` 会把提交的资产与 [`asset_bytes`] 的逐字节输出比对，并用
//! `tract-onnx` 实际加载、折叠、推理，逐帧核对两侧数值一致。

/// 提交资产文件名。
pub const ASSET_FILE_NAME: &str = "energy_periodicity_vad_16k.onnx";

/// 编译进二进制的内置 VAD 图字节（约 2 KB；供运行时来源校验与离线审计）。
pub const BUNDLED_VAD_MODEL: &[u8] = include_bytes!("../assets/energy_periodicity_vad_16k.onnx");

/// 返回编译进二进制的内置 VAD 图字节。
#[must_use]
pub const fn bundled_model_asset() -> &'static [u8] {
    BUNDLED_VAD_MODEL
}

/// 16 kHz 单帧样本数（20 ms）。
pub const FRAME_SAMPLES: usize = 320;

/// 帧长（毫秒）。
pub const FRAME_MS: u32 = 20;

/// 图内常量（ONNX 初始张量与 Rust 折叠求值器共用同一数值）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelConstants {
    /// 触发所需的最低「高于底噪」信噪比（dB）。
    pub energy_threshold_db: f32,
    /// dB 分数的缩放系数（每 dB 得分）。
    pub energy_scale_inv: f32,
    /// ONNX 求周期性的固定滞后样本数。
    pub periodicity_lag_samples: usize,
    /// 该滞后对应的提示基频（Hz），仅用于文档与测试信号合成。
    pub periodicity_lag_hz_hint: f32,
    /// 归一化自相关阈值。
    pub periodicity_threshold: f32,
    /// 周期性项权重。
    pub periodicity_weight: f32,
    /// 周期性项的能量门偏移（dB）。
    pub periodicity_gate_offset_db: f32,
    /// 能量门斜率（每 dB）。
    pub periodicity_gate_scale: f32,
    /// 最终 sigmoid 偏置。
    pub bias: f32,
}

/// 返回图内常量。
#[must_use]
pub const fn model_constants() -> ModelConstants {
    ModelConstants {
        energy_threshold_db: 8.0,
        energy_scale_inv: 0.80,
        periodicity_lag_samples: 100,
        periodicity_lag_hz_hint: 160.0,
        periodicity_threshold: 0.35,
        periodicity_weight: 4.0,
        periodicity_gate_offset_db: 12.0,
        periodicity_gate_scale: 0.30,
        bias: -1.5,
    }
}

/// 与 ONNX 图逐运算等价的常量折叠求值器。
///
/// `frame` 必须为 320 个 16 kHz 单声道样本；`noise_floor_db` 为 Rust 侧自适应底噪。
#[must_use]
pub fn folded_probability(frame: &[f32], noise_floor_db: f32) -> f32 {
    let constants = model_constants();
    let len = frame.len();
    if len == 0 {
        return 0.0;
    }
    let inv_len = 1.0 / len as f32;
    let mut sum_squares = 0.0_f32;
    for sample in frame {
        sum_squares += sample * sample;
    }
    let mean_square = (sum_squares * inv_len).max(1e-8);
    let edb = 8.685_889 * mean_square.sqrt().ln();
    let rel = edb - noise_floor_db;
    let energy_score = (rel - constants.energy_threshold_db) * constants.energy_scale_inv;

    let lag = constants.periodicity_lag_samples;
    let ac = if len > lag {
        let overlap = len - lag;
        let mut cross = 0.0_f32;
        for index in 0..overlap {
            cross += frame[index] * frame[index + lag];
        }
        (cross / overlap as f32) / mean_square
    } else {
        0.0
    };
    let ac_pos = (ac - constants.periodicity_threshold).max(0.0);
    let activation = ((rel - constants.periodicity_gate_offset_db)
        * constants.periodicity_gate_scale)
        .clamp(0.0, 1.0);
    let periodicity = ac_pos * constants.periodicity_weight * activation;
    sigmoid(energy_score + periodicity + constants.bias)
}

fn sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value).exp())
}

// ---------------------------------------------------------------------------
// 确定性 ONNX（protobuf）编码
// ---------------------------------------------------------------------------

/// 生成内置 VAD 图资产字节（逐字节确定性）。
#[must_use]
pub fn asset_bytes() -> Vec<u8> {
    let constants = model_constants();

    let mut graph = Encoder::new();
    graph.bytes_field(2, b"quetzalcoatl_ep_vad");

    for node in nodes(constants) {
        graph.bytes_field(1, &node);
    }
    for initializer in initializers(constants) {
        graph.bytes_field(5, &initializer);
    }
    graph.bytes_field(11, &value_info_f32("x", &[1, FRAME_SAMPLES as i64]));
    graph.bytes_field(11, &value_info_f32("floor_db", &[1, 1]));
    graph.bytes_field(12, &value_info_f32("prob", &[1, 1]));

    let mut opset = Encoder::new();
    opset.string_field(1, "");
    opset.varint_field(2, 13);

    let mut model = Encoder::new();
    model.varint_field(1, 7); // ir_version
    model.string_field(2, "quetzalcoatl-voice-ai");
    model.string_field(3, "2.0.0-alpha.1");
    model.string_field(
        6,
        "self-authored single-branch energy+periodicity VAD (not Silero)",
    );
    model.bytes_field(7, &graph.finish());
    model.bytes_field(8, &opset.finish());

    let mut metadata = Encoder::new();
    metadata.string_field(1, "quetzalcoatl.provenance");
    metadata.string_field(
        2,
        "constant-folded energy+periodicity decision function; no Silero weights, no control flow",
    );
    model.bytes_field(14, &metadata.finish());

    model.finish()
}

fn nodes(_c: ModelConstants) -> Vec<Vec<u8>> {
    let out = vec![
        node("mul_x2", "Mul", &["x", "x"], &["x2"], None),
        node(
            "mean_square",
            "ReduceMean",
            &["x2"],
            &["mean_square"],
            Some(&[1]),
        ),
        node(
            "mean_square_clamped",
            "Max",
            &["mean_square", "eps"],
            &["mean_square_clamped"],
            None,
        ),
        node("rms", "Sqrt", &["mean_square_clamped"], &["rms"], None),
        node("log_rms", "Log", &["rms"], &["log_rms"], None),
        node(
            "energy_db",
            "Mul",
            &["log_rms", "log_scale"],
            &["energy_db"],
            None,
        ),
        node(
            "rel_db",
            "Sub",
            &["energy_db", "floor_db"],
            &["rel_db"],
            None,
        ),
        node(
            "rel_db_minus_threshold",
            "Sub",
            &["rel_db", "energy_threshold_db"],
            &["rel_db_minus_threshold"],
            None,
        ),
        node(
            "energy_score",
            "Mul",
            &["rel_db_minus_threshold", "energy_scale_inv"],
            &["energy_score"],
            None,
        ),
        node(
            "head",
            "Slice",
            &[
                "x",
                "slice_starts_head",
                "slice_ends_head",
                "slice_axes",
                "slice_steps",
            ],
            &["head"],
            None,
        ),
        node(
            "tail",
            "Slice",
            &[
                "x",
                "slice_starts_tail",
                "slice_ends_tail",
                "slice_axes",
                "slice_steps",
            ],
            &["tail"],
            None,
        ),
        node("cross", "Mul", &["head", "tail"], &["cross"], None),
        node(
            "cross_mean",
            "ReduceMean",
            &["cross"],
            &["cross_mean"],
            Some(&[1]),
        ),
        node(
            "autocorrelation",
            "Div",
            &["cross_mean", "mean_square_clamped"],
            &["autocorrelation"],
            None,
        ),
        node(
            "ac_minus_threshold",
            "Sub",
            &["autocorrelation", "periodicity_threshold"],
            &["ac_minus_threshold"],
            None,
        ),
        node(
            "ac_over_threshold",
            "Max",
            &["ac_minus_threshold", "zero"],
            &["ac_over_threshold"],
            None,
        ),
        node(
            "rel_db_minus_gate",
            "Sub",
            &["rel_db", "periodicity_gate_offset_db"],
            &["rel_db_minus_gate"],
            None,
        ),
        node(
            "gate_scaled",
            "Mul",
            &["rel_db_minus_gate", "periodicity_gate_scale"],
            &["gate_scaled"],
            None,
        ),
        node(
            "activation",
            "Clip",
            &["gate_scaled", "zero", "one"],
            &["activation"],
            None,
        ),
        node(
            "periodicity_weighted",
            "Mul",
            &["ac_over_threshold", "periodicity_weight"],
            &["periodicity_weighted"],
            None,
        ),
        node(
            "periodicity",
            "Mul",
            &["periodicity_weighted", "activation"],
            &["periodicity"],
            None,
        ),
        node(
            "score",
            "Add",
            &["energy_score", "periodicity"],
            &["score"],
            None,
        ),
        node(
            "score_biased",
            "Add",
            &["score", "bias"],
            &["score_biased"],
            None,
        ),
        node("prob", "Sigmoid", &["score_biased"], &["prob"], None),
    ];
    out
}

fn initializers(c: ModelConstants) -> Vec<Vec<u8>> {
    let lag = c.periodicity_lag_samples as i64;
    let end = FRAME_SAMPLES as i64;
    vec![
        tensor_f32("eps", 1e-8_f32),
        tensor_f32("log_scale", 8.685_889_f32),
        tensor_f32("energy_threshold_db", c.energy_threshold_db),
        tensor_f32("energy_scale_inv", c.energy_scale_inv),
        tensor_f32("periodicity_threshold", c.periodicity_threshold),
        tensor_f32("periodicity_weight", c.periodicity_weight),
        tensor_f32("periodicity_gate_offset_db", c.periodicity_gate_offset_db),
        tensor_f32("periodicity_gate_scale", c.periodicity_gate_scale),
        tensor_f32("bias", c.bias),
        tensor_f32("zero", 0.0),
        tensor_f32("one", 1.0),
        tensor_i64("slice_starts_head", &[0]),
        tensor_i64("slice_ends_head", &[end - lag]),
        tensor_i64("slice_starts_tail", &[lag]),
        tensor_i64("slice_ends_tail", &[end]),
        tensor_i64("slice_axes", &[1]),
        tensor_i64("slice_steps", &[1]),
    ]
}

fn node(
    name: &str,
    op_type: &str,
    inputs: &[&str],
    outputs: &[&str],
    reduce_axes: Option<&[i64]>,
) -> Vec<u8> {
    let mut proto = Encoder::new();
    for input in inputs {
        proto.string_field(1, input);
    }
    for output in outputs {
        proto.string_field(2, output);
    }
    proto.string_field(3, name);
    proto.string_field(4, op_type);
    if let Some(axes) = reduce_axes {
        let mut attribute = Encoder::new();
        attribute.string_field(1, "axes");
        for axis in axes {
            attribute.varint_field(8, *axis as u64);
        }
        attribute.varint_field(20, 7); // AttributeProto::INTS
        proto.bytes_field(5, &attribute.finish());
        let mut keepdims = Encoder::new();
        keepdims.string_field(1, "keepdims");
        keepdims.varint_field(3, 1);
        keepdims.varint_field(20, 2); // AttributeProto::INT
        proto.bytes_field(5, &keepdims.finish());
    }
    proto.finish()
}

fn tensor_f32(name: &str, value: f32) -> Vec<u8> {
    let mut proto = Encoder::new();
    proto.varint_field(1, 1); // dims: [1]
    proto.varint_field(2, 1); // data_type = FLOAT
    proto.bytes_field(4, &value.to_le_bytes()); // float_data (packed)
    proto.string_field(8, name);
    proto.finish()
}

fn tensor_i64(name: &str, values: &[i64]) -> Vec<u8> {
    let mut proto = Encoder::new();
    for _ in values {
        proto.varint_field(1, 1); // dims: [len]
    }
    proto.varint_field(2, 7); // data_type = INT64
    for value in values {
        proto.varint_field(7, *value as u64);
    }
    proto.string_field(8, name);
    proto.finish()
}

fn value_info_f32(name: &str, dims: &[i64]) -> Vec<u8> {
    let mut shape = Encoder::new();
    for dim in dims {
        let mut dimension = Encoder::new();
        dimension.varint_field(1, *dim as u64);
        shape.bytes_field(1, &dimension.finish());
    }
    let mut tensor_type = Encoder::new();
    tensor_type.varint_field(1, 1); // elem_type = FLOAT
    tensor_type.bytes_field(2, &shape.finish());
    let mut type_proto = Encoder::new();
    type_proto.bytes_field(1, &tensor_type.finish());

    let mut proto = Encoder::new();
    proto.string_field(1, name);
    proto.bytes_field(2, &type_proto.finish());
    proto.finish()
}

/// 极简 protobuf 线格式编码器（仅覆盖 ONNX 所需字段类型）。
struct Encoder {
    buffer: Vec<u8>,
}

impl Encoder {
    fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    fn varint_field(&mut self, field: u32, value: u64) {
        self.key(field, 0);
        self.varint(value);
    }

    fn bytes_field(&mut self, field: u32, bytes: &[u8]) {
        self.key(field, 2);
        self.varint(bytes.len() as u64);
        self.buffer.extend_from_slice(bytes);
    }

    fn string_field(&mut self, field: u32, value: &str) {
        self.bytes_field(field, value.as_bytes());
    }

    fn key(&mut self, field: u32, wire_type: u32) {
        self.varint(u64::from(field) << 3 | u64::from(wire_type));
    }

    fn varint(&mut self, mut value: u64) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                self.buffer.push(byte);
                break;
            }
            self.buffer.push(byte | 0x80);
        }
    }

    fn finish(self) -> Vec<u8> {
        self.buffer
    }
}
