#!/usr/bin/env bash
# Quetzalcoatl V2 — UniFFI 三语言绑定生成与编译冒烟。
#
#   scripts/uniffi-bindings.sh build-lib                    构建 cdylib（cargo build -p quetzalcoatl-uniffi）
#   scripts/uniffi-bindings.sh generate <kotlin|swift|csharp> [out_dir]
#   scripts/uniffi-bindings.sh smoke-csharp                 生成 + dotnet 真实编译 + 运行极小消费方
#   scripts/uniffi-bindings.sh smoke-swift                  生成 + swiftc 类型检查（工具链缺失则 SKIP）
#   scripts/uniffi-bindings.sh smoke-kotlin                 生成 + kotlinc 编译（工具链缺失则 SKIP）
#   scripts/uniffi-bindings.sh all                          全部生成 + 全部冒烟，并聚合真实结果与 SKIP
#
# 退出码约定：0 成功；77 工具链缺失则跳过（绝不伪装通过）；其他为真实失败。
# `all` 模式：每一步的 0/77 都记录进汇总，只有真实失败（非 0/77）才以 1 退出。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$REPO_ROOT/crates/bindings/quetzalcoatl-uniffi"
CONFIG="$CRATE_DIR/uniffi.toml"
CARGO_BIN="${QZ_CARGO:-cargo}"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
PROFILE="${QZ_PROFILE:-debug}"
OUT_ROOT="${QZ_BINDINGS_OUT:-$TARGET_DIR/uniffi-bindings}"

case "$(uname -s)" in
    Darwin) LIB="$TARGET_DIR/$PROFILE/libquetzalcoatl_uniffi.dylib" ;;
    MINGW*|MSYS*|CYGWIN*) LIB="$TARGET_DIR/$PROFILE/quetzalcoatl_uniffi.dll" ;;
    *) LIB="$TARGET_DIR/$PROFILE/libquetzalcoatl_uniffi.so" ;;
esac

# 临时目录统一登记，单一 EXIT trap 清理（`all` 模式会连续创建多个）。
SMOKE_TMP_DIRS=()
cleanup() {
    local dir
    for dir in "${SMOKE_TMP_DIRS[@]:-}"; do
        if [[ -n "$dir" ]]; then
            rm -rf "$dir"
        fi
    done
    return 0
}
trap cleanup EXIT

# 打印 SKIP 理由；由调用方 `return 77` 传播，便于 `all` 聚合而不是整体中止。
skip() { echo "SKIP: $*"; }

build_lib() {
    echo "==> cargo build -p quetzalcoatl-uniffi (cdylib)"
    ( cd "$REPO_ROOT" && "$CARGO_BIN" build -p quetzalcoatl-uniffi ) || return 1
    [[ -f "$LIB" ]] || { echo "error: cdylib 未生成: $LIB" >&2; return 1; }
    echo "    cdylib: $LIB"
}

find_dotnet() {
    local candidate
    for candidate in "${QZ_DOTNET:-}" "$HOME/.dotnet/dotnet" "$(command -v dotnet || true)"; do
        if [[ -n "$candidate" && -x "$candidate" ]]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

find_bindgen_cs() {
    local candidate
    for candidate in "${QZ_BINDGEN_CS:-}" "$HOME/.cargo/bin/uniffi-bindgen-cs" "$(command -v uniffi-bindgen-cs || true)"; do
        if [[ -n "$candidate" && -x "$candidate" ]]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

find_bindgen() {
    if [[ -x "$TARGET_DIR/$PROFILE/uniffi-bindgen" ]]; then
        echo "$TARGET_DIR/$PROFILE/uniffi-bindgen"
        return 0
    fi
    ( cd "$REPO_ROOT" && "$CARGO_BIN" build -p quetzalcoatl-uniffi --features cli --bins ) >&2 || return 1
    echo "$TARGET_DIR/$PROFILE/uniffi-bindgen"
}

cmd_generate() {
    local language="${1:?用法: generate <kotlin|swift|csharp> [out_dir]}"
    local out_dir="${2:-$OUT_ROOT/$language}"
    mkdir -p "$out_dir" || return 1
    build_lib || return 1
    case "$language" in
        kotlin|swift)
            local bindgen
            bindgen="$(find_bindgen)" || return 1
            "$bindgen" generate "$LIB" -l "$language" -n -o "$out_dir" || return 1
            ;;
        csharp)
            local bindgen_cs
            bindgen_cs="$(find_bindgen_cs)" || {
                skip "未安装 uniffi-bindgen-cs（crates.io 未发布，按 bindgen-cs-pin.json 的 install_command 安装）"
                return 77
            }
            "$bindgen_cs" --library "$LIB" --config "$CONFIG" --out-dir "$out_dir" --no-format || return 1
            ;;
        *)
            echo "error: 未知语言 $language" >&2
            return 2
            ;;
    esac
    echo "    bindings: $out_dir"
}

