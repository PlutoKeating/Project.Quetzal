#!/usr/bin/env bash
# 把运行基座打进控制台：构建 ../runtime（main.cjs、termux.mjs），复制到 assets/runtime/ 并写入版本号。构建 APK 前运行。
set -eu
cd "$(dirname "$0")/.."
# 失败时把被静音的输出打出来（CI 里只看得到这里）
( cd ../runtime && { [ -d node_modules ] || npm ci --no-audit --no-fund 2>&1 | tail -20; } \
  && { npm test --silent > /tmp/quetzal-runtime-test.log 2>&1 || { echo "runtime 测试失败："; tail -80 /tmp/quetzal-runtime-test.log; exit 1; }; } \
  && npm run build --silent )
mkdir -p assets/runtime
cp ../runtime/dist/main.cjs ../runtime/dist/termux.mjs assets/runtime/
node -p "require('../runtime/package.json').version" > assets/runtime/VERSION
echo "已内置运行基座 $(cat assets/runtime/VERSION)：$(du -h assets/runtime/main.cjs | cut -f1) main.cjs + termux.mjs"
