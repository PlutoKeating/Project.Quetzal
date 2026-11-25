#!/usr/bin/env bash
# 生成 / 校验发布签名清单：SHA256SUMS + SHA256SUMS.sig（Ed25519）。
#
#   scripts/gen-sums.sh <artifacts-dir> --tag vX.Y.Z [--commit <40hex>] [--key FILE]
#   scripts/gen-sums.sh <artifacts-dir> --tag vX.Y.Z --check [--key FILE]
#
# 产物格式与安装器解析的完全一致：
#   <sha256>  <文件名>        每个 quetzalcoatl-* 资产一行（两空格分隔）
#   commit <40 位提交> <tag>  钉住版本对应的源码提交
#   SHA256SUMS.sig            SHA256SUMS 的 Ed25519 签名（base64 文本）
#
# 私钥来源（按优先级）：
#   --key FILE / RELEASE_SIGNING_KEY_FILE   指向 PKCS#8 PEM 文件
#   RELEASE_SIGNING_KEY                     直接给出 PEM 文本（CI Secret 的常见形态；写入 0600 临时文件后使用）
# 私钥绝不打印、绝不落进仓库。
#
# `--check` 用私钥导出公钥重新验签，并逐字节核对清单与目录内容；任何不一致都以非零退出。
# 运行于 bash 3.2（macOS 自带）：不用关联数组、mapfile 或 ${var,,}。

set -u
set -o pipefail

DIR=""
TAG=""
COMMIT=""
KEY_FILE="${RELEASE_SIGNING_KEY_FILE:-}"
CHECK=0
TMP=""

say() { printf '%s\n' "$*"; }
die() { printf 'x %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

cleanup() { if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/gen-sums.sh <artifacts-dir> --tag vX.Y.Z [options]
  --tag TAG        release tag, e.g. v0.1.0 (required)
  --commit SHA     40-hex source commit (default: git rev-parse HEAD)
  --key FILE       PKCS#8 Ed25519 private key (or RELEASE_SIGNING_KEY_FILE / RELEASE_SIGNING_KEY)
  --check          verify the existing SHA256SUMS + SHA256SUMS.sig against the directory
  --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) [ $# -ge 2 ] || die "--tag needs a value"; TAG=$2; shift 2 ;;
    --tag=*) TAG=${1#*=}; shift ;;
    --commit) [ $# -ge 2 ] || die "--commit needs a value"; COMMIT=$2; shift 2 ;;
    --commit=*) COMMIT=${1#*=}; shift ;;
    --key) [ $# -ge 2 ] || die "--key needs a value"; KEY_FILE=$2; shift 2 ;;
    --key=*) KEY_FILE=${1#*=}; shift ;;
    --check) CHECK=1; shift ;;
    --help|-h) usage; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$DIR" ] || die "unexpected argument: $1"; DIR=$1; shift ;;
  esac
done

[ -n "$DIR" ] || { usage >&2; die "missing <artifacts-dir>"; }
[ -d "$DIR" ] || die "not a directory: $DIR"
[ -n "$TAG" ] || die "--tag is required (e.g. --tag v0.1.0)"
case "$TAG" in
  v[0-9]*) : ;;
  *) die "tag must look like vX.Y.Z: $TAG" ;;
esac

for tool in openssl; do have "$tool" || die "missing dependency: $tool"; done
if ! have sha256sum && ! have shasum; then die "missing dependency: sha256sum or shasum"; fi

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/qz-gen-sums.XXXXXX") || die "could not create a temp dir"

# 私钥：文件优先；否则把 RELEASE_SIGNING_KEY 的 PEM 文本写进 0600 临时文件。
if [ -z "$KEY_FILE" ] && [ -n "${RELEASE_SIGNING_KEY:-}" ]; then
  KEY_FILE="$TMP/release.pem"
  ( umask 077; printf '%s\n' "$RELEASE_SIGNING_KEY" >"$KEY_FILE" )
fi
[ -n "$KEY_FILE" ] || die "no private key: pass --key, RELEASE_SIGNING_KEY_FILE or RELEASE_SIGNING_KEY"
[ -f "$KEY_FILE" ] || die "private key file not found: $KEY_FILE"

# 公钥指纹（原始 32 字节的 sha256，十六进制）只用于审计输出，不是秘密。
openssl pkey -in "$KEY_FILE" -pubout -outform DER -out "$TMP/pub.der" 2>/dev/null \
  || die "cannot read an Ed25519 private key from the given path"
