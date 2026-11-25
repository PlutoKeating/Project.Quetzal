#!/usr/bin/env bash
# Quetzalcoatl V2 — UniFFI 三语言绑定生成与编译冒烟。
#
#   scripts/uniffi-bindings.sh build-lib                    构建 cdylib（cargo build -p quetzalcoatl-uniffi）
#   scripts/uniffi-bindings.sh generate <kotlin|swift|csharp> [out_dir]
#   scripts/uniffi-bindings.sh smoke-csharp                 生成 + dotnet 真实编译 + 运行极小消费方
#   scripts/uniffi-bindings.sh smoke-swift                  生成 + swiftc 类型检查（工具链缺失则 SKIP）
#   scripts/uniffi-bindings.sh smoke-kotlin                 生成 + kotlinc 编译（工具链缺失则 SKIP）
#   scripts/uniffi-bindings.sh all                          生成三语言绑定 + 全部可用的冒烟
#
# 退出码约定：0 成功；77 工具链缺失则跳过（绝不伪装通过）；其他为真实失败。
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

skip() { echo "SKIP: $*"; exit 77; }

build_lib() {
    echo "==> cargo build -p quetzalcoatl-uniffi (cdylib)"
    ( cd "$REPO_ROOT" && "$CARGO_BIN" build -p quetzalcoatl-uniffi )
    [[ -f "$LIB" ]] || { echo "error: cdylib 未生成: $LIB" >&2; exit 1; }
    echo "    cdylib: $LIB"
}

find_dotnet() {
    for candidate in "${QZ_DOTNET:-}" "$HOME/.dotnet/dotnet" "$(command -v dotnet || true)"; do
        if [[ -n "$candidate" && -x "$candidate" ]]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

find_bindgen_cs() {
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
    else
        ( cd "$REPO_ROOT" && "$CARGO_BIN" build -p quetzalcoatl-uniffi --features cli --bins ) >&2
        echo "$TARGET_DIR/$PROFILE/uniffi-bindgen"
    fi
}

cmd_generate() {
    local language="${1:?用法: generate <kotlin|swift|csharp> [out_dir]}"
    local out_dir="${2:-$OUT_ROOT/$language}"
    mkdir -p "$out_dir"
    build_lib
    case "$language" in
        kotlin|swift)
            local bindgen
            bindgen="$(find_bindgen)"
            "$bindgen" generate "$LIB" -l "$language" -n -o "$out_dir"
            ;;
        csharp)
            local bindgen_cs
            bindgen_cs="$(find_bindgen_cs)" || skip "未安装 uniffi-bindgen-cs（crates.io 未发布，按 bindgen-cs-pin.json 的 install_command 安装）"
            "$bindgen_cs" --library "$LIB" --config "$CONFIG" --out-dir "$out_dir" --no-format
            ;;
        *)
            echo "error: 未知语言 $language" >&2
            exit 2
            ;;
    esac
    echo "    bindings: $out_dir"
}

cmd_smoke_csharp() {
    local dotnet bindgen_cs tmp gen
    dotnet="$(find_dotnet)" || skip "本机未安装 dotnet SDK，跳过 C# 编译冒烟"
    bindgen_cs="$(find_bindgen_cs)" || skip "本机未安装 uniffi-bindgen-cs，跳过 C# 编译冒烟"
    echo "==> C# 冒烟: $(basename "$dotnet") $("$dotnet" --version 2>/dev/null || echo unknown)"
    build_lib

    tmp="$(mktemp -d "${TMPDIR:-/tmp}/qz_csharp_smoke.XXXXXX")"
    SMOKE_TMP="$tmp"
    trap 'rm -rf "${SMOKE_TMP:-}"' EXIT
    gen="$tmp/generated"
    mkdir -p "$gen"
    "$bindgen_cs" --library "$LIB" --config "$CONFIG" --out-dir "$gen" --no-format >/dev/null
    echo "    generated: $(ls "$gen" | tr '\n' ' ')"

    local output
    output="$(
        DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
        DOTNET_CLI_HOME="$tmp/dotnet-home" \
        LD_LIBRARY_PATH="$(dirname "$LIB")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
        "$dotnet" run --project "$CRATE_DIR/tests/csharp_smoke/Consumer.csproj" \
            -c Release --nologo \
            -p:QzGeneratedDir="$gen" \
            -p:BaseIntermediateOutputPath="$tmp/obj/" \
            -p:BaseOutputPath="$tmp/bin/" 2>&1
    )" || { echo "$output" >&2; echo "error: C# 冒烟编译/运行失败" >&2; exit 1; }
    echo "$output" | sed 's/^/    /'
    echo "$output" | grep -q "CSHARP_SMOKE_OK" || { echo "error: C# 消费方未输出成功标记" >&2; exit 1; }
}

