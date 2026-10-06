#!/usr/bin/env bash
# 构建 Linux 桌面版控制台（原生窗口，不借浏览器）：flutter build linux → build/linux/<arch>/release/bundle/，再打成
#   build/quetzal-<版本>-linux-<x64|arm64>-console.tar.gz（顶层目录 quetzal-console/，可执行文件 quetzal-console）。
# 一键安装脚本（cli/install.sh）在有桌面的机器上从 GitHub Release 下载同版本的这个包放到 ~/quetzal/console/，应用列表与任务栏显示 Quetzal 自己的图标。
# 需要：Flutter（FLUTTER=<路径> 可指定）、clang、cmake、ninja、pkg-config、libgtk-3-dev、libayatana-appindicator3-dev（托盘图标）（Debian/Ubuntu：apt install clang cmake ninja-build pkg-config libgtk-3-dev libayatana-appindicator3-dev）。
set -eu
cd "$(dirname "$0")/.."
# assets/runtime/ 是安卓安装器内置的运行基座（几 MB），桌面版用不着：构建期间挪开，结束后放回（与 build-web.sh 相同）
if [ -d assets/runtime ] && [ -n "$(ls -A assets/runtime)" ]; then
  mv assets/runtime assets/runtime.apk-only && mkdir -p assets/runtime
  trap 'rm -rf assets/runtime && mv assets/runtime.apk-only assets/runtime' EXIT
fi
mkdir -p assets/runtime
FLUTTER=${FLUTTER:-flutter}
V=$(sed -n 's/^version: *\([0-9][0-9.]*\).*/\1/p' pubspec.yaml)
case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) echo "不支持的架构：$(uname -m)" >&2; exit 1;; esac
"$FLUTTER" pub get >/dev/null
"$FLUTTER" build linux --release "$@"
BUNDLE="build/linux/$ARCH/release/bundle"
[ -x "$BUNDLE/quetzal-console" ] || { echo "没有找到 $BUNDLE/quetzal-console" >&2; exit 1; }
OUT="build/quetzal-$V-linux-$ARCH-console.tar.gz"
rm -rf build/quetzal-console && cp -r "$BUNDLE" build/quetzal-console
tar -C build -czf "$OUT" quetzal-console
rm -rf build/quetzal-console
echo "Linux 桌面版控制台已构建：$OUT（$(du -h "$OUT" | cut -f1)）"
