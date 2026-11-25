#!/usr/bin/env bash
# 校验发布签名密钥与安装器内置的生产公钥是否一致。
#
#   scripts/check-release-key.sh [--key FILE] [--expect-key BASE64URL] [--print-pubkey]
#
# 为什么必须有这一步：`scripts/gen-sums.sh --check` 用同一把私钥导出公钥验签，
# 只能证明「签名文件没坏」，不能证明「用户机器上的安装器认得这把钥匙」。若
# RELEASE_SIGNING_KEY 与 scripts/install.sh / scripts/install.ps1 内置公钥分叉，
# 发版流水线会全绿，而所有用户的安装都会验签失败。本脚本把该分叉变成发版阻断错误。
#
# 私钥来源与 gen-sums.sh 完全一致（--key / RELEASE_SIGNING_KEY_FILE / RELEASE_SIGNING_KEY）；
# 私钥绝不打印、绝不落进仓库。
#
#   --expect-key  与给定公钥比较（测试/诊断用；默认比较安装器内置公钥）
#   --print-pubkey 只打印派生出的 raw-32 字节公钥（base64url），不做比较
#
# 退出码：0 一致；1 不一致或输入不可读。

set -u
set -o pipefail

KEY_FILE="${RELEASE_SIGNING_KEY_FILE:-}"
EXPECT_KEY=""
PRINT_ONLY=0
TMP=""

say() { printf '%s\n' "$*"; }
die() { printf 'x %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

cleanup() { if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/check-release-key.sh [options]
  --key FILE        PKCS#8 Ed25519 private key (or RELEASE_SIGNING_KEY_FILE / RELEASE_SIGNING_KEY)
  --expect-key KEY  compare against this raw-32-byte base64url public key (tests only)
  --print-pubkey    print the derived public key (base64url) and exit
  --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --key) [ $# -ge 2 ] || die "--key needs a value"; KEY_FILE=$2; shift 2 ;;
    --key=*) KEY_FILE=${1#*=}; shift ;;
    --expect-key) [ $# -ge 2 ] || die "--expect-key needs a value"; EXPECT_KEY=$2; shift 2 ;;
    --expect-key=*) EXPECT_KEY=${1#*=}; shift ;;
    --print-pubkey) PRINT_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) die "unexpected argument: $1" ;;
  esac
done

have openssl || die "missing dependency: openssl"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/qz-check-key.XXXXXX") || die "could not create a temp dir"

if [ -z "$KEY_FILE" ] && [ -n "${RELEASE_SIGNING_KEY:-}" ]; then
  KEY_FILE="$TMP/release.pem"
  ( umask 077; printf '%s\n' "$RELEASE_SIGNING_KEY" >"$KEY_FILE" )
fi
[ -n "$KEY_FILE" ] || die "no private key: pass --key, RELEASE_SIGNING_KEY_FILE or RELEASE_SIGNING_KEY"
[ -f "$KEY_FILE" ] || die "private key file not found: $KEY_FILE"

openssl pkey -in "$KEY_FILE" -pubout -outform DER -out "$TMP/pub.der" 2>/dev/null \
  || die "cannot read an Ed25519 private key from the given path"
PUB=$(tail -c 32 "$TMP/pub.der" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
[ ${#PUB} -eq 43 ] || die "unexpected public key encoding (${#PUB} chars)"
FINGERPRINT=$(printf '%s' "$PUB" | openssl dgst -sha256 -r 2>/dev/null | cut -d' ' -f1)

if [ "$PRINT_ONLY" = 1 ]; then
  say "$PUB"
  exit 0
fi

# 从安装器源码里取内置公钥：`RELEASE_PUBKEY="..."` 与 `$script:ReleasePubKey = '...'`。
embedded_key() { # file marker
  grep -oE "(RELEASE_PUBKEY|ReleasePubKey)[^\"']*[\"'][A-Za-z0-9_-]{43}[\"']" "$1" \
    | head -n 1 | grep -oE "[A-Za-z0-9_-]{43}" | head -n 1
}

check_one() { # file label
  local file=$1 label=$2 key
  [ -f "$file" ] || die "missing installer: $file"
  key=$(embedded_key "$file")
  [ -n "$key" ] || die "cannot locate the embedded release key in $file"
  if [ "$key" != "$PUB" ]; then
    say "x $label embedded key: $key" >&2
    say "x RELEASE_SIGNING_KEY public key: $PUB (sha256 $FINGERPRINT)" >&2
    die "release key does not match $file; users would fail signature verification"
  fi
  say "  $label ok ($file)"
}

if [ -n "$EXPECT_KEY" ]; then
  if [ "$EXPECT_KEY" != "$PUB" ]; then
    say "x expected public key: $EXPECT_KEY" >&2
    say "x RELEASE_SIGNING_KEY public key: $PUB (sha256 $FINGERPRINT)" >&2
    die "release key does not match the expected public key"
  fi
  say "  expected key ok"
else
  check_one "scripts/install.sh" "install.sh"
  check_one "scripts/install.ps1" "install.ps1"
  check_one "scripts/install.src.ps1" "install.src.ps1"
fi

say "release key matches the installer trust root (sha256 $FINGERPRINT)"
