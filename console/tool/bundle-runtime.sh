#!/usr/bin/env bash
# 把运行基座打进控制台：构建 ../runtime（main.cjs、termux.mjs），复制到 assets/runtime/ 并写入版本号。构建 APK 前运行。
set -eu
cd "$(dirname "$0")/.."
( cd ../runtime && { [ -d node_modules ] || npm ci --silent; } && npm test --silent >/dev/null && npm run build --silent )
mkdir -p assets/runtime
cp ../runtime/dist/main.cjs ../runtime/dist/termux.mjs assets/runtime/
node -p "require('../runtime/package.json').version" > assets/runtime/VERSION
echo "已内置运行基座 $(cat assets/runtime/VERSION)：$(du -h assets/runtime/main.cjs | cut -f1) main.cjs + termux.mjs"
