#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-voice-ai` — `<3MB` 纯 Rust 双工声学门（AEC3 + 16 kHz VAD）与按需零遥测模型管线。

pub mod aec_vad;
pub mod hybrid_search;
pub mod onnx_graph;
pub mod ort_loader;