cmd_smoke_swift() {
    local out_dir="$OUT_ROOT/swift"
    local swiftc_bin="${QZ_SWIFTC:-$(command -v swiftc || true)}"
    cmd_generate swift "$out_dir"
    if [[ -z "$swiftc_bin" || ! -x "$swiftc_bin" ]]; then
        skip "本机未安装 swiftc（Swift 6.2+ 工具链），已生成绑定源码但跳过编译冒烟: $out_dir"
    fi
    echo "==> Swift 类型检查"
    "$swiftc_bin" -typecheck -module-name QuetzalcoatlBindings \
        -emit-module-path "$out_dir/QuetzalcoatlBindings.swiftmodule" \
        "$out_dir/QuetzalcoatlBindings.swift"
    echo "SWIFT_SMOKE_OK $out_dir"
}

cmd_smoke_kotlin() {
    local out_dir="$OUT_ROOT/kotlin"
    local kotlinc_bin="${QZ_KOTLINC:-$(command -v kotlinc || true)}"
    cmd_generate kotlin "$out_dir"
    if [[ -z "$kotlinc_bin" || ! -x "$kotlinc_bin" ]]; then
        skip "本机未安装 kotlinc（Kotlin 2.2+ 工具链），已生成绑定源码但跳过编译冒烟: $out_dir"
    fi
    local jna="${QZ_JNA_JAR:-}"
    if [[ -z "$jna" || ! -f "$jna" ]]; then
        skip "已安装 kotlinc，但未提供 QZ_JNA_JAR（UniFFI Kotlin 绑定依赖 JNA），已生成绑定源码但跳过编译冒烟: $out_dir"
    fi
    echo "==> Kotlin 编译（JNA: $jna）"
    local classpath="$jna"
    if [[ -n "${QZ_KOTLIN_EXTRA_CLASSPATH:-}" ]]; then
        classpath="$classpath:$QZ_KOTLIN_EXTRA_CLASSPATH"
    fi
    "$kotlinc_bin" -cp "$classpath" \
        "$out_dir/org/quetzalcoatl/bindings/quetzalcoatl_uniffi.kt" \
        -d "$out_dir/quetzalcoatl_uniffi.jar"
    echo "KOTLIN_SMOKE_OK $out_dir"
}

case "${1:-}" in
    build-lib) build_lib ;;
    generate) shift; cmd_generate "$@" ;;
    smoke-csharp) cmd_smoke_csharp ;;
    smoke-swift) cmd_smoke_swift ;;
    smoke-kotlin) cmd_smoke_kotlin ;;
    all)
        build_lib
        cmd_generate kotlin
        cmd_generate swift
        cmd_generate csharp
        set +e
        cmd_smoke_csharp; cs=$?
        cmd_smoke_swift; sw=$?
        cmd_smoke_kotlin; kt=$?
        set -e
        echo "==> 冒烟结果: csharp=$cs swift=$sw kotlin=$kt (77 = 工具链缺失跳过)"
        [[ $cs -eq 0 ]] || [[ $cs -eq 77 ]] || exit 1
        [[ $sw -eq 0 ]] || [[ $sw -eq 77 ]] || exit 1
        [[ $kt -eq 0 ]] || [[ $kt -eq 77 ]] || exit 1
        ;;
    *)
        sed -n '2,14p' "${BASH_SOURCE[0]}"
        exit 2
        ;;
esac
