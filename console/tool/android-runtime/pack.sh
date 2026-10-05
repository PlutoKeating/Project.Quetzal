#!/usr/bin/env bash
# 把 build-packages.sh 编出的 .deb 拆成 APK 的两部分（只装一个 App）：
#   - android/app/src/main/jniLibs/arm64-v8a/lib<名>.so：前缀里每个可执行的 ELF（有 PT_INTERP 的）。安装时系统解压到 nativeLibraryDir，
#     那是 Android 10+ 唯一允许 App 执行的位置；内容相同的（git 的内置子命令是同一个文件的硬链接）只放一份。
#   - android/app/src/main/assets/runtime-env/rootfs.tar（原生资源，不经 Flutter；不另行压缩，APK 本身是压缩的）：其余文件（共享库、证书、git 模板……），去掉头文件、手册、静态库；外加网状层的原生组件
#     （node-datachannel，按 runtime/tool/mesh-modules.lock.json 的版本与 sha512 下载核对）放在 usr/lib/quetzal/node_modules。
#   - 同目录的 manifest.json：{version, exec: {前缀里的路径: lib 文件名}}，App 据此在前缀里建符号链接（见 Rootfs.kt）。
# 产物都不入库。用法：tool/android-runtime/pack.sh [工作目录]（与 build-packages.sh 相同，默认 build/android-runtime）
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
console="$(cd "$here/../.." && pwd)"
. "$here/versions.env"
work="${1:-$console/build/android-runtime}"
work="$(cd "$work" && pwd)"
out="$work/termux-packages/output"
stage="$work/stage"
jni="$console/android/app/src/main/jniLibs/arm64-v8a"
assets="$console/android/app/src/main/assets/runtime-env"
P="data/data/$APP_PACKAGE/files"   # deb 里的路径前缀

command -v dpkg-deb >/dev/null || { echo "需要 dpkg-deb" >&2; exit 1; }
ls "$out"/*_aarch64.deb >/dev/null 2>&1 || { echo "没有找到编好的 .deb：先运行 build-packages.sh" >&2; exit 1; }
rm -rf "$stage" "$jni" "$assets"
mkdir -p "$stage" "$jni" "$assets"

# 1. 只解开 PACKAGES 的运行时依赖闭包（output 里还有编译时顺带产生的包：git-gui、subversion、X11……）
debs=$(python3 - "$out" $PACKAGES <<'PY'
import glob, os, re, subprocess, sys
out, want = sys.argv[1], sys.argv[2:]
debs = {}
for f in glob.glob(os.path.join(out, '*.deb')):
    if not (f.endswith('_aarch64.deb') or f.endswith('_all.deb')): continue
    name = subprocess.run(['dpkg-deb', '-f', f, 'Package'], capture_output=True, text=True).stdout.strip()
    debs[name] = f
seen, stack = [], list(want)
while stack:
    n = stack.pop()
    if n in seen: continue
    if n not in debs: sys.exit(f'缺少依赖包：{n}')
    seen.append(n)
    dep = subprocess.run(['dpkg-deb', '-f', debs[n], 'Depends'], capture_output=True, text=True).stdout
    for part in filter(None, (x.strip() for x in dep.split(','))):
        stack.append(re.sub(r'\s*\(.*?\)', '', part.split('|')[0]).strip())
print('\n'.join(debs[n] for n in sorted(seen)))
PY
)
echo "解包 $(echo "$debs" | wc -l) 个包"
for deb in $debs; do dpkg-deb -x "$deb" "$stage"; done
usr="$stage/$P/usr"
[ -x "$usr/bin/node" ] || { echo "解包后没有 bin/node" >&2; exit 1; }

# 2. 裁掉运行时用不到的
rm -rf "$usr/include" "$usr/share/man" "$usr/share/doc" "$usr/share/info" "$usr/share/locale" "$usr/lib/pkgconfig" "$usr/share/aclocal" "$usr/share/gtk-doc"
find "$usr" -name '*.a' -delete

# 3. 网状层的原生组件（与 Termux 安装器同一份锁定文件与安装程序）
mkdir -p "$usr/lib/quetzal"
node "$console/../runtime/tool/install-mesh-modules.mjs" "$console/../runtime/tool/mesh-modules.lock.json" "$usr/lib/quetzal" android-arm64 https://registry.npmjs.org https://registry.npmmirror.com
# 官方预编译的 .node 带着完整调试信息（约 48 MB）：核对 sha512 之后剥掉
strip="$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/ndk/*/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip 2>/dev/null | tail -1)"
[ -x "$strip" ] || { echo "需要 Android NDK 的 llvm-strip（ANDROID_HOME/ndk/*）" >&2; exit 1; }
find "$usr/lib/quetzal" -name '*.node' -exec "$strip" --strip-unneeded {} +

