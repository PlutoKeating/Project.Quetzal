#!/usr/bin/env bash
# 把运行基座打进 npm 包：构建 ../runtime（main.cjs、linux.mjs），复制到 dist/runtime/ 并写入版本号。构建与发布前运行。
set -eu
cd "$(dirname "$0")/.."
RT=$(node -p "require('../runtime/package.json').version"); PKG=$(node -p "require('./package.json').version")
[ "$RT" = "$PKG" ] || { echo "版本号不一致：runtime $RT，cli $PKG"; exit 1; }
( cd ../runtime && { [ -d node_modules ] || npm ci --no-audit --no-fund 2>&1 | tail -20; } && npm run build --silent )
mkdir -p dist/runtime
cp ../runtime/dist/main.cjs ../runtime/dist/linux.mjs dist/runtime/
printf '%s' "$RT" > dist/runtime/VERSION
echo "已内置运行基座 $RT：$(du -h dist/runtime/main.cjs | cut -f1) main.cjs + linux.mjs"
