#!/usr/bin/env bash
# 发版时取用以往编好的同一份安卓运行环境，免得每次都从源码重编 Node.js（几个小时）。只在 CI 里用。
#   配方哈希 = versions.env、build-packages.sh、pack.sh、网状层组件的安装程序，以及锁定文件里安卓用得到的部分（common 与 platform.android-arm64，
#   规整成固定格式）的内容哈希：这些都没变，编出来的运行环境就相同。锁定文件里别的平台（Linux、Windows）变了不影响安卓，不该让它重编几个小时。
#   依次尝试：
#     1. 以往 Release 上的 quetzal-android-runtime-<配方哈希>.tar.gz：先用内置的发布公钥核对那个 Release 的 SHA256SUMS.sig，
#        再核对资产的 sha256 在签名过的清单里——核对不过就不用；
#     2. 本仓库发版工作流以往的运行里同一配方编好的产物（android-runtime）：只认 v* 标签触发、这个 job 成功的运行，
#        并用那次运行的提交重新算配方哈希，必须相同。
#   都没有时退出码 1，由工作流从源码编译。找到时解开到 android/app/src/main/，并把资产文件放到 $OUT（供本次 Release 再带上）。
# 环境：GH_TOKEN（只读）、GITHUB_REPOSITORY、RELEASE_PUBKEY（Ed25519 公钥，JWK 的 x）、OUT（输出目录）
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
main="$repo_root/console/android/app/src/main"
RECIPE=(console/tool/android-runtime/versions.env console/tool/android-runtime/build-packages.sh console/tool/android-runtime/pack.sh runtime/tool/install-mesh-modules.mjs)
LOCK=runtime/tool/mesh-modules.lock.json
# 锁定文件里安卓用得到的部分，规整成固定格式（键排序）
android_lock() { node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{const d=JSON.parse(s);const sort=(v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map((k)=>[k,sort(v[k])])):v;process.stdout.write(JSON.stringify(sort({common:d.common,android:d.platform["android-arm64"]})))})'; }

recipe_key() { # [提交]：在工作区或某个提交上算配方哈希
  if [ $# -eq 0 ]; then (cd "$repo_root" && cat "${RECIPE[@]}" && android_lock < "$LOCK") | sha256sum | cut -c1-16
  else (cd "$repo_root" && for f in "${RECIPE[@]}"; do git show "$1:$f" || return 1; done && git show "$1:$LOCK" | android_lock) | sha256sum | cut -c1-16; fi
}
KEY=$(recipe_key)
NAME="quetzal-android-runtime-$KEY.tar.gz"
echo "key=$KEY" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "配方哈希 $KEY"
work=$(mktemp -d)
mkdir -p "$OUT"

install_from() { # 归档 → 解开到 android/app/src/main，检查结构
  rm -rf "$main/jniLibs" "$main/assets/runtime-env"
  tar -xzf "$1" -C "$main"
  [ -f "$main/jniLibs/arm64-v8a/libnode.so" ] && [ -f "$main/assets/runtime-env/rootfs.tar" ] && [ -f "$main/assets/runtime-env/manifest.json" ]
}

# 1. 以往 Release 上签名核对过的资产
for tag in $(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=30" --jq '.[] | select(.draft == false) | .tag_name'); do
  gh release view "$tag" -R "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name' | grep -qx "$NAME" || continue
  d="$work/$tag"; mkdir -p "$d"
  gh release download "$tag" -R "$GITHUB_REPOSITORY" -D "$d" -p "$NAME" -p SHA256SUMS -p SHA256SUMS.sig || continue
  if node -e '
    const c = require("crypto"), f = require("fs");
    const pub = c.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: process.env.RELEASE_PUBKEY }, format: "jwk" });
    const data = f.readFileSync(process.argv[1]), sig = Buffer.from(f.readFileSync(process.argv[2], "utf8").trim(), "base64");
    process.exit(c.verify(null, data, pub, sig) ? 0 : 1);' "$d/SHA256SUMS" "$d/SHA256SUMS.sig" \
    && (cd "$d" && grep "  $NAME\$" SHA256SUMS | sha256sum -c --status -); then
    install_from "$d/$NAME" && cp "$d/$NAME" "$OUT/" && { echo "取用 $tag 发布的运行环境（签名与 sha256 核对通过）"; exit 0; }
  fi
  echo "::warning::$tag 上的 $NAME 核对不过，不用它"
done

# 2. 以往发版运行里同一配方编好的产物
for run in $(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/release.yml/runs?event=push&per_page=20" --jq '.workflow_runs[] | select(.head_branch | startswith("v")) | "\(.id):\(.head_sha)"'); do
  id=${run%%:*}; sha=${run#*:}
  [ "$id" = "${GITHUB_RUN_ID:-}" ] && continue
  ok=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?per_page=50" --jq '.jobs[] | select(.name == "android-runtime") | .conclusion' 2>/dev/null || true)
  [ "$ok" = success ] || continue
  git -C "$repo_root" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$repo_root" fetch -q --depth 1 origin "$sha" || continue
  [ "$(recipe_key "$sha" 2>/dev/null)" = "$KEY" ] || continue
  d="$work/run-$id"; mkdir -p "$d"
  gh run download "$id" -R "$GITHUB_REPOSITORY" -n android-runtime -D "$d" || continue
  [ -f "$d/jniLibs/arm64-v8a/libnode.so" ] || continue
  tar -czf "$OUT/$NAME" -C "$d" jniLibs assets/runtime-env
  install_from "$OUT/$NAME" && { echo "取用发版运行 $id（提交 ${sha:0:7}）里同一配方编好的运行环境"; exit 0; }
done

echo "没有可取用的运行环境：从源码编译"
exit 1
