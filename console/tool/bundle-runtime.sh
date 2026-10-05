#!/usr/bin/env bash
# 把运行基座打进控制台：构建 ../runtime（main.cjs 与安卓适配器 android.mjs）复制到 assets/runtime/ 并写入版本号。构建 APK 前运行；
# 运行环境（Node.js、git、ssh、proot、网状层原生组件）由 tool/android-runtime/ 另外生成。
set -eu
cd "$(dirname "$0")/.."
# 失败时把被静音的输出打出来（CI 里只看得到这里）
( cd ../runtime && { [ -d node_modules ] || npm ci --no-audit --no-fund 2>&1 | tail -20; } \
  && { npm test --silent > /tmp/quetzal-runtime-test.log 2>&1 || { echo "runtime 测试失败（每条 not ok 及其后 25 行）："; grep -n -A 25 "not ok" /tmp/quetzal-runtime-test.log | head -200; echo "……末尾："; tail -12 /tmp/quetzal-runtime-test.log; exit 1; }; } \
  && npm run build --silent )
mkdir -p assets/runtime
rm -f assets/runtime/termux.mjs assets/runtime/mesh-modules.lock.json assets/runtime/install-mesh-modules.mjs # 旧版（Termux 安装器）留下的
cp ../runtime/dist/main.cjs ../runtime/dist/android.mjs assets/runtime/
node -p "require('../runtime/package.json').version" > assets/runtime/VERSION
echo "已内置运行基座 $(cat assets/runtime/VERSION)：$(du -h assets/runtime/main.cjs | cut -f1) main.cjs + android.mjs"
