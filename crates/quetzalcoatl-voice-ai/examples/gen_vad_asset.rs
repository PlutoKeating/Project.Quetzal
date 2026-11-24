//! 生成内置 VAD 的确定性 ONNX 资产（提交前运行一次即可）。
//!
//! ```bash
//! cargo run -p quetzalcoatl-voice-ai --example gen_vad_asset
//! ```

use quetzalcoatl_voice_ai::onnx_graph::{ASSET_FILE_NAME, asset_bytes};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(ASSET_FILE_NAME);
    std::fs::write(&path, asset_bytes())?;
    println!("wrote {} ({} bytes)", path.display(), asset_bytes().len());
    Ok(())
}
