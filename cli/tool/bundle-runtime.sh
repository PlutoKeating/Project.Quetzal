#!/usr/bin/env bash
# 把运行基座与网页控制台打进 npm 包：构建 ../runtime（main.cjs、linux.mjs）与 ../console 的 Web 版，复制到 dist/runtime/ 并写入版本号。构建与发布前运行。
#   QUETZAL_NO_WEB=1 跳过网页控制台（本机没有 Flutter 时的开发用；发布包必须带）。
set -eu
cd "$(dirname "$0")/.."
RT=$(node -p "require('../runtime/package.json').version"); PKG=$(node -p "require('./package.json').version")
[ "$RT" = "$PKG" ] || { echo "版本号不一致：runtime $RT，cli $PKG"; exit 1; }
( cd ../runtime && { [ -d node_modules ] || npm ci --no-audit --no-fund 2>&1 | tail -20; } && npm run build --silent )
rm -rf dist/runtime && mkdir -p dist/runtime
cp ../runtime/dist/main.cjs ../runtime/dist/linux.mjs dist/runtime/
cp ../runtime/tool/mesh-modules.lock.json ../runtime/tool/install-mesh-modules.mjs dist/runtime/ # 网状层原生组件：安装时按锁定的 sha512 下载核对
printf '%s' "$RT" > dist/runtime/VERSION
if [ "${QUETZAL_NO_WEB:-}" = 1 ]; then
  echo "已内置运行基座 $RT（QUETZAL_NO_WEB=1：不带网页控制台）"
else
  ../console/tool/build-web.sh
  cp -r ../console/build/web dist/runtime/web
  echo "已内置运行基座 $RT：$(du -h dist/runtime/main.cjs | cut -f1) main.cjs + linux.mjs + 网页控制台 $(du -sh dist/runtime/web | cut -f1)"
fi
