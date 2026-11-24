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
- 加载：重新验签；文件未变更时命中 `(pack, version, size/mtime/ctime/inode)` 进程内缓存（O(1)），
  变更后以 64 KiB 块**流式** BLAKE3 重校验，任何损坏直接 `IntegrityViolation`。
  `verification_stats()` 暴露 `verifications`/`cache_hits`，供回归测试证明“第二次加载不重哈希、
  篡改后缓存失效并检出”；unix 下 ctime/inode 参与指纹，同大小且 mtime 被恢复的原地改写仍会被
  流式 BLAKE3 复检捕获。
- 路径穿越：包名/版本仅允许 `[A-Za-z0-9._-]` 且不得以 `.` 开头；包内路径必须是纯相对
  `Normal` 组件（拒绝 `..`、绝对路径、反斜杠、NUL）。
- 宿主通过 `PackSource` trait 注入下载实现，crate 自身零网络依赖。

## 3. 双轴零遥测（`OrtInitializer`）

初始化动态 ORT 的**唯一公开入口**是 `OrtInitializer::initialize()`（`tests/ort_initializer.rs`）：

1. **环境轴**：`initialize()` 在调用桥接**之前**校验**当前进程**已导出
   `ORT_DISABLE_TELEMETRY=1`，否则直接 `IntegrityViolation` fail-closed——绝不在未关闭遥测的进程里
   初始化 ORT。**宿主必须自行导出该变量**（例如 `quetzalcoatld` 启动脚本或 systemd `Environment=`）。
   初始化器同时持有 `ORT_DISABLE_TELEMETRY=1` 的加载器环境，经
   `OrtInitialization::apply_environment()` 注入承载 ORT 的子进程，关闭 POSIX 1DS。
   （进程内 `std::env::set_var` 在 Rust 2024 是 `unsafe`，与本工作区 `forbid(unsafe_code)` 冲突；
   因此无法由本 crate 代为设置进程环境，只能要求宿主导出并在入口 fail-closed 校验。）
2. **API 轴**：以 `disable_telemetry = true` 调用注入的 `OrtRuntimeBridge::init`；
   桥接必须返回 `TelemetryStatus::Disabled`，否则 `IntegrityViolation` fail-closed。
   默认构建不链接 `ort`；`--features dynamic-ort` 时 `OrtCrateBridge` 调用
   `ort::init_from(path).with_telemetry(false).commit()`（`ort` 为可选依赖、`load-dynamic`，
   构建期不下载任何二进制），并校验 `commit()` 真正建立了全局环境。
3. 测试用 mock 桥接：返回 `Enabled` 必须失败（且环境轴仍为 `1`）、返回 `Disabled` 必须成功、
   桥接错误必须上抛；不再存在“字符串字面量与自身比较”的假门禁。

`tests/zero_telemetry_gate.rs` 还会（**默认测试套件中 `#[ignore]`**，见第 7 节）：
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

方法不含 `tract-onnx`（仅 dev-dependency，默认不链接）与任何未启用的可选特性，确定性强、
无需 `cargo-bloat`，且失败信息包含双二进制实际字节数。该测试会 shell out 到 `cargo`，
因此标记 `#[ignore]`，由专用 CI 作业执行，**默认 `cargo test --workspace` 绝不调用 cargo、
也不 sleep 分钟级**。

## 5. `HybridIndex` 与 `reembed()` 联动

小规模混合检索：语义余弦（0.65）+ 中文逐字/二元组与 ASCII 词的 BM25 风格词法分（0.35）。

- 每个向量记录 `(model_id, dim, pack_version)`；`upsert_embedded()` 对跨模型/跨维度向量直接
  `IntegrityViolation`，同模型同维度的旧 `pack_version` 则接受并**入队** `reembed()`
  （`UpsertOutcome::{Fresh, QueuedForReembed}`）。
- `OnDemandAiPackManager::set_embedding_sink()`（`SharedHybridIndex`）在安装新的
  `AiPackKind::Embedding` 包版本时，按 ID 升序把受影响文档入队；
  `drain_reembed_batch(n)` 提供有界消费。重嵌入完成前命中 `stale_embedding=true` 且语义分归零。

## 6. `quetzalcoatld` 集成（opt-in）

`QUETZALCOATL_VOICE_AI=1` 才构造 `VoiceActivitySessions`（否则 `None`，零状态零副作用）。
IPC 新增 `voice_frame`（`stream_id` / `frame_seq` / `render_b64` / `capture_b64` / `assistant_speaking`）：

- 每个 `stream_id` 独占一份 `DuplexAudioGate`（独立 AEC/VAD/打断状态），最多 8 条流，超出按 LRU 逐出；
- 流内 `frame_seq` 必须从 0 开始严格连续，缺口/回退返回类型化 `VoiceStreamError::NonContiguousFrameSeq`
  （IPC 错误码 `VOICE_STREAM_SEQUENCE`）；首帧校验先于注册/逐出，畸形首帧不会影响既有流的 AEC 状态；
- 语音起止与打断事件以 `PackCompartment::Core` 签名脊柱事件写入既有活动链路，与群组审计同源；
  `append_event` 失败会作为 `VoiceStreamError::Spine` 上抛，**绝不**静默丢弃；
- 禁用时该请求返回 `VOICE_AI_DISABLED`；默认禁用的配置保证既有守护进程行为与测试不变。

## 7. 验证

默认套件（快、不调用 cargo、不 sleep）：

```bash
cargo test -p quetzalcoatl-voice-ai --release
cargo test -p quetzalcoatl-daemon --test voice_ai_opt_in
```

专用 CI 作业（体积门禁 + 符号扫描 + 120 s 密封子进程）：

```bash
cargo test -p quetzalcoatl-voice-ai --release --test zero_telemetry_gate -- --ignored --nocapture
# 本地调试可用 QZ_VOICE_SOAK_SECS=3 缩短密封 soak；CI 必须使用默认 120 s。
```

`incremental_release_size_is_under_three_megabytes`、
`default_build_reaches_no_onnxruntime_telemetry_or_network_symbols`、
`sealed_vad_soak_makes_zero_outbound_connections` 均为 `#[ignore]`，只看显式 CI 作业。

所有测试信号均由固定种子线性同余发生器与解析谐波合成器生成，仓库不含任何真实人声/个人音频。
