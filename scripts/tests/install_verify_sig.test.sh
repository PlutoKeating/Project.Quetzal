#!/usr/bin/env bash
# Quetzalcoatl 安装器测试：本地假发布源 + 一次性 Ed25519 密钥对。
#
# 覆盖：架构/平台识别、签名通过后安装、篡改清单（签名失效）中止、篡改产物（哈希失效）中止、
#       坏签名中止、升级健康检查失败自动回滚、镜像回退、幂等升级、卸载与 --purge、纯 Perl 验签回退。
#
# 不联网、不 sudo、不触碰真实家目录或服务管理器：HOME、prefix、QUETZALCOATL_HOME 全部指向临时目录，
# QZ_SKIP_SERVICE=1 只写 unit/plist，不调用 systemctl/launchctl。
# 依赖：bash、openssl（生成密钥与签名）、python3（假发布源）、sha256sum/shasum。
# 缺依赖时以 77 跳过（与 automake 约定一致），绝不伪造通过。
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
INSTALLER="$ROOT/scripts/install.sh"
KEYCHECK="$ROOT/scripts/check-release-key.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/qz-installer-test.XXXXXX") || exit 1
SRV="$WORK/srv"
N=0
FAILED=0

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

skip_all() {
  printf 'SKIP: %s\n' "$*"
  exit 77
}

