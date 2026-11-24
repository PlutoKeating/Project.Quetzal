# `quetzalcoatl-voice-ai`

`<3 MB` 纯 Rust 双工声学门与按需零遥测本地模型管线（契约 D-22 / 防坑 #12、#14）。

## 1. `DuplexAudioGate`（默认构建）

- 16 kHz 单声道、20 ms / 320 样本帧，内部按 AEC3 的 64 样本块处理。
- `sonora-aec3 0.3.0`（BSD-3-Clause，纯 Rust AEC3）以扬声器播报帧为 render 参考，
  对麦克风采集做声学回声消除；`echo_return_loss_db()` 暴露 AEC3 ERLE 估算。
- VAD：`onnx_graph` 的常量折叠单分支 ONNX 图 + Rust 侧同一常量求值器，输出语音概率；
  Rust 侧维护自适应底噪（1 s 校准窗口 + 慢升快降）作为图输入 `floor_db`。
- 打断语义：助手播报期间，累计 ≥ 400 ms 语音（允许 ≤200 ms 音节间隙）触发
  `GateEvent::BargeIn`，携带确认帧号、语音起始帧与打断帧偏移；纯回声永不触发。
- 语音起止事件带 300 ms 结束挂起，不影响打断计数。

### 内置模型到底是什么（重要）

仓库**没有**附带 Silero VAD 权重。按任务书允许的替代路径，`assets/energy_periodicity_vad_16k.onnx`
是**自研、确定性、单分支**的 ONNX 图，实现「帧对数能量 + 归一化自相关周期性」判定：

```text
rms  = sqrt(max(mean(x^2), 1e-8));  edb = 20*log10(rms)
rel  = edb - floor_db
ac   = mean(x[0..220] * x[100..320]) / mean(x^2)
p    = sigmoid((rel-8)*0.8 + 4*max(ac-0.35,0)*clamp((rel-12)*0.3,0,1) - 1.5)
```

图为 `Mul/ReduceMean/Sqrt/Log/Sub/Div/Max/Clip/Slice/Sigmoid/Add` 数据流，无 `If`/`Loop`/`Scan`，
约 2.2 KB，由 `src/onnx_graph.rs` 的 protobuf 编码器逐字节确定性生成（`cargo run -p
quetzalcoatl-voice-ai --example gen_vad_asset`）。`tests/model_asset.rs` 会：

1. 校验提交资产与生成器逐字节一致、且已 `include_bytes!` 进二进制；
2. 用 `tract-onnx 0.23.10` 真实解析/常量折叠/推理，与 Rust 折叠求值器逐帧比对（±1e-4）。

**为什么运行时默认不链接 `tract-onnx`**：本机实测 `tract-onnx`（`default-features = false`）
仅引入 `model_for_path + into_optimized` 就会让 release 参考二进制约增加 **19 MB** 机器码，
与 `<3 MB` 硬门禁冲突。因此 `tract-onnx` 仅作为 **dev-dependency** 用于资产真实性/数值一致性
验收；默认构建直接执行同一常量折叠函数，零 C++ 动态库、零 ONNX Runtime 遥测。

## 2. `OnDemandAiPackManager`（按需模型包）

- 目录：`$QUETZALCOATL_HOME/models/<pack>/<version>/`，目录 `0700`、文件 `0600`。
- 清单：`manifest.json`（schema / pack / kind / version / model_id / files / Ed25519 签名），
  签名覆盖文件按路径排序后的规范化 JSON；每个文件绑定下载 URL、BLAKE3 与字节数。
- 安装：验签 → 校验相对路径 → 逐文件校验大小/BLAKE3 → 私有暂存目录写入并 `fsync` →
  原子 `rename` 到目标目录；失败不残留、不改动既有版本。
- 加载：重新验签 + 全量 BLAKE3 复核；任何损坏直接 `IntegrityViolation`。
- 路径穿越：包名/版本仅允许 `[A-Za-z0-9._-]` 且不得以 `.` 开头；包内路径必须是纯相对
  `Normal` 组件（拒绝 `..`、绝对路径、反斜杠、NUL）。
- 宿主通过 `PackSource` trait 注入下载实现，crate 自身零网络依赖。

## 3. 双轴零遥测

1. **环境轴**：`ORT_DISABLE_TELEMETRY=1` 由 `loader_environment()` / `InstalledPack::env()`
   在每条加载路径注入（含 `apply_loader_env` 供任意子进程使用），关闭 POSIX 1DS。
2. **API 轴**：启用 `dynamic-ort` feature 时，宿主实现的 `DynamicOrtInitializer` 必须调用
   `ort::init_from(path).with_telemetry(false)`（`OrtInitPlan.api_call` 显式声明），关闭 Windows ETW。

默认构建不链接 `ort`/`libonnxruntime`；`tests/zero_telemetry_gate.rs` 还会：
- 在密封子进程连续运行 VAD/AEC 120 s，断言 `/proc/<pid>/fd` 全程无 socket，且子进程自身复核；
- 扫描默认构建参考二进制，断言不存在 `onnxruntime`/`OneDS`/`1DS`/`opentelemetry` 字符串与
  `connect`/`socket`/`getaddrinfo`/`sendto` 动态符号。

## 4. 体积预算方法（`<3.0 MB`）

`tests/zero_telemetry_gate.rs::incremental_release_size_is_under_three_megabytes`：

1. 在系统临时目录生成两个极小探针 crate，均 `[profile.release] strip = "symbols"`、
   `panic = "abort"`：一个只 `println!`，另一个通过 path 依赖实例化 `DuplexAudioGate`
   并循环处理合成帧（强制链接真实 VAD/AEC 路径）。
2. 各自使用独立 `CARGO_TARGET_DIR` 与 `--offline` 构建 release 二进制。
3. 断言 `size(with) - size(baseline) < 3_000_000` 且 `size(with) > size(baseline)`。
4. 输出实测数值（例如 `delta ≈ 0.31 MiB`）便于 CI 追踪回归。

方法不含 `tract-onnx`（仅 dev-dependency）与任何未启用的可选特性，确定性强、无需
`cargo-bloat`，且失败信息包含双二进制实际字节数。

## 5. `HybridIndex`

小规模混合检索：语义余弦（0.65）+ 中文逐字/二元组与 ASCII 词的 BM25 风格词法分（0.35）。
`set_embedding_version()` 会按 ID 升序把旧版本向量入 `reembed()` 队列；重嵌入完成前命中
`stale_embedding=true` 且语义分归零（防跨模型/跨维污染），`drain_reembed_batch()` 提供确定性
分批消费。维度不符在写入与查询两侧都返回 `IntegrityViolation`。

## 6. `quetzalcoatld` 集成（opt-in）

`QUETZALCOATL_VOICE_AI=1` 才构造 `VoiceActivityRuntime`（否则 `None`，零状态零副作用）。
IPC 新增 `voice_frame`（`render_b64` / `capture_b64` / `assistant_speaking`），处理结果中的
语音起止与打断事件以 `PackCompartment::Core` 签名脊柱事件写入既有活动链路，与群组审计同源；
禁用时该请求返回 `VOICE_AI_DISABLED`。默认禁用的配置保证既有守护进程行为与测试不变。

## 7. 验证

```bash
cargo test -p quetzalcoatl-voice-ai --release
QZ_VOICE_SOAK_SECS=3 cargo test -p quetzalcoatl-voice-ai --release --test zero_telemetry_gate
cargo test -p quetzalcoatl-daemon --test voice_ai_opt_in
```

所有测试信号均由固定种子线性同余发生器与解析谐波合成器生成，仓库不含任何真实人声/个人音频。
