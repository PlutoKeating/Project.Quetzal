#!/usr/bin/env bash
# 用 termux-packages 以 App 自己的包名为前缀（/data/data/xyz.quetzal.console/files/usr）从源码编译运行基座需要的程序：
# Node.js（LTS）、git、openssh、proot 与它们的全部依赖。产物是一组 .deb，交给 pack.sh 拆成 APK 里的 jniLibs 与资源。
#   用法：tool/android-runtime/build-packages.sh [工作目录]（默认 build/android-runtime）
#   需要 Docker；termux-packages 锁定在 TERMUX_PACKAGES_COMMIT，构建镜像来自它的 scripts/run-docker.sh。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/versions.env"
work="${1:-$here/../../build/android-runtime}"
mkdir -p "$work"; work="$(cd "$work" && pwd)"
tp="$work/termux-packages"

if [ ! -d "$tp/.git" ]; then
  git init -q "$tp"
  git -C "$tp" remote add origin https://github.com/termux/termux-packages.git
fi
if [ "$(git -C "$tp" rev-parse HEAD 2>/dev/null)" != "$TERMUX_PACKAGES_COMMIT" ]; then
  git -C "$tp" fetch -q --depth 1 origin "$TERMUX_PACKAGES_COMMIT"
  git -C "$tp" checkout -q -f FETCH_HEAD
fi

# 包名 → 前缀。properties.sh 写明这是 fork 时可以安全修改的变量之一
sed -i "s/^TERMUX_APP__PACKAGE_NAME=\"com.termux\"/TERMUX_APP__PACKAGE_NAME=\"$APP_PACKAGE\"/" "$tp/scripts/properties.sh"
grep -q "^TERMUX_APP__PACKAGE_NAME=\"$APP_PACKAGE\"" "$tp/scripts/properties.sh" || { echo "改包名失败：properties.sh 的格式变了" >&2; exit 1; }

cd "$tp"
for arch in $ARCHES; do
  echo "== 编译 $arch：$PACKAGES"
  # -f：即使输出目录里已有也重新打包；依赖不加 -i，全部按新前缀从源码编译（官方仓库的预编译包前缀是 com.termux，不能用）
  ./scripts/run-docker.sh ./build-package.sh -a "$arch" $PACKAGES
done
echo "产物：$tp/output"
