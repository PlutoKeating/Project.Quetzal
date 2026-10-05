#!/usr/bin/env bash
# 把运行基座打进控制台：构建 ../runtime（main.cjs、termux.mjs），连同网状层原生组件的锁定文件与安装程序复制到 assets/runtime/ 并写入版本号。构建 APK 前运行。
set -eu
cd "$(dirname "$0")/.."
# 失败时把被静音的输出打出来（CI 里只看得到这里）
( cd ../runtime && { [ -d node_modules ] || npm ci --no-audit --no-fund 2>&1 | tail -20; } \
  && { npm test --silent > /tmp/quetzal-runtime-test.log 2>&1 || { echo "runtime 测试失败（每条 not ok 及其后 25 行）："; grep -n -A 25 "not ok" /tmp/quetzal-runtime-test.log | head -200; echo "……末尾："; tail -12 /tmp/quetzal-runtime-test.log; exit 1; }; } \
  && npm run build --silent )
mkdir -p assets/runtime
cp ../runtime/dist/main.cjs ../runtime/dist/termux.mjs assets/runtime/
cp ../runtime/tool/mesh-modules.lock.json ../runtime/tool/install-mesh-modules.mjs assets/runtime/ # 网状层原生组件：安装脚本在手机上按锁定的 sha512 下载核对
node -p "require('../runtime/package.json').version" > assets/runtime/VERSION
echo "已内置运行基座 $(cat assets/runtime/VERSION)：$(du -h assets/runtime/main.cjs | cut -f1) main.cjs + termux.mjs"
