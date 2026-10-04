#!/usr/bin/env bash
# 构建网页版控制台到 build/web/：由运行基座的网关托管（npm 包 @plutokeating/quetzal 随运行基座放到 ~/quetzal/current/web/）。
#   --no-web-resources-cdn：CanvasKit 等引擎资源随构建自带，不从 Google 的 CDN 加载（离线与中国大陆可用）；
#   --pwa-strategy=none：不注册 Service Worker，升级后浏览器直接拿到新版本；
#   中文字体子集在 web/fonts/（tool/gen-cjk-font.py 生成），随 web/ 目录一起复制进构建产物，启动时加载。
set -eu
cd "$(dirname "$0")/.."
# assets/runtime/ 是安卓安装器内置的运行基座（几 MB），网页版用不着：构建期间挪开，结束后放回
if [ -d assets/runtime ] && [ -n "$(ls -A assets/runtime)" ]; then
  mv assets/runtime assets/runtime.apk-only && mkdir -p assets/runtime
  trap 'rm -rf assets/runtime && mv assets/runtime.apk-only assets/runtime' EXIT
fi
mkdir -p assets/runtime
FLUTTER=${FLUTTER:-flutter}   # Flutter 不在 PATH 里时用环境变量指定
"$FLUTTER" pub get >/dev/null
"$FLUTTER" build web --release --no-web-resources-cdn --pwa-strategy=none --base-href / "$@"
# 自带的引擎只保留 CanvasKit（通用版 + Chromium 版）：skwasm / wimp 等是 --wasm 构建才用的，调试符号也不需要，去掉后小 30 MB
rm -rf build/web/canvaskit/skwasm* build/web/canvaskit/wimp* build/web/canvaskit/webparagraph build/web/canvaskit/*.symbols build/web/canvaskit/chromium/*.symbols build/web/flutter_service_worker.js
echo "网页控制台已构建：build/web（$(du -sh build/web | cut -f1)）"
