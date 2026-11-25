#!/usr/bin/env bash
# scripts/gen-sums.sh 的测试：用一次性 Ed25519 密钥签发真实格式的清单，
# 再用 scripts/install.sh 从这个「假发布源」完成一次验签安装。
# 不联网、不 sudo；缺依赖以 77 跳过。
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
GEN="$ROOT/scripts/gen-sums.sh"
INSTALLER="$ROOT/scripts/install.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/qz-gen-sums-test.XXXXXX") || exit 1
N=0
FAILED=0
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

skip_all() { printf 'SKIP: %s\n' "$*"; exit 77; }

for tool in openssl python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || skip_all "missing dependency: $tool"
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || skip_all "missing dependency: sha256sum or shasum"
[ -x "$GEN" ] || { printf 'FAIL: generator not executable: %s\n' "$GEN"; exit 1; }
[ -f "$INSTALLER" ] || { printf 'FAIL: installer not found\n'; exit 1; }

check() {
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
expect_nonzero() { if "$@" >"$WORK/run.out" 2>&1; then printf 'expected a non-zero exit\n'; sed 's/^/    /' "$WORK/run.out"; return 1; fi; }
expect_contains() { grep -q -- "$2" "$1" || { printf 'want %s in %s\n' "$2" "$1"; return 1; }; }

mkdir -p "$WORK/keys" "$WORK/srv/v1.0.0"
openssl genpkey -algorithm ed25519 -out "$WORK/keys/release.pem" >/dev/null 2>&1 || skip_all "openssl cannot generate Ed25519 keys"
PUB=$(openssl pkey -in "$WORK/keys/release.pem" -pubout -outform DER 2>/dev/null | tail -c 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 假资产：bin/qz 健康（打印版本），与 install.sh 的资产命名一致。
REL="$WORK/srv/v1.0.0"
STAGE="$WORK/stage"
mkdir -p "$STAGE/bin"
cat >"$STAGE/bin/qz" <<'STUB'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then printf 'qz 1.0.0\n'; exit 0; fi
exit 0
STUB
printf '#!/bin/sh\nexit 0\n' >"$STAGE/bin/quetzalcoatld"
printf '#!/bin/sh\nexit 0\n' >"$STAGE/bin/quetzalcoatl-sandbox-exec"
chmod 0755 "$STAGE/bin/qz" "$STAGE/bin/quetzalcoatld" "$STAGE/bin/quetzalcoatl-sandbox-exec"
tar -czf "$REL/quetzalcoatl-1.0.0-linux-x64.tar.gz" -C "$STAGE" bin

# ---------------------------------------------------------------- signing
check "gen-sums signs a release directory" bash "$GEN" "$REL" --tag v1.0.0 --commit 0123456789abcdef0123456789abcdef01234567 --key "$WORK/keys/release.pem"
check "SHA256SUMS lists the artifact with a 64-hex hash" bash -c "grep -Eq '^[0-9a-f]{64}  quetzalcoatl-1.0.0-linux-x64\\.tar\\.gz$' '$REL/SHA256SUMS'"
check "SHA256SUMS carries the commit line for the tag" expect_contains "$REL/SHA256SUMS" "commit 0123456789abcdef0123456789abcdef01234567 v1.0.0"
check "SHA256SUMS.sig is base64 text" bash -c "openssl base64 -d -A -in '$REL/SHA256SUMS.sig' -out '$WORK/sig.bin' && [ \$(wc -c <'$WORK/sig.bin') -eq 64 ]"
check "gen-sums --check accepts the freshly signed release" bash "$GEN" "$REL" --tag v1.0.0 --check --key "$WORK/keys/release.pem"

# ---------------------------------------------------------------- tamper detection
cp "$REL/quetzalcoatl-1.0.0-linux-x64.tar.gz" "$WORK/asset.bak"
printf 'tampered' >>"$REL/quetzalcoatl-1.0.0-linux-x64.tar.gz"
check "gen-sums --check rejects a tampered artifact" expect_nonzero bash "$GEN" "$REL" --tag v1.0.0 --check --key "$WORK/keys/release.pem"
cp "$WORK/asset.bak" "$REL/quetzalcoatl-1.0.0-linux-x64.tar.gz"
printf 'not-base64!' >"$REL/SHA256SUMS.sig"
check "gen-sums --check rejects a broken signature" expect_nonzero bash "$GEN" "$REL" --tag v1.0.0 --check --key "$WORK/keys/release.pem"

# 重新签回正确状态，并验证 RELEASE_SIGNING_KEY（PEM 文本）这条路径。
check "gen-sums accepts the key as PEM text via RELEASE_SIGNING_KEY" bash -c \
  "RELEASE_SIGNING_KEY=\"\$(cat '$WORK/keys/release.pem')\" bash '$GEN' '$REL' --tag v1.0.0 --commit 0123456789abcdef0123456789abcdef01234567"
check "the env-key signature verifies" bash "$GEN" "$REL" --tag v1.0.0 --check --key "$WORK/keys/release.pem"

# ---------------------------------------------------------------- install from it
SERVER_PID=""
start_server() {
  local port try i
  for try in 1 2 3 4 5; do
    port=$((20000 + ($$ + try * 613) % 20000))
    python3 -m http.server "$port" --bind 127.0.0.1 --directory "$WORK/srv" >"$WORK/server.log" 2>&1 &
    SERVER_PID=$!
    i=0
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
start_server

HOME_DIR="$WORK/home"
check "install.sh installs from the generated manifest" bash -c \
  "HOME='$HOME_DIR' QZ_PREFIX='$HOME_DIR/prefix' QUETZALCOATL_HOME='$HOME_DIR/qzhome' QZ_RELEASE_BASE='$BASE/v1.0.0' QZ_TEST_RELEASE_PUBKEY='$PUB' QZ_ALLOW_TEST_PUBKEY=1 QZ_SKIP_SERVICE=1 bash '$INSTALLER' --version 1.0.0 --no-desktop"
check "installed qz comes from the signed fake release" bash -c "'$HOME_DIR/prefix/bin/qz' --version | grep -q '1.0.0'"

printf '\n%d checks, %d failed\n' "$N" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