PUB_HEX=$(tail -c 32 "$TMP/pub.der" | od -An -tx1 -v | tr -d ' \n')
[ ${#PUB_HEX} -eq 64 ] || die "unexpected public key encoding"
FINGERPRINT=$(printf '%s' "$PUB_HEX" | openssl dgst -sha256 -r 2>/dev/null | cut -d' ' -f1)
[ -n "$FINGERPRINT" ] || FINGERPRINT=$(sha256_of "$TMP/pub.der")

collect_artifacts() {
  for f in "$DIR"/*; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
      SHA256SUMS|SHA256SUMS.sig) continue ;;
      quetzalcoatl-*) printf '%s\n' "$f" ;;
      *) die "unexpected file in the release directory: $(basename "$f") (only quetzalcoatl-* assets are signed)" ;;
    esac
  done
}

if [ "$CHECK" = 1 ]; then
  SUMS="$DIR/SHA256SUMS"
  SIG="$DIR/SHA256SUMS.sig"
  [ -f "$SUMS" ] || die "missing $SUMS"
  [ -f "$SIG" ] || die "missing $SIG"
  openssl base64 -d -A -in "$SIG" -out "$TMP/sig.bin" 2>/dev/null || die "SHA256SUMS.sig is not valid base64"
  # 从私钥导出公钥再验签：与安装器用内置公钥验证等价，但无需另存公钥。
  openssl pkeyutl -verify -pubin -inkey "$TMP/pub.der" -keyform DER -rawin -in "$SUMS" -sigfile "$TMP/sig.bin" >/dev/null 2>&1 \
    || die "SHA256SUMS.sig does not verify against this key"
  say "  signature ok (key sha256 $FINGERPRINT)"

  commit_line=$(grep '^commit ' "$SUMS" | head -n 1 || true)
  [ -n "$commit_line" ] || die "SHA256SUMS has no commit line"
  got_tag=$(printf '%s\n' "$commit_line" | awk '{print $3}')
  got_commit=$(printf '%s\n' "$commit_line" | awk '{print $2}')
  [ "$got_tag" = "$TAG" ] || die "commit line tag is $got_tag, expected $TAG"
  case "$got_commit" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) : ;;
    *) die "commit line is not a 40-hex commit: $got_commit" ;;
  esac
  if [ -n "$COMMIT" ] && [ "$COMMIT" != "$got_commit" ]; then
    die "commit line says $got_commit, expected $COMMIT"
  fi

  # 清点：目录里的每个资产都要有且仅有一条哈希，反之亦然。
  : >"$TMP/expected"
  for f in "$DIR"/*; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    case "$base" in SHA256SUMS|SHA256SUMS.sig) continue ;; esac
    printf '%s  %s\n' "$(sha256_of "$f")" "$base" >>"$TMP/expected"
  done
  : >"$TMP/listed"
  while IFS= read -r line; do
    case "$line" in
      commit*) continue ;;
      '') continue ;;
    esac
    printf '%s\n' "$line" | awk '{print $2}' >>"$TMP/listed"
  done <"$SUMS"
  while IFS= read -r line; do
    case "$line" in
      commit*) continue ;;
      '') continue ;;
    esac
    [ -n "$line" ] || continue
    [ "$(printf '%s\n' "$line" | awk 'NF>=2 && length($1)==64 {print "ok"}')" = "ok" ] \
      || die "malformed SHA256SUMS line: $line"
    hash=$(printf '%s\n' "$line" | awk '{print $1}')
    name=$(printf '%s\n' "$line" | awk '{print $2}')
    [ -f "$DIR/$name" ] || die "SHA256SUMS lists a missing file: $name"
    [ "$(sha256_of "$DIR/$name")" = "$hash" ] || die "hash mismatch for $name"
  done <"$SUMS"
  while IFS= read -r name; do
    grep -q "  $name\$" "$SUMS" || die "artifact not listed in SHA256SUMS: $name"
  done <<EOF
$(collect_artifacts | while IFS= read -r p; do basename "$p"; done)
EOF
  say "  ${TAG}: every artifact matches SHA256SUMS"
  exit 0
fi

[ -n "$COMMIT" ] || COMMIT=$(git rev-parse HEAD 2>/dev/null || true)
[ -n "$COMMIT" ] || die "--commit is required outside a git checkout"
case "$COMMIT" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) : ;;
  *) die "commit must be 40 hex characters: $COMMIT" ;;
esac

: >"$TMP/SHA256SUMS"
collect_artifacts >"$TMP/files"
[ -s "$TMP/files" ] || die "no quetzalcoatl-* artifacts in $DIR"
while IFS= read -r f; do
  printf '%s  %s\n' "$(sha256_of "$f")" "$(basename "$f")" >>"$TMP/SHA256SUMS"
done <"$TMP/files"
printf 'commit %s %s\n' "$COMMIT" "$TAG" >>"$TMP/SHA256SUMS"

mv "$TMP/SHA256SUMS" "$DIR/SHA256SUMS"
openssl pkeyutl -sign -inkey "$KEY_FILE" -rawin -in "$DIR/SHA256SUMS" -out "$TMP/SHA256SUMS.sig.bin" 2>/dev/null \
  || die "signing failed"
openssl base64 -A -in "$TMP/SHA256SUMS.sig.bin" >"$DIR/SHA256SUMS.sig"

say "signed $TAG"
say "  key sha256   $FINGERPRINT"
say "  artifacts    $(wc -l <"$TMP/files" | tr -d ' ')"
say "  commit       $COMMIT"
say "  wrote        $DIR/SHA256SUMS"
say "  wrote        $DIR/SHA256SUMS.sig"