# 4. 可执行的 ELF → jniLibs；记下映射
python3 - "$usr" "$jni" "$assets/manifest.json" "$EXEC_KEEP" <<'PY'
import hashlib, json, os, subprocess, sys
usr, jni, manifest_path, keep = sys.argv[1:]
keep = set(keep.split())
digest = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
kept_hashes = {digest(os.path.join(usr, k)) for k in keep if os.path.isfile(os.path.join(usr, k))}
missing = [k for k in keep if not os.path.exists(os.path.join(usr, k))]
if missing: sys.exit(f'白名单里的可执行文件不存在：{missing}')
def is_exec(p):
    with open(p, 'rb') as f:
        if f.read(4) != b'\x7fELF': return False
    out = subprocess.run(['readelf', '-lW', p], capture_output=True, text=True).stdout
    return 'Requesting program interpreter' in out or 'INTERP' in out
by_hash, exec_map, used = {}, {}, set()
for top in ('bin', 'libexec'):
    root = os.path.join(usr, top)
    for d, _, files in os.walk(root):
        for n in sorted(files):
            p = os.path.join(d, n)
            rel = os.path.relpath(p, usr)
            if os.path.islink(p) or not os.path.isfile(p): continue
            if not (is_exec(p) or (rel in keep and open(p, 'rb').read(4) == b'\x7fELF')): continue  # 白名单里的静态 ELF（proot 的 loader）也算
            h = digest(p)
            if os.path.relpath(p, usr) not in keep and h not in kept_hashes: os.remove(p); continue  # 用不上的程序：不打包
            if h not in by_hash:
                lib = 'lib' + n.replace('+', 'plus') + '.so'
                k = 2
                while lib in used: lib = f'lib{n}-{k}.so'; k += 1
                used.add(lib); by_hash[h] = lib
                os.replace(p, os.path.join(jni, lib))
            else:
                os.remove(p)
            exec_map['usr/' + os.path.relpath(p, usr)] = by_hash[h]
json.dump({'exec': exec_map}, open(manifest_path, 'w'), ensure_ascii=False, indent=1)
print(f'可执行文件 {len(exec_map)} 个 → {len(by_hash)} 个 lib*.so')
PY
chmod 755 "$jni"/*.so

# 5. 其余文件打包（GNU 格式：长路径用 L 记录，Rootfs.kt 的 tar 读取支持）；版本 = 内容哈希，App 据此判断要不要重新解压
( cd "$stage/$P" && tar --format=gnu --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01' -cf - usr ) > "$assets/rootfs.tar"   # 不另行压缩：APK 本身是压缩的，AGP 也会把资源里的 .gz 解开
ver="$TERMUX_PACKAGES_COMMIT-$( (cat "$assets/rootfs.tar"; cat "$jni"/*.so) | sha256sum | cut -c1-12)"
python3 - "$assets/manifest.json" "$ver" <<'PY'
import json, sys
p, v = sys.argv[1:]
m = json.load(open(p)); m = {'version': v, **m}
json.dump(m, open(p, 'w'), ensure_ascii=False, indent=1)
PY
echo "运行环境 $ver：rootfs $(du -h "$assets/rootfs.tar" | cut -f1)，jniLibs $(du -sh "$jni" | cut -f1)"
