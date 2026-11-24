# 内置 VAD 模型资产

`energy_periodicity_vad_16k.onnx` **不是 Silero VAD**，而是本仓库自研、确定性、单分支的
16 kHz 图（帧对数能量 + 归一化自相关周期性），实现与 `src/onnx_graph.rs` 中
`folded_probability()` 完全一致的判定函数；不含 `If`/`Loop`/`Scan`，可被 tract-onnx
完整常量折叠。详细公式、来源说明与验收方式见 crate 根目录 `README.md`。

重新生成（逐字节确定性）：

```bash
cargo run -p quetzalcoatl-voice-ai --example gen_vad_asset
```