cmd_smoke_csharp() {
    local dotnet bindgen_cs tmp gen output
    dotnet="$(find_dotnet)" || {
        skip "本机未安装 dotnet SDK，跳过 C# 编译冒烟"
        return 77
    }
    bindgen_cs="$(find_bindgen_cs)" || {
        skip "本机未安装 uniffi-bindgen-cs，跳过 C# 编译冒烟"
        return 77
    }
    echo "==> C# 冒烟: $(basename "$dotnet") $("$dotnet" --version 2>/dev/null || echo unknown)"
    build_lib || return 1

    tmp="$(mktemp -d "${TMPDIR:-/tmp}/qz_csharp_smoke.XXXXXX")" || return 1
    SMOKE_TMP_DIRS+=("$tmp")
    gen="$tmp/generated"
    mkdir -p "$gen" || return 1
    "$bindgen_cs" --library "$LIB" --config "$CONFIG" --out-dir "$gen" --no-format >/dev/null || return 1
    echo "    generated: $(ls "$gen" | tr '\n' ' ')"

    output="$(
        DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
        DOTNET_CLI_HOME="$tmp/dotnet-home" \
        LD_LIBRARY_PATH="$(dirname "$LIB")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
        "$dotnet" run --project "$CRATE_DIR/tests/csharp_smoke/Consumer.csproj" \
            -c Release --nologo \
            -p:QzGeneratedDir="$gen" \
            -p:BaseIntermediateOutputPath="$tmp/obj/" \
            -p:BaseOutputPath="$tmp/bin/" 2>&1
    )" || { echo "$output" >&2; echo "error: C# 冒烟编译/运行失败" >&2; return 1; }
    echo "$output" | sed 's/^/    /'
    echo "$output" | grep -q "CSHARP_SMOKE_OK" || {
        echo "error: C# 消费方未输出成功标记" >&2
        return 1
    }
}

cmd_smoke_swift() {
    local out_dir="$OUT_ROOT/swift"
    local swiftc_bin="${QZ_SWIFTC:-$(command -v swiftc || true)}"
    cmd_generate swift "$out_dir" || return $?
    if [[ -z "$swiftc_bin" || ! -x "$swiftc_bin" ]]; then
        skip "本机未安装 swiftc（Swift 6.2+ 工具链），已生成绑定源码但跳过编译冒烟: $out_dir"
        return 77
    fi
    echo "==> Swift 类型检查"
    "$swiftc_bin" -typecheck -module-name QuetzalcoatlBindings \
        -emit-module-path "$out_dir/QuetzalcoatlBindings.swiftmodule" \
        "$out_dir/QuetzalcoatlBindings.swift" || return 1
    echo "SWIFT_SMOKE_OK $out_dir"
}

cmd_smoke_kotlin() {
    local out_dir="$OUT_ROOT/kotlin"
    local kotlinc_bin="${QZ_KOTLINC:-$(command -v kotlinc || true)}"
    cmd_generate kotlin "$out_dir" || return $?
    if [[ -z "$kotlinc_bin" || ! -x "$kotlinc_bin" ]]; then
        skip "本机未安装 kotlinc（Kotlin 2.2+ 工具链），已生成绑定源码但跳过编译冒烟: $out_dir"
        return 77
    fi
    local jna="${QZ_JNA_JAR:-}"
    if [[ -z "$jna" || ! -f "$jna" ]]; then
        skip "已安装 kotlinc，但未提供 QZ_JNA_JAR（UniFFI Kotlin 绑定依赖 JNA），已生成绑定源码但跳过编译冒烟: $out_dir"
        return 77
    fi
    echo "==> Kotlin 编译（JNA: $jna）"
    local classpath="$jna"
    if [[ -n "${QZ_KOTLIN_EXTRA_CLASSPATH:-}" ]]; then
        classpath="$classpath:$QZ_KOTLIN_EXTRA_CLASSPATH"
    fi
    "$kotlinc_bin" -cp "$classpath" \
        "$out_dir/org/quetzalcoatl/bindings/quetzalcoatl_uniffi.kt" \
        -d "$out_dir/quetzalcoatl_uniffi.jar" || return 1
    echo "KOTLIN_SMOKE_OK $out_dir"
}

run_all() {
    local gk=0 gs=0 gc=0 cs=0 sw=0 kt=0 code failure=0
    build_lib || return 1
    cmd_generate kotlin || gk=$?
    cmd_generate swift || gs=$?
    cmd_generate csharp || gc=$?
    cmd_smoke_csharp || cs=$?
    cmd_smoke_swift || sw=$?
    cmd_smoke_kotlin || kt=$?
    echo "==> 汇总: generate[kotlin=$gk swift=$gs csharp=$gc] smoke[csharp=$cs swift=$sw kotlin=$kt] (0=通过 77=工具链缺失跳过)"
    for code in "$gk" "$gs" "$gc" "$cs" "$sw" "$kt"; do
        if [[ $code -ne 0 && $code -ne 77 ]]; then
            failure=1
        fi
    done
    [[ $failure -eq 0 ]] || return 1
}

case "${1:-}" in
    build-lib) build_lib ;;
    generate) shift; cmd_generate "$@" ;;
    smoke-csharp) cmd_smoke_csharp ;;
    smoke-swift) cmd_smoke_swift ;;
    smoke-kotlin) cmd_smoke_kotlin ;;
    all) run_all ;;
    *)
        sed -n '2,15p' "${BASH_SOURCE[0]}"
        exit 2
        ;;
esac
