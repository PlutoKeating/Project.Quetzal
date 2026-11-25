#!/usr/bin/env bash
# Quetzalcoatl V2 — 浏览器 WASM 缓存宿主（可选资产）构建。
#
#   scripts/build-web-wasm.sh
#
# 产出（不入库，纯本地构建资产）：
#   surfaces/web/public/wasm/quetzalcoatl_wasm.js           wasm-bindgen glue（ES module）
#   surfaces/web/public/wasm/quetzalcoatl_wasm_bg.wasm      OPFS 单写者缓存宿主
#
# 缺失这些文件时，`surfaces/web` 自动降级为内存缓存并在界面明示
# `degraded: no-wasm`——绝不伪装成 OPFS 持久化。
#
# 退出码约定：0 成功；77 wasm-bindgen / wasm32 target 工具链缺失（跳过，不伪装）；其他为真实失败。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$REPO_ROOT/surfaces/web"
OUT_DIR="$WEB_DIR/public/wasm"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
CARGO_BIN="${QZ_CARGO:-cargo}"
WASM_BINDGEN_BIN="${WASM_BINDGEN:-wasm-bindgen}"
EXPECTED_WASM_BINDGEN="0.2.130"

log() { printf '[build-web-wasm] %s\n' "$*"; }
skip() { printf '[build-web-wasm] SKIP: %s\n' "$*" >&2; exit 77; }

command -v "$CARGO_BIN" >/dev/null 2>&1 || skip "未找到 cargo"
command -v "$WASM_BINDGEN_BIN" >/dev/null 2>&1 || skip "未找到 wasm-bindgen CLI（与 crate 版本配对，本仓库锁定 $EXPECTED_WASM_BINDGEN）"

ACTUAL="$("$WASM_BINDGEN_BIN" --version | awk '{print $2}')"
if [ "$ACTUAL" != "$EXPECTED_WASM_BINDGEN" ]; then
    skip "wasm-bindgen CLI 版本 $ACTUAL 与锁定版本 $EXPECTED_WASM_BINDGEN 不一致"
fi

if ! "$CARGO_BIN" build -p quetzalcoatl-wasm --lib --release \
    --target wasm32-unknown-unknown \
    --target-dir "$TARGET_DIR"; then
    skip "wasm32-unknown-unknown 目标不可用（rustup target add wasm32-unknown-unknown）"
fi

mkdir -p "$OUT_DIR"
"$WASM_BINDGEN_BIN" --target web --no-typescript \
    --out-dir "$OUT_DIR" \
    --out-name quetzalcoatl_wasm \
    "$TARGET_DIR/wasm32-unknown-unknown/release/quetzalcoatl_wasm.wasm"

log "已生成："
ls -lh "$OUT_DIR"
log "运行 \`npm --prefix surfaces/web run build\` 后，dist/wasm 会随静态资源一起由 quetzalcoatld 同源托管。"
