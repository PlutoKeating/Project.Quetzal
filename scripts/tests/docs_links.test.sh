#!/usr/bin/env bash
# 文档一致性门禁：确保 README / docs 中引用的仓库路径、crate 包名、脚本与 qz 子命令真实存在。
#
# 为什么需要它：文档漂移比编译错误更难发现——一个已删除的 crate、一个改名的脚本，读者照着做
# 就会失败。本脚本只依赖 bash + coreutils/grep/sed，不联网、不写仓库。
#
# 检查项：
#   1. 行内代码里以仓库根为基准的路径（crates/ docs/ scripts/ packages/ surfaces/ hub/ spec/
#      website/ .opencode/）必须存在；
#   2. Markdown 相对链接目标必须存在；
#   3. `cargo ... -p <name>` / `--package <name>` 必须是 workspace 内真实包名；
#   4. 文档里出现的 `qz <subcommand>` 必须是 `qz` USAGE 中登记的子命令；
#   5. `docs/*.md` 必须能从 README 索引到。
#
# 约定：路径引用请写在行内代码中（反引号），不要写进围栏代码块；围栏块里的命令参数不做路径校验。
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT" || exit 1

N=0
FAILED=0
WORK=$(mktemp -d "${TMPDIR:-/tmp}/qz-docs-links.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT

ok() { N=$((N + 1)); printf 'ok %d - %s\n' "$N" "$1"; }
fail() { N=$((N + 1)); FAILED=$((FAILED + 1)); printf 'not ok %d - %s\n' "$N" "$1"; sed 's/^/    /' "$WORK/why" 2>/dev/null; }

DOCS="README.md"
for f in docs/*.md; do
  [ -f "$f" ] && DOCS="$DOCS $f"
done
[ -f README.md ] || { printf 'FAIL: 缺少根级 README.md\n'; exit 1; }

# ---- 1. 行内代码中的仓库路径 ----------------------------------------------
: >"$WORK/tokens"
for doc in $DOCS; do
  awk -v doc="$doc" '
    BEGIN { fence = 0 }
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[ \t]*```/) { fence = 1 - fence; next }
      if (fence) next
      n = split(line, parts, "`")
      for (i = 2; i <= n; i += 2) {
        if (parts[i] != "") print doc "\t" parts[i]
      }
    }
  ' "$doc" >>"$WORK/tokens"
done

: >"$WORK/missing"
: >"$WORK/checked_paths"
while IFS=$'\t' read -r doc raw; do
  tok=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/[.,;:)]*$//')
  [ -n "$tok" ] || continue
  # 跳过命令、URL、占位符、变量、通配、行号等非纯路径 token
  case "$tok" in
    *" "*|*"<"*|*">"*|*"*"*|*"?"*|*"\$"*|*"{"*|*"}"*|*"|"*|*":"*|*"'"*|*'"'*|*"="*|*"("*) continue ;;
  esac
  case "$tok" in
    http://*|https://*|mailto:*) continue ;;
  esac
  case "$tok" in
    "/*"|"~"*|"@"*|"#"*) continue ;;
  esac
  case "$tok" in
    crates/*|docs/*|scripts/*|packages/*|surfaces/*|hub/*|spec/*|website/*|.opencode/*) : ;;
    *) continue ;;
  esac
  printf '%s\n' "$tok" >>"$WORK/checked_paths"
  if [ ! -e "$tok" ]; then
    printf '%s: `%s` 引用了不存在的路径\n' "$doc" "$tok" >>"$WORK/missing"
  fi
done <"$WORK/tokens"

if [ -s "$WORK/missing" ]; then
  cp "$WORK/missing" "$WORK/why"
  fail "行内代码引用的仓库路径全部存在（$(wc -l <"$WORK/checked_paths" | tr -d ' ') 条）"
else
  ok "行内代码引用的仓库路径全部存在（$(wc -l <"$WORK/checked_paths" | tr -d ' ') 条）"
fi

# ---- 2. 脊柱 JSONL 字段名与 ledger.rs 一致 --------------------------------
# 说明：`docs/PROTOCOL.md` §2 的 ```json 块描述脊柱事件线格式。这里抽取其中的键名，
# 逐一要求它们在 `crates/quetzalcoatl-spine/src/ledger.rs` 中以带引号字面量出现；
# `kind` 是 payload 内容示例（不是信封字段），显式跳过。
: >"$WORK/proto_keys"
awk '
  /^```json$/ { f = 1; buf = ""; next }
  f && /^```$/ {
    if (buf ~ /event_blake3/) { printf "%s", buf; exit }
    f = 0
    next
  }
  f { buf = buf $0 "\n" }
' docs/PROTOCOL.md |
  grep -oE '"[a-z0-9_]+"[[:space:]]*:' |
  sed -E 's/^"//; s/".*$//' | sort -u >"$WORK/proto_keys"

: >"$WORK/badproto"
proto_checked=0
if [ -s "$WORK/proto_keys" ]; then
  while IFS= read -r key; do
    [ "$key" = "kind" ] && continue
    proto_checked=$((proto_checked + 1))
    if ! grep -qF "\\\"$key\\\"" crates/quetzalcoatl-spine/src/ledger.rs; then
      printf 'docs/PROTOCOL.md: 脊柱 JSONL 字段 `%s` 未在 ledger.rs 中出现\n' "$key" >>"$WORK/badproto"
    fi
  done <"$WORK/proto_keys"
fi
if [ "$proto_checked" -eq 0 ]; then
  printf 'docs/PROTOCOL.md: 未能抽取脊椎 JSONL 字段（检查 §2 的 json 代码块）\n' >"$WORK/badproto"
fi
if [ -s "$WORK/badproto" ]; then
  cp "$WORK/badproto" "$WORK/why"
  fail "PROTOCOL 脊柱 JSONL 字段与 ledger.rs 一致（$proto_checked 个键）"
else
  ok "PROTOCOL 脊柱 JSONL 字段与 ledger.rs 一致（$proto_checked 个键）"
fi

# ---- 3. Markdown 相对链接 ---------------------------------------------------
: >"$WORK/badlinks"
: >"$WORK/linkcount"
for doc in $DOCS; do
  base=$(dirname "$doc")
  grep -oE '\]\([^)]+\)' "$doc" | sed -e 's/^](//' -e 's/)$//' | while IFS= read -r link; do
    target=${link%%#*}
    [ -n "$target" ] || continue
    case "$target" in
      http://*|https://*|mailto:*|tel:*|/*) continue ;;
    esac
    printf '%s\n' "$target" >>"$WORK/linkcount"
    if [ ! -e "$base/$target" ]; then
      printf '%s: 链接 `%s` 指向不存在的 %s\n' "$doc" "$link" "$base/$target" >>"$WORK/badlinks"
    fi
  done
done
link_total=$(wc -l <"$WORK/linkcount" | tr -d ' ')
if [ -s "$WORK/badlinks" ]; then
  cp "$WORK/badlinks" "$WORK/why"
  fail "Markdown 相对链接全部可达（$link_total 条）"
else
  ok "Markdown 相对链接全部可达（$link_total 条）"
fi

# ---- 4. cargo -p / --package 包名 -----------------------------------------
: >"$WORK/packages"
for manifest in crates/*/Cargo.toml crates/bindings/*/Cargo.toml surfaces/linux/Cargo.toml; do
  [ -f "$manifest" ] || continue
  name=$(sed -n 's/^name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)
  [ -n "$name" ] && printf '%s\n' "$name" >>"$WORK/packages"
done

: >"$WORK/badpkgs"
for doc in $DOCS; do
  grep -oE -- '(-p|--package)[[:space:]]+[A-Za-z0-9_.-]+' "$doc" 2>/dev/null |
    awk '{print $2}' | while IFS= read -r pkg; do
      [ -n "$pkg" ] || continue
      case "$pkg" in
        -*|"") continue ;;
      esac
      if ! grep -qxF "$pkg" "$WORK/packages"; then
        printf '%s: 引用了不存在的 workspace 包 `%s`\n' "$doc" "$pkg" >>"$WORK/badpkgs"
      fi
    done
done
if [ -s "$WORK/badpkgs" ]; then
  cp "$WORK/badpkgs" "$WORK/why"
  fail "cargo 包名全部存在于 workspace"
else
  ok "cargo 包名全部存在于 workspace（$(wc -l <"$WORK/packages" | tr -d ' ') 个包）"
fi

# ---- 5. qz 子命令 ----------------------------------------------------------
: >"$WORK/qzcmds"
awk '
  /^Commands:/ { inblock = 1; next }
  inblock && /^"/ { inblock = 0 }
  inblock && /^  [a-z][a-z0-9-]*[ \t]+/ { print $1 }
' crates/quetzalcoatl-daemon/src/bin/qz.rs >"$WORK/qzcmds"
[ -s "$WORK/qzcmds" ] || { printf 'FAIL: 无法解析 qz USAGE 子命令表\n'; exit 1; }

: >"$WORK/badqz"
for doc in $DOCS; do
  grep -oE '(^|[^A-Za-z0-9_-])qz[[:space:]]+[a-z][a-z0-9-]*' "$doc" 2>/dev/null |
    while IFS= read -r match; do
      sub=$(printf '%s' "$match" | sed -E 's/.*qz[[:space:]]+//')
      [ -n "$sub" ] || continue
      if ! grep -qxF "$sub" "$WORK/qzcmds"; then
        printf '%s: 引用了未登记的 qz 子命令 `%s`\n' "$doc" "$sub" >>"$WORK/badqz"
      fi
    done
done
if [ -s "$WORK/badqz" ]; then
  cp "$WORK/badqz" "$WORK/why"
  fail "qz 子命令全部已在 USAGE 登记"
else
  ok "qz 子命令全部已在 USAGE 登记（$(wc -l <"$WORK/qzcmds" | tr -d ' ') 个）"
fi

# ---- 6. docs 索引完整性 -----------------------------------------------------
: >"$WORK/unindexed"
for f in docs/*.md; do
  [ -f "$f" ] || continue
  if ! grep -qF "($f)" README.md; then
    printf 'README.md 未索引 %s\n' "$f" >>"$WORK/unindexed"
  fi
done
if [ -s "$WORK/unindexed" ]; then
  cp "$WORK/unindexed" "$WORK/why"
  fail "docs/*.md 全部被 README 索引"
else
  ok "docs/*.md 全部被 README 索引"
fi

printf '\n# %d checks, %d failed\n' "$N" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