for tool in openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || skip_all "missing dependency: $tool"
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || skip_all "missing dependency: sha256sum or shasum"
[ -f "$INSTALLER" ] || { printf 'FAIL: installer not found: %s\n' "$INSTALLER"; exit 1; }
[ -x "$KEYCHECK" ] || { printf 'FAIL: release key checker not executable: %s\n' "$KEYCHECK"; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

check() { # name command...
  N=$((N + 1))
  local name=$1
  shift
  if "$@" >"$WORK/check.out" 2>&1; then
    printf 'ok %d - %s\n' "$N" "$name"
  else
    printf 'not ok %d - %s\n' "$N" "$name"
    sed 's/^/    /' "$WORK/check.out"
    FAILED=$((FAILED + 1))
  fi
}

# 断言封装（供 check 调用）
expect_eq() { [ "$1" = "$2" ] || { printf 'want %s, got %s\n' "$2" "$1"; return 1; }; }
expect_contains() { grep -q -- "$2" "$1" || { printf 'want %s in %s\n' "$2" "$1"; sed 's/^/    /' "$1"; return 1; }; }
expect_absent() { [ ! -e "$1" ] || { printf 'should not exist: %s\n' "$1"; return 1; }; }
expect_nonzero() { if "$@" >"$WORK/run.out" 2>&1; then printf 'expected a non-zero exit\n'; sed 's/^/    /' "$WORK/run.out"; return 1; fi; }
expect_zero() { "$@" >"$WORK/run.out" 2>&1 || { printf 'expected exit 0\n'; sed 's/^/    /' "$WORK/run.out"; return 1; }; }

# ---------------------------------------------------------------- keypair
mkdir -p "$WORK/keys" "$SRV"
openssl genpkey -algorithm ed25519 -out "$WORK/keys/release.pem" >/dev/null 2>&1 || skip_all "openssl cannot generate Ed25519 keys"
openssl pkey -in "$WORK/keys/release.pem" -pubout -outform DER -out "$WORK/keys/pub.der" >/dev/null 2>&1 \
  || skip_all "openssl cannot export an Ed25519 public key"
PUB=$(tail -c 32 "$WORK/keys/pub.der" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
[ ${#PUB} -eq 43 ] || { printf 'FAIL: unexpected public key encoding (%s chars)\n' "${#PUB}"; exit 1; }
# 生产公钥不可被运行时覆盖：测试必须同时打开这个闸门（覆盖本身仍要显式）。
export QZ_ALLOW_TEST_PUBKEY=1

# ---------------------------------------------------------------- fake release
# mk_release <version> <healthy 0|1> [target-dir] [reported-version]
mk_release() {
  local version=$1 healthy=$2 dir=${3:-"$SRV/v$1"} name base stage reported=${4:-$1}
  base="quetzalcoatl-$version-linux-x64"
  stage="$WORK/stage-$version"
  rm -rf "$stage"
  mkdir -p "$stage/bin" "$dir"
  if [ "$healthy" = 1 ]; then
    cat >"$stage/bin/qz" <<STUB
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then printf 'qz $reported\n'; exit 0; fi
exit 0
STUB
  else
    cat >"$stage/bin/qz" <<STUB
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then printf 'qz $version: unusable\n'; exit 3; fi
exit 0
STUB
  fi
  printf '#!/bin/sh\nexit 0\n' >"$stage/bin/quetzalcoatld"
  printf '#!/bin/sh\nexit 0\n' >"$stage/bin/quetzalcoatl-sandbox-exec"
  mkdir -p "$stage/bin/web"
  printf '<!doctype html><meta charset="utf-8"><title>Quetzalcoatl console</title>\n' >"$stage/bin/web/index.html"
  chmod 0755 "$stage/bin/qz" "$stage/bin/quetzalcoatld" "$stage/bin/quetzalcoatl-sandbox-exec"
  tar -czf "$dir/$base.tar.gz" -C "$stage" bin
  {
    printf '%s  %s\n' "$(sha256 "$dir/$base.tar.gz")" "$base.tar.gz"
    printf 'commit %s v%s\n' "0123456789abcdef0123456789abcdef01234567" "$version"
  } >"$dir/SHA256SUMS"
  openssl pkeyutl -sign -inkey "$WORK/keys/release.pem" -rawin -in "$dir/SHA256SUMS" -out "$WORK/sig.bin" >/dev/null 2>&1 \
    || { printf 'FAIL: openssl cannot sign with Ed25519\n'; exit 1; }
  openssl base64 -A -in "$WORK/sig.bin" >"$dir/SHA256SUMS.sig"
}

mk_release 1.0.0 1
mk_release 1.1.0 0
# 资产名是 1.2.0，但二进制自报 1.2.0-alpha.1：精确版本门禁必须拒绝（防 alpha 冒充正式版）。
mk_release 1.2.0 1 "" 1.2.0-alpha.1
cp -R "$SRV/v1.0.0" "$SRV/tampered-sums"
cp -R "$SRV/v1.0.0" "$SRV/tampered-artifact"
cp -R "$SRV/v1.0.0" "$SRV/bad-signature"
# 清单被改（签名不再匹配）
sed 's/^\(.\)/\1/' "$SRV/tampered-sums/SHA256SUMS" >/dev/null 2>&1
python3 - "$SRV/tampered-sums/SHA256SUMS" <<'PY'
import sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
for i, line in enumerate(lines):
    if len(line) > 64 and line[64:66] == "  ":
        h = line[:64]
        lines[i] = ("0" if h[0] != "0" else "1") + h[1:] + line[64:]
        break
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
# 产物被改（清单签名仍有效，哈希不再匹配）
printf 'tampered' >>"$SRV/tampered-artifact/quetzalcoatl-1.0.0-linux-x64.tar.gz"
# 签名本身是垃圾
printf 'bm90IGEgc2lnbmF0dXJl' >"$SRV/bad-signature/SHA256SUMS.sig"

# ---------------------------------------------------------------- fake server
SERVER_PID=""
start_server() {
  local port try
  for try in 1 2 3 4 5; do
    port=$((20000 + ($$ + try * 977) % 20000))
    python3 -m http.server "$port" --bind 127.0.0.1 --directory "$SRV" >"$WORK/server.log" 2>&1 &
    SERVER_PID=$!
    local i=0
    while [ $i -lt 50 ]; do
      if curl -fsS -m 1 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
        BASE="http://127.0.0.1:$port"
        return 0
      fi
      i=$((i + 1))
      sleep 0.1
    done
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  done
  skip_all "could not start the local release server"
}
command -v curl >/dev/null 2>&1 || skip_all "missing dependency: curl"
start_server

# ---------------------------------------------------------------- helpers
env_for() { # home-dir -> prints env assignments used by every run
  printf '%s' "$1"
}

run_installer() { # home case-name release-base args...
  local home=$1 case=$2 base=$3
  shift 3
  HOME="$home" \
  QZ_PREFIX="$home/prefix" \
  QUETZALCOATL_HOME="$home/qzhome" \
  QZ_RELEASE_BASE="$base" \
  QZ_TEST_RELEASE_PUBKEY="$PUB" \
  QZ_SKIP_SERVICE=1 \
  bash "$INSTALLER" "$@"
}

# ---------------------------------------------------------------- 1. platform detection
check "platform detection: linux x64" bash -c \
  "QZ_OS=Linux QZ_ARCH=x86_64 bash '$INSTALLER' --print-platform | grep -qx 'linux x64'"
check "platform detection: macOS Apple silicon" bash -c \
  "QZ_OS=Darwin QZ_ARCH=arm64 bash '$INSTALLER' --print-platform | grep -qx 'macos arm64'"
check "platform detection: unknown CPU is rejected" bash -c \
  "! QZ_OS=Linux QZ_ARCH=riscv64 bash '$INSTALLER' --print-platform >/dev/null 2>&1"
check "platform detection: unknown OS is rejected" bash -c \
  "! QZ_OS=Plan9 QZ_ARCH=x86_64 bash '$INSTALLER' --print-platform >/dev/null 2>&1"

# ---------------------------------------------------------------- 1b. release-key trust root
check "check-release-key derives the expected raw public key" bash -c \
  "[ \"\$('$KEYCHECK' --key '$WORK/keys/release.pem' --print-pubkey)\" = '$PUB' ]"
check "check-release-key accepts a matching expected key" \
  bash "$KEYCHECK" --key "$WORK/keys/release.pem" --expect-key "$PUB"
check "check-release-key rejects a diverged expected key" expect_nonzero \
  bash "$KEYCHECK" --key "$WORK/keys/release.pem" --expect-key "QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8"
check "check-release-key rejects a key that is not the installer trust root" expect_nonzero \
  bash "$KEYCHECK" --key "$WORK/keys/release.pem"

# ---------------------------------------------------------------- 2. good signature installs
C1="$WORK/c1"
mkdir -p "$C1"
check "good signature + sha256 installs" run_installer "$C1" good "$BASE/v1.0.0" --version 1.0.0 --no-desktop
check "installed qz reports the requested version" bash -c \
  "'$C1/prefix/bin/qz' --version | grep -q '1.0.0'"
check "web console lands in bin/web next to the daemon" test -f "$C1/prefix/bin/web/index.html"
check "systemd user unit written (not enabled)" test -f "$C1/.config/systemd/user/quetzalcoatld.service"
check "unit points at the installed daemon" expect_contains \
  "$C1/.config/systemd/user/quetzalcoatld.service" "$C1/prefix/bin/quetzalcoatld"
check "state dir records the installed version" expect_contains "$C1/.local/share/quetzalcoatl/installed-version" "1.0.0"
check "installer never invokes sudo" bash -c "! grep -Eq '^[[:space:]]*sudo([[:space:]]|$)|\\\$\([[:space:]]*sudo|&&[[:space:]]*sudo|[;|][[:space:]]*sudo' '$INSTALLER'"

# ---------------------------------------------------------------- 3. idempotent re-run
check "second run is an idempotent upgrade" run_installer "$C1" again "$BASE/v1.0.0" --version 1.0.0 --no-desktop
check "still reports the same version after re-run" bash -c "'$C1/prefix/bin/qz' --version | grep -q '1.0.0'"

# ---------------------------------------------------------------- 3b. exact version gate
C1B="$WORK/c1b"
mkdir -p "$C1B"
check "a prerelease qz cannot satisfy a stable version request" expect_nonzero bash -c \
  "HOME='$C1B' QZ_PREFIX='$C1B/prefix' QUETZALCOATL_HOME='$C1B/qzhome' QZ_RELEASE_BASE='$BASE/v1.2.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.2.0 --no-desktop"
check "nothing installed after the version mismatch" expect_absent "$C1B/prefix/bin/qz"

# ---------------------------------------------------------------- 4. mirror fallback
C2="$WORK/c2"
mkdir -p "$C2"
check "first mirror down, second source succeeds" bash -c \
  "HOME='$C2' QZ_PREFIX='$C2/prefix' QUETZALCOATL_HOME='$C2/qzhome' QZ_RELEASE_BASE='http://127.0.0.1:1/v1.0.0 $BASE/v1.0.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.0.0 --no-desktop"
check "fallback install produced qz" test -x "$C2/prefix/bin/qz"

# ---------------------------------------------------------------- 5. tampered manifest (signature)
C3="$WORK/c3"
mkdir -p "$C3"
check "tampered SHA256SUMS is rejected (bad signature)" expect_nonzero bash -c \
  "HOME='$C3' QZ_PREFIX='$C3/prefix' QUETZALCOATL_HOME='$C3/qzhome' QZ_RELEASE_BASE='$BASE/tampered-sums' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.0.0 --no-desktop"
check "nothing was installed from a tampered manifest" expect_absent "$C3/prefix/bin/qz"

# ---------------------------------------------------------------- 6. tampered artifact (hash)
C4="$WORK/c4"
mkdir -p "$C4"
check "tampered artifact fails the signed sha256" expect_nonzero bash -c \
  "HOME='$C4' QZ_PREFIX='$C4/prefix' QUETZALCOATL_HOME='$C4/qzhome' QZ_RELEASE_BASE='$BASE/tampered-artifact' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.0.0 --no-desktop"
check "nothing was installed from a tampered artifact" expect_absent "$C4/prefix/bin/qz"

# ---------------------------------------------------------------- 7. garbage signature
C5="$WORK/c5"
mkdir -p "$C5"
check "garbage signature is rejected" expect_nonzero bash -c \
  "HOME='$C5' QZ_PREFIX='$C5/prefix' QUETZALCOATL_HOME='$C5/qzhome' QZ_RELEASE_BASE='$BASE/bad-signature' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.0.0 --no-desktop"
check "nothing was installed from a garbage signature" expect_absent "$C5/prefix/bin/qz"

# ---------------------------------------------------------------- 8. wrong public key
C5B="$WORK/c5b"
mkdir -p "$C5B"
check "a different public key does not trust this release" expect_nonzero bash -c \
  "HOME='$C5B' QZ_PREFIX='$C5B/prefix' QUETZALCOATL_HOME='$C5B/qzhome' QZ_RELEASE_BASE='$BASE/v1.0.0' QZ_TEST_RELEASE_PUBKEY='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.0.0 --no-desktop"

# ---------------------------------------------------------------- 9. rollback on failed health check
C6="$WORK/c6"
mkdir -p "$C6"
run_installer "$C6" rollback-setup "$BASE/v1.0.0" --version 1.0.0 --no-desktop >/dev/null 2>&1
check "baseline 1.0.0 installed before the failed upgrade" bash -c "'$C6/prefix/bin/qz' --version | grep -q '1.0.0'"
check "unhealthy upgrade exits non-zero" expect_nonzero bash -c \
  "HOME='$C6' QZ_PREFIX='$C6/prefix' QUETZALCOATL_HOME='$C6/qzhome' QZ_RELEASE_BASE='$BASE/v1.1.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.1.0 --no-desktop"
check "rollback restored the previous qz" bash -c "'$C6/prefix/bin/qz' --version | grep -q '1.0.0'"
check "rollback is recorded in the installed-version file" expect_contains "$C6/.local/share/quetzalcoatl/installed-version" "1.0.0"
check "rollback message is printed" bash -c \
  "HOME='$C6' QZ_PREFIX='$C6/prefix' QUETZALCOATL_HOME='$C6/qzhome' QZ_RELEASE_BASE='$BASE/v1.1.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.1.0 --no-desktop 2>&1 | grep -qi 'rollback\\|rolling back\\|rolled back'"

# ---------------------------------------------------------------- 9b. openssl verifier explicitly
C6B="$WORK/c6b"
mkdir -p "$C6B"
check "openssl Ed25519 verifier accepts a good signature" bash -c \
  "HOME='$C6B' QZ_PREFIX='$C6B/prefix' QUETZALCOATL_HOME='$C6B/qzhome' QZ_RELEASE_BASE='$BASE/v1.0.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 QZ_VERIFIER=openssl bash '$INSTALLER' --version 1.0.0 --no-desktop"
check "openssl verifier rejects a tampered manifest" expect_nonzero bash -c \
  "HOME='$C6B' QZ_PREFIX='$C6B/prefix2' QUETZALCOATL_HOME='$C6B/qzhome2' QZ_RELEASE_BASE='$BASE/tampered-sums' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 QZ_VERIFIER=openssl bash '$INSTALLER' --version 1.0.0 --no-desktop"

# ---------------------------------------------------------------- 10. perl verifier fallback
if command -v perl >/dev/null 2>&1; then
  C7="$WORK/c7"
  mkdir -p "$C7"
  check "pure-perl Ed25519 verifier accepts a good signature" bash -c \
    "HOME='$C7' QZ_PREFIX='$C7/prefix' QUETZALCOATL_HOME='$C7/qzhome' QZ_RELEASE_BASE='$BASE/v1.0.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 QZ_VERIFIER=perl bash '$INSTALLER' --version 1.0.0 --no-desktop"
  check "pure-perl verifier installed qz" test -x "$C7/prefix/bin/qz"
  C8="$WORK/c8"
  mkdir -p "$C8"
  check "pure-perl verifier rejects a tampered manifest" expect_nonzero bash -c \
    "HOME='$C8' QZ_PREFIX='$C8/prefix' QUETZALCOATL_HOME='$C8/qzhome' QZ_RELEASE_BASE='$BASE/tampered-sums' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 QZ_VERIFIER=perl bash '$INSTALLER' --version 1.0.0 --no-desktop"
  check "nothing installed by the perl verifier on failure" expect_absent "$C8/prefix/bin/qz"
else
  printf 'ok %d - perl verifier skipped (no perl)\n' "$((N + 1))"
fi

# ---------------------------------------------------------------- 10b. failed first install leaves nothing behind
C9="$WORK/c9"
mkdir -p "$C9"
check "failed first install exits non-zero" expect_nonzero bash -c \
  "HOME='$C9' QZ_PREFIX='$C9/prefix' QUETZALCOATL_HOME='$C9/qzhome' QZ_RELEASE_BASE='$BASE/v1.1.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.1.0 --no-desktop"
check "failed first install removed its binaries" expect_absent "$C9/prefix/bin"
check "failed first install wrote no installed-version record" expect_absent "$C9/.local/share/quetzalcoatl/installed-version"
check "failed first install wrote no service unit" expect_absent "$C9/.config/systemd/user/quetzalcoatld.service"

# ---------------------------------------------------------------- 10c. version with a leading v
C10="$WORK/c10"
mkdir -p "$C10"
check "--version v1.0.0 is normalised, not doubled" run_installer "$C10" vprefix "$BASE/v1.0.0" --version v1.0.0 --no-desktop
check "v-prefixed request installed 1.0.0" bash -c "'$C10/prefix/bin/qz' --version | grep -q '1.0.0'"

# ---------------------------------------------------------------- 10d. test key override needs its gate
C11="$WORK/c11"
mkdir -p "$C11"
check "test public key override is refused without QZ_ALLOW_TEST_PUBKEY=1" expect_nonzero bash -c \
  "env -u QZ_ALLOW_TEST_PUBKEY HOME='$C11' QZ_PREFIX='$C11/prefix' QUETZALCOATL_HOME='$C11/qzhome' QZ_RELEASE_BASE='$BASE/v1.0.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.0.0 --no-desktop"
check "gated override installed nothing" expect_absent "$C11/prefix/bin/qz"

# ---------------------------------------------------------------- 11. uninstall
check "uninstall removes binaries and the unit, keeps the home" bash -c \
  "HOME='$C1' QZ_PREFIX='$C1/prefix' QUETZALCOATL_HOME='$C1/qzhome' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --uninstall"
check "uninstall removed qz" expect_absent "$C1/prefix/bin/qz"
check "uninstall removed the web console" expect_absent "$C1/prefix/bin/web"
check "uninstall removed the unit" expect_absent "$C1/.config/systemd/user/quetzalcoatld.service"
check "uninstall kept QUETZALCOATL_HOME without --purge" test -d "$C1/qzhome"
check "uninstall --purge removes QUETZALCOATL_HOME" bash -c \
  "HOME='$C1' QZ_PREFIX='$C1/prefix' QUETZALCOATL_HOME='$C1/qzhome' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --uninstall --purge && test ! -e '$C1/qzhome'"

# ---------------------------------------------------------------- 12. purge safety guards
C12="$WORK/c12"
mkdir -p "$C12/home" "$C12/home/sub"
printf 'keep\n' >"$C12/home/keep.txt"
printf 'keep\n' >"$C12/home/sub/keep.txt"
ln -sfn "$C12/home" "$C12/home-link"

purge_keeps() { # label qz_home home
  local label=$1 qz_home=$2 home=$3
  check "purge refuses $label" bash -c \
    "! HOME='$home' QUETZALCOATL_HOME='$qz_home' QZ_PREFIX='$C12/prefix' QZ_SKIP_SERVICE=1 bash '$INSTALLER' --uninstall --purge >/dev/null 2>&1"
  check "purge refusing $label deleted nothing" test -f "$home/keep.txt"
}

purge_keeps "HOME with a trailing slash" "$C12/home/" "$C12/home"
purge_keeps "HOME with /. appended" "$C12/home/." "$C12/home"
purge_keeps "a symlink that resolves to HOME" "$C12/home-link" "$C12/home"
purge_keeps "an ancestor of HOME" "$C12/home" "$C12/home/sub"

printf '\n%d checks, %d failed\n' "$N" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
