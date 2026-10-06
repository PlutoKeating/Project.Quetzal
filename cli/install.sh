#!/usr/bin/env bash
# Quetzal 一键安装（Linux）：curl -fsSL https://quetzal.plutokeating.beer/install | bash
#
# 做什么（幂等，再跑一次就是升级）：
#   1. 看清这台机器：发行版、架构、包管理器、有没有 systemd 用户实例、有没有桌面
#   2. 补齐依赖：git、curl、tar、ca-certificates（缺什么装什么，用这台机器自己的包管理器）；命令沙箱 bubblewrap（可选，装不上不影响）；
#      Node.js 22.13+：没有就经 nvm 装（nvm 装进 ~/.nvm，不碰系统的 node）；musl（Alpine）与 NixOS 用发行版自己的包；
#      龙芯（loongarch64）、RISC-V、armv6l 这些官方不出二进制的架构，从 Node.js 的 unofficial-builds 直接下载到 ~/quetzal/node/
#   3. 把 npm 包 @plutokeating/quetzal 装进 ~/.quetzal/npm（独立前缀，不污染全局），由它放好运行基座与网页控制台
#   4. 守护：systemd 用户服务（开机自启、退出 3 秒后重启、未登录也运行）；没有 systemd 的机器退回到
#      自带的守护循环 + crontab @reboot + 桌面自启动项，不装任何额外的服务框架
#   5. 桌面：下载同版本的原生控制台（Flutter Linux 桌面版，不借浏览器）放到 ~/.quetzal/console/，
#      应用列表、任务栏、Alt-Tab 都是 Quetzal 自己的图标；没有原生包（旧版本、arm64、下载失败）时退回用浏览器打开
#   6. 打开网页控制台 http://127.0.0.1:7788/（同一台机器的浏览器打开即登录）
#
# 选项（curl … | bash -s -- <选项>）与等价的环境变量：
#   --lan            QUETZAL_LAN=1         网关对局域网开放（加密的 https，端口 7789；手机上的 App 填这台机器的地址、核对证书指纹后配对）
#   --no-open        QUETZAL_NO_OPEN=1     装完不打开浏览器
#   --no-desktop     QUETZAL_NO_DESKTOP=1  不写应用列表的快捷方式
#   --home DIR       QUETZAL_HOME=DIR      家目录（默认 ~/.quetzal；0.6.7 之前装在 ~/quetzal 的会自动整目录搬过来）
#   --version X.Y.Z  QUETZAL_VERSION=…     装指定版本的 npm 包（默认 latest）
#   --cn | --no-cn   QUETZAL_MIRROR=cn|off 强制使用 / 不使用中国大陆镜像（默认自动：直连 nodejs.org 不通才用）
#   --uninstall [--purge]                  卸载：服务、守护循环、快捷方式、npm 包；--purge 连家目录（配置、记忆、对话）一起删
#   --lang zh|en     QUETZAL_LANG=zh|en    界面语言（默认看 LANG）
#                    QUETZAL_NODE_ARCH=…   强制从 unofficial-builds 下载这个架构标签的 Node（如 loong64、riscv64、x64-musl），平时不用
#
# 这个文件是源码（cli/install.sh）；官网构建时原样复制为 https://quetzal.plutokeating.beer/install，
# 镜像地址 https://raw.githubusercontent.com/PlutoKeating/Project.Quetzal/main/cli/install.sh。
# 整段逻辑包在 main 里、最后一行才调用：bash 读完整个脚本才开始执行，下载中断只会报语法错误而不会跑半截。

set -u
set -o pipefail

NVM_VERSION="v0.40.3"
# nvm 安装脚本的 sha256（固定版本的 install.sh；GitHub 与 gitee 镜像内容相同，执行前必须核对，不一致就拒绝）。升级 NVM_VERSION 时一起更新：
#   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/<版本>/install.sh | sha256sum
NVM_INSTALL_SHA256="2d8359a64a3cb07c02389ad88ceecd43f2fa469c06104f92f98df5b6f315275f"
# 发版签名公钥（Ed25519，原始 32 字节的 base64url）：Release 里的 SHA256SUMS 由它的私钥签名（SHA256SUMS.sig），
# 原生控制台的压缩包先验签名、再核对清单里的哈希，任何一步不过都不装。轮换密钥时同步更新 App、soul-bridge 与官网文档里的同一个值。
RELEASE_PUBKEY="QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8"
NODE_MAJOR=22
NODE_MIN_MINOR=13
PKG="@plutokeating/quetzal"
SITE="https://quetzal.plutokeating.beer"
DOCS="$SITE/zh/docs/advanced/other-machines"

# ---------------------------------------------------------------- 文案（中英）
ZH=0
pick_lang() {
  # 简体 / 繁体中文（zh_CN、zh_TW、zh_HK、zh_Hant…）显示中文，其余英文；优先级同 gettext：LANGUAGE > LC_ALL > LC_MESSAGES > LANG
  local l="${QUETZAL_LANG:-${LANGUAGE:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}}"
  case "$l" in zh*|ZH*) ZH=1;; *) ZH=0;; esac
}
t() { if (( ZH )); then printf '%s' "$1"; else printf '%s' "$2"; fi; }

# ---------------------------------------------------------------- 终端：颜色、字符集、宽度
COLOR=0; TRUECOLOR=0; UNICODE=0; TTY=0
setup_term() {
  [[ -t 1 ]] && TTY=1
  if (( TTY )) && [[ -z "${NO_COLOR:-}" && "${TERM:-dumb}" != dumb ]]; then COLOR=1; fi
  case "${COLORTERM:-}" in truecolor|24bit) TRUECOLOR=1;; esac
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) UNICODE=1;; esac
  if (( COLOR )); then
    R=$'\e[0m'; B=$'\e[1m'
    if (( TRUECOLOR )); then
      AMBER=$'\e[38;2;255;178;110m'; OK=$'\e[38;2;132;196;138m'; BAD=$'\e[38;2;236;108;96m'; MUTE=$'\e[38;2;140;140;140m'; WARN=$'\e[38;2;240;190;90m'
    else
      AMBER=$'\e[38;5;215m'; OK=$'\e[38;5;114m'; BAD=$'\e[38;5;167m'; MUTE=$'\e[38;5;245m'; WARN=$'\e[38;5;221m'
    fi
  else
    R=; B=; AMBER=; OK=; BAD=; MUTE=; WARN=
  fi
  if (( UNICODE )); then I_OK='✓'; I_BAD='✗'; I_RUN='▸'; I_DOT='·'; I_WARN='!'; I_HDR='◆'; I_DONE='✦'
  else I_OK='+'; I_BAD='x'; I_RUN='>'; I_DOT='-'; I_WARN='!'; I_HDR='*'; I_DONE='*'; fi
}

say()  { printf '%s\n' "$*"; }
hdr()  { printf '\n%s%s%s %s%s%s\n' "$AMBER" "$I_HDR" "$R" "$B" "$*" "$R"; }
ok()   { printf '  %s%s%s %s\n' "$OK" "$I_OK" "$R" "$*"; }
note() { printf '  %s%s %s%s\n' "$MUTE" "$I_DOT" "$*" "$R"; }
warn() { printf '  %s%s%s %s\n' "$WARN" "$I_WARN" "$R" "$*"; }
bad()  { printf '  %s%s%s %s\n' "$BAD" "$I_BAD" "$R" "$*"; }

LOG=""
die() {
  bad "$*"
  if [[ -n "$LOG" && -s "$LOG" ]]; then
    printf '\n%s%s%s\n' "$MUTE" "$(t "最近的日志（完整日志：$LOG）：" "Recent log lines (full log: $LOG):")" "$R"
    tail -n 25 "$LOG" | sed 's/^/    /'
  fi
  printf '\n  %s%s%s\n\n' "$MUTE" "$(t "需要帮助：$DOCS" "Need help: $DOCS")" "$R"
  exit 1
}

# ---------------------------------------------------------------- 光团：半格字符渲染的小圆球（与 App 图标、官网标志同一颗）
lerp() { # a_r a_g a_b b_r b_g b_b p(0-100) -> CR CG CB
  CR=$(( $1 + ($4 - $1) * $7 / 100 )); CG=$(( $2 + ($5 - $2) * $7 / 100 )); CB=$(( $3 + ($6 - $3) * $7 / 100 ))
}
orb_px() { # x y -> PX：SGR 颜色参数（不含前景/背景前缀），圆外为空
  local dx=$(( 2*$1 - 13 )) dy=$(( 2*$2 - 13 )) d2 hx hy h2 tt
  d2=$(( dx*dx + dy*dy ))
  if (( d2 > 190 )); then PX=; return; fi
  hx=$(( 2*$1 - 8 )); hy=$(( 2*$2 - 8 )); h2=$(( hx*hx + hy*hy ))
  tt=$(( h2 * 100 / 361 )); (( tt > 100 )) && tt=100
  if (( TRUECOLOR )); then
    if   (( tt < 10 )); then lerp 255 254 252 255 211 171 $(( tt * 10 ))
    elif (( tt < 40 )); then lerp 255 211 171 255 178 110 $(( (tt - 10) * 100 / 30 ))
    else                     lerp 255 178 110 250 118 0   $(( (tt - 40) * 100 / 60 )); fi
    (( d2 > 150 )) && { CR=$(( CR * 92 / 100 )); CG=$(( CG * 92 / 100 )); CB=$(( CB * 92 / 100 )); }
    PX="2;$CR;$CG;$CB"
  else
    if (( tt < 10 )); then PX="5;231"; elif (( tt < 25 )); then PX="5;223"; elif (( tt < 45 )); then PX="5;215"; elif (( tt < 75 )); then PX="5;208"; else PX="5;202"; fi
  fi
}
banner() {
  local lines=("" "${B}${AMBER}Quetzal${R}" "${MUTE}$(t '不是运行着，是活着。' 'Not running, but living.')${R}" "" "${MUTE}$(t 'Linux 安装器' 'Linux installer')${R}" "${MUTE}${SITE#https://}${R}" "")
  say ""
  if (( COLOR && UNICODE )); then
    local row x top bot cell line
    for (( row = 0; row < 7; row++ )); do
      line="  "
      for (( x = 0; x < 14; x++ )); do
        orb_px "$x" $(( row * 2 )); top=$PX
        orb_px "$x" $(( row * 2 + 1 )); bot=$PX
        if [[ -n $top && -n $bot ]]; then cell=$'\e[38;'"$top"$'m\e[48;'"$bot"$'m▀'$R
        elif [[ -n $top ]]; then cell=$'\e[38;'"$top"$'m▀'$R
        elif [[ -n $bot ]]; then cell=$'\e[38;'"$bot"$'m▄'$R
        else cell=" "; fi
        line+=$cell
      done
      printf '%s   %s\n' "$line" "${lines[$row]}"
    done
  else
    for row in 1 2 4 5; do printf '  %s\n' "${lines[$row]}"; done
  fi
  say ""
}

# ---------------------------------------------------------------- 执行一步：转圈等待，输出进日志，失败给出日志尾巴
SPIN_PID=""
cleanup() { [[ -n "$SPIN_PID" ]] && kill "$SPIN_PID" 2>/dev/null; printf '\r\033[2K' 2>/dev/null; printf '\n  %s\n' "$(t '已中止。' 'Aborted.')"; exit 130; }
can_fractional_sleep() { sleep 0.1 2>/dev/null; }
run_step() { FATAL=1 run_try "$@" || die "$1 $(t '失败' 'failed')"; }
run_try() { # 文案 命令…：在后台跑命令，前台转圈；成功 ✓ 返回 0，失败 ! 返回 1（由调用方决定是否致命；致命的由 run_step 打 ✗）
  local label=$1; shift
  local rc=0
  if (( TTY && COLOR )); then
    "$@" </dev/null >>"$LOG" 2>&1 &
    SPIN_PID=$!
    local frames i=0 delay=0.08
    if (( UNICODE )); then frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'; else frames='|/-\'; fi
    can_fractional_sleep || delay=1
    while kill -0 "$SPIN_PID" 2>/dev/null; do
      printf '\r\033[2K  %s%s%s %s' "$AMBER" "${frames:$(( i % ${#frames} )):1}" "$R" "$label"
      i=$(( i + 1 )); sleep "$delay"
    done
    wait "$SPIN_PID" || rc=$?
    SPIN_PID=""
    printf '\r\033[2K'
  else
    printf '  %s %s\n' "$I_RUN" "$label"
    "$@" </dev/null >>"$LOG" 2>&1 || rc=$?
  fi
  if (( rc == 0 )); then ok "$label"; return 0; fi
  (( ${FATAL:-0} )) || warn "$label $(t '没有完成' 'did not complete')"; return 1
}
run_tty() { # 需要终端交互的命令（sudo 问密码）：不转圈，输出进日志，密码提示由 sudo 自己写到终端
  local label=$1; shift
  printf '  %s%s%s %s\n' "$AMBER" "$I_RUN" "$R" "$label"
  local rc=0
  if [[ -r /dev/tty ]]; then "$@" </dev/tty >>"$LOG" 2>&1 || rc=$?; else "$@" </dev/null >>"$LOG" 2>&1 || rc=$?; fi
  if (( rc == 0 )); then ok "$label"; else die "$label $(t '失败' 'failed')"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

# 取网页（curl 或 wget，哪个在用哪个）：fetch_ok URL（只看通不通）、fetch_text URL（内容到标准输出）
fetch_ok()   { if have curl; then curl -fsSL -m "${2:-6}" -o /dev/null "$1" 2>/dev/null; elif have wget; then wget -q -T "${2:-6}" -O /dev/null "$1" 2>/dev/null; else return 1; fi; }
fetch_file()   { if have curl; then curl -fsSL -m "${3:-300}" -o "$2" "$1" 2>>"${LOG:-/dev/null}"; elif have wget; then wget -q -T "${3:-300}" -O "$2" "$1" 2>>"${LOG:-/dev/null}"; else return 1; fi; }
fetch_text() { if have curl; then curl -fsSL -m "${2:-6}" "$1" 2>>"${LOG:-/dev/null}"; elif have wget; then wget -q -T "${2:-6}" -O - "$1" 2>>"${LOG:-/dev/null}"; else return 1; fi; }
# 文件的 sha256（小写十六进制）：coreutils / busybox 的 sha256sum、perl 的 shasum、openssl，哪个在用哪个；都没有返回 1（调用方据此拒绝）
sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  elif have openssl; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else return 1; fi
}
sha256_is() { local h; h=$(sha256_of "$1") && [[ -n $h && $h == "$2" ]] || { echo "sha256 mismatch: $1 (got ${h:-?}, want $2)" >>"${LOG:-/dev/null}"; return 1; }; }
# 生成文件里的引用：sh 的单引号（' → '\''）、桌面项 Exec 的双引号（规范要求 \ " ` $ 先按字符串转义再按参数转义，% 写成 %%）、crontab（% 是换行，写成 \%）
sq() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
desk_q() { local s=$1; s=${s//\\/\\\\\\\\}; s=${s//\"/\\\\\"}; s=${s//\`/\\\\\`}; s=${s//\$/\\\\\$}; s=${s//%/%%}; printf '"%s"' "$s"; }
cron_q() { local s; s=$(sq "$1"); printf '%s' "${s//%/\\%}"; }

# ---------------------------------------------------------------- 参数
LAN=${QUETZAL_LAN:-0}; OPEN=1; DESKTOP=1; HOME_DIR="${QUETZAL_HOME:-}"; VERSION="${QUETZAL_VERSION:-latest}"; MIRROR="${QUETZAL_MIRROR:-auto}"; MODE=install; PURGE=0
[[ "${QUETZAL_NO_OPEN:-0}" != 0 ]] && OPEN=0
[[ "${QUETZAL_NO_DESKTOP:-0}" != 0 ]] && DESKTOP=0
usage() {
  say "curl -fsSL $SITE/install | bash -s -- [--lan] [--no-open] [--no-desktop] [--home DIR] [--version X] [--cn|--no-cn] [--lang zh|en] [--uninstall [--purge]]"
}
parse_args() {
  while (( $# )); do
    case "$1" in
      --lan) LAN=1;; --no-lan) LAN=0;;
      --no-open) OPEN=0;; --no-desktop) DESKTOP=0;;
      --home) shift; HOME_DIR="${1:-}";;
      --version) shift; VERSION="${1:-latest}";;
      --cn) MIRROR=cn;; --no-cn) MIRROR=off;;
      --uninstall) MODE=uninstall;; --purge) PURGE=1;;
      --lang) shift; QUETZAL_LANG="${1:-}";;
      -h|--help) usage; exit 0;;
      *) say "$(t "不认识的选项：$1" "Unknown option: $1")"; usage; exit 2;;
    esac
    shift
  done
}

# 0.6.7 之前 Linux 的家目录是 ~/quetzal：目标家目录（默认 ~/.quetzal，或用户指定的位置）还不存在、老目录里有装过的痕迹时，整目录搬过去
# （配置、记忆、对话原样保留）。一台机器只有一个 quetzal 服务，不存在「老的留着再装一个新的」的情形，所以显式指定位置时同样搬。
# 必须在建新目录之前做，并先停掉老的服务 / 守护循环（它们记着老路径）；之后安装流程会用新路径重写服务单元、垫片、启动器与开机项。
DEFAULT_HOME=0
migrate_legacy_home() {
  local old="$HOME/quetzal"
  [[ "$HOME_DIR" == "$old" ]] && return 0
  [[ -e "$HOME_DIR" ]] && return 0
  [[ -e "$old/config/quetzal.json" || -d "$old/releases" ]] || return 0
  have systemctl && systemctl --user stop quetzal >/dev/null 2>&1 || true
  local pid; pid=$(cat "$old/state/supervise.pid" 2>/dev/null || true)
  [[ -n $pid ]] && kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  mv "$old" "$HOME_DIR" || die "$(t "没能把 $old 搬到 $HOME_DIR" "Could not move $old to $HOME_DIR")"
  ok "$(t "家目录从 $old 搬到了 $HOME_DIR（配置、记忆、对话原样保留；想放别处请设 QUETZAL_HOME）" "Home directory moved from $old to $HOME_DIR (configuration, memories and conversations kept; set QUETZAL_HOME to use another place)")"
}

# ---------------------------------------------------------------- 1. 这台机器
OS_NAME=""; ARCH=""; PM=""; DISTRO_ID=""; LIBC=glibc; HAS_SYSTEMD=0; HAS_SESSION=0; HAS_DESKTOP=0; IS_WSL=0; IS_CONTAINER=0; USER_NAME=""
detect_machine() {
  [[ "$(uname -s 2>/dev/null)" == Linux ]] || die "$(t '这个安装器只支持 Linux。安卓手机请装 Quetzal App；其他系统见文档。' 'This installer supports Linux only. Use the Quetzal app on Android; see the docs for other systems.')"
  (( BASH_VERSINFO[0] >= 4 )) || die "$(t "需要 bash 4 以上（当前 $BASH_VERSION）。" "bash 4 or later is required (found $BASH_VERSION).")"
  USER_NAME=$(id -un 2>/dev/null || echo "${USER:-user}")
  if [[ -z "${HOME:-}" || ! -d "$HOME" ]]; then
    HOME=$(getent passwd "$USER_NAME" 2>/dev/null | cut -d: -f6); export HOME
    [[ -n "$HOME" && -d "$HOME" ]] || die "$(t '找不到家目录（HOME 为空）。' 'Cannot determine the home directory (HOME is empty).')"
  fi
  [[ -w "$HOME" ]] || die "$(t "家目录不可写：$HOME" "Home directory is not writable: $HOME")"
  ARCH=$(uname -m 2>/dev/null || echo unknown)
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    OS_NAME=$( . /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}" )
    DISTRO_ID=$( . /etc/os-release 2>/dev/null; printf '%s %s' "${ID:-}" "${ID_LIKE:-}" )
  else OS_NAME=Linux; fi
  if have apt-get; then PM=apt; elif have dnf; then PM=dnf; elif have yum; then PM=yum; elif have pacman; then PM=pacman
  elif have zypper; then PM=zypper; elif have apk; then PM=apk; elif have xbps-install; then PM=xbps; else PM=none; fi
  if ls /lib/ld-musl-* >/dev/null 2>&1 || { have ldd && ldd --version 2>&1 | grep -qi musl; }; then LIBC=musl; fi
  grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1
  { [[ -f /.dockerenv ]] || grep -qaE 'docker|containerd|lxc|podman' /proc/1/cgroup 2>/dev/null; } && IS_CONTAINER=1
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then HAS_SYSTEMD=1; fi
  [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && HAS_SESSION=1
  local d; for d in /usr/share/xsessions /usr/share/wayland-sessions /usr/local/share/xsessions /usr/local/share/wayland-sessions; do ls "$d"/*.desktop >/dev/null 2>&1 && HAS_DESKTOP=1; done
  if (( HAS_SESSION )) || [[ -n "${XDG_CURRENT_DESKTOP:-}" ]]; then HAS_DESKTOP=1; fi
}
describe_machine() {
  local parts="$OS_NAME $I_DOT $ARCH"
  [[ $LIBC == musl ]] && parts+=" $I_DOT musl"
  if (( HAS_SYSTEMD )); then parts+=" $I_DOT systemd"; else parts+=" $I_DOT $(t '无 systemd 用户实例' 'no systemd user instance')"; fi
  (( IS_WSL )) && parts+=" $I_DOT WSL"
  (( IS_CONTAINER )) && parts+=" $I_DOT $(t '容器' 'container')"
  if (( HAS_DESKTOP )); then parts+=" $I_DOT ${XDG_CURRENT_DESKTOP:-$(t '桌面' 'desktop')}"; else parts+=" $I_DOT $(t '无桌面' 'headless')"; fi
  ok "$parts"
  (( EUID == 0 )) && warn "$(t '正以 root 运行：服务会注册在 root 的用户实例下。建议用日常账号安装。' 'Running as root: the service will live under root'"'"'s user instance. A regular account is recommended.')"
  if (( IS_WSL && ! HAS_SYSTEMD )); then warn "$(t 'WSL 没开 systemd：建议在 /etc/wsl.conf 写入 [boot] systemd=true 后 wsl --shutdown 重进，再跑一次本命令可换成 systemd 守护。' 'WSL without systemd: add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown, then rerun this command to switch to systemd supervision.')"; fi
}

# ---------------------------------------------------------------- 2. 依赖
SUDO=""
need_root_runner() { # 设置 SUDO：root 不需要；否则 sudo / doas；都没有返回 1
  if (( EUID == 0 )); then SUDO=""; return 0; fi
  if have sudo; then SUDO=sudo; return 0; fi
  if have doas; then SUDO=doas; return 0; fi
  return 1
}
pkg_install() { # 用这台机器的包管理器装一组包（包名已按发行版翻译）
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive $SUDO apt-get update -qq && DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends "$@";;
    dnf) $SUDO dnf install -y -q "$@";;
    yum) $SUDO yum install -y -q "$@";;
    pacman) $SUDO pacman -S --needed --noconfirm "$@" || $SUDO pacman -Sy --needed --noconfirm "$@";;
    zypper) $SUDO zypper --non-interactive --quiet install "$@";;
    apk) $SUDO apk add --no-cache "$@";;
    xbps) $SUDO xbps-install -Sy "$@";;
    *) return 1;;
  esac
}
pkg_name() { # 工具名 → 这个发行版的包名
  case "$1" in
    xz) case "$PM" in apt) echo xz-utils;; *) echo xz;; esac;;
    certs) case "$PM" in pacman|xbps) echo ca-certificates;; *) echo ca-certificates;; esac;;
    *) echo "$1";;
  esac
}
# 命令沙箱：她执行的命令（shell、自造工具）在沙箱里运行，看不到运行基座的密钥目录。没有任何可用的沙箱时运行基座默认拒绝执行她的命令。
# 依次尝试（参考 DeepSeek Harness：先 bubblewrap，不行用 Landlock）：
#   1. bubblewrap：用包管理器装上，实际建一次沙箱；
#   2. Ubuntu 23.10 起 AppArmor 默认限制非特权用户命名空间，系统的 bwrap 没有允许 userns 的配置就建不了沙箱：
#      不动系统的 /usr/bin/bwrap（会影响 Flatpak 等），而是复制一份到 root 所有的 /usr/local/lib/quetzal/bwrap，
#      只给这一份装一个允许 userns 的 AppArmor 配置（与 Ubuntu 给 Chrome 等应用的写法相同），也不关全局的限制；
#   3. 内核禁止了非特权用户命名空间（或在容器里）：内核支持 Landlock 时装 landrun（随发布资产分发、签名核对，见 ensure_landlock）；
#   4. 都不行：装 proot（基于 ptrace，尽力而为）。运行基座启动时还会用探针文件实际验证一次隔离是否生效。
QZ_BWRAP=/usr/local/lib/quetzal/bwrap
QZ_AA=/etc/apparmor.d/quetzal-bwrap
SANDBOX=""
bwrap_works() { "$1" --dev-bind / / --unshare-pid --proc /proc --tmpfs /tmp true >/dev/null 2>&1; }
apparmor_restricts_userns() { [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null) == 1 ]]; }
userns_blocked_reason() { # 为什么建不了用户命名空间（给人看的一句话；不改任何内核参数）
  if [[ $(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null) == 0 ]]; then t '内核参数 kernel.unprivileged_userns_clone=0（加固过的内核）' 'kernel.unprivileged_userns_clone=0 (hardened kernel)'
  elif [[ $(cat /proc/sys/user/max_user_namespaces 2>/dev/null) == 0 ]]; then t '内核参数 user.max_user_namespaces=0' 'user.max_user_namespaces=0'
  elif [[ -f /.dockerenv || -f /run/.containerenv ]]; then t '在容器里' 'inside a container'
  else t '系统不允许非特权用户命名空间' 'unprivileged user namespaces are not allowed'; fi
}
as_root() { # 需要 root 的一步：root 直接做；免密 sudo 直接做；需要密码时有终端才问；失败不终止安装
  [[ -z $SUDO ]] && { "$@"; return; }
  if $SUDO -n true >/dev/null 2>&1; then $SUDO "$@"; elif [[ -r /dev/tty ]]; then $SUDO "$@" </dev/tty; else return 1; fi
}
install_bwrap_apparmor() { # 专用 bwrap 副本 + 只给它的 AppArmor 配置
  local parser; parser=$(command -v apparmor_parser || echo /sbin/apparmor_parser); [[ -x $parser ]] || return 1
  local bw; bw=$(command -v bwrap) || return 1
  local strict simple; strict=$(mktemp) && simple=$(mktemp) || return 1
  # 严格版（与 Ubuntu 自己的 bwrap-userns-restrict 同一写法）：只有 bwrap 本身能建用户命名空间、拿能力，
  # 它启动的程序（她的命令）被叠加到 quetzal-unpriv-bwrap，在任何命名空间里都拿不到能力。只装在 Quetzal 的副本上，不影响 Flatpak。
  cat >"$strict" <<EOF
# Quetzal 的命令沙箱（由 Quetzal 安装脚本生成）：只给 Quetzal 自己的 bwrap 副本，不改系统的 /usr/bin/bwrap，
# 也不关闭全局的 kernel.apparmor_restrict_unprivileged_userns。卸载 Quetzal 时移除。
abi <abi/4.0>,
include <tunables/global>

profile quetzal-bwrap $QZ_BWRAP flags=(attach_disconnected,mediate_deleted) {
  allow capability,
  allow file rwlkm /{**,},
  allow network,
  allow unix,
  allow ptrace,
  allow signal,
  allow mqueue,
  allow io_uring,
  allow userns,
  allow mount,
  allow umount,
  allow pivot_root,
  allow dbus,
  allow px /** -> quetzal-bwrap//&quetzal-unpriv-bwrap,
  include if exists <local/quetzal-bwrap>
}

profile quetzal-unpriv-bwrap flags=(attach_disconnected,mediate_deleted) {
  allow file rwlkm /{**,},
  allow network,
  allow unix,
  allow ptrace,
  allow signal,
  allow mqueue,
  allow io_uring,
  allow userns,
  allow mount,
  allow umount,
  allow pivot_root,
  allow dbus,
  allow pix /** -> &quetzal-unpriv-bwrap,
  audit deny capability,
  include if exists <local/quetzal-unpriv-bwrap>
}
EOF
  # 简单版：只允许这份 bwrap 建用户命名空间（Ubuntu 给 Chrome 等应用的写法）。严格版在较老的 AppArmor 上装不上或用不了时退回它
  cat >"$simple" <<EOF
# Quetzal 的命令沙箱（由 Quetzal 安装脚本生成，简单版）：只给 Quetzal 自己的 bwrap 副本。卸载 Quetzal 时移除。
abi <abi/4.0>,
include <tunables/global>

profile quetzal-bwrap $QZ_BWRAP flags=(unconfined) {
  userns,
  include if exists <local/quetzal-bwrap>
}
EOF
  chmod 644 "$strict" "$simple"
  local rc=0 f
  as_root install -d -m 755 /usr/local/lib/quetzal >>"$LOG" 2>&1 || rc=1
  (( rc )) || as_root install -m 755 "$bw" "$QZ_BWRAP" >>"$LOG" 2>&1 || rc=1
  if (( ! rc )); then
    rc=1
    for f in "$strict" "$simple"; do
      as_root install -m 644 "$f" "$QZ_AA" >>"$LOG" 2>&1 && as_root "$parser" -r "$QZ_AA" >>"$LOG" 2>&1 && bwrap_works "$QZ_BWRAP" && { rc=0; break; }
    done
  fi
  unlink "$strict" 2>/dev/null; unlink "$simple" 2>/dev/null
  return $rc
}
ensure_sandbox() {
  if [[ -x $QZ_BWRAP ]] && have bwrap && ! cmp -s "$QZ_BWRAP" "$(command -v bwrap)" && need_root_runner; then # 系统的 bwrap 升级过：专用副本跟着更新（安全修复）
    as_root install -m 755 "$(command -v bwrap)" "$QZ_BWRAP" >>"$LOG" 2>&1 || true
  fi
  if ! have bwrap && [[ $PM != none ]] && need_root_runner; then
    local label; label="$(t "安装命令沙箱 bubblewrap（$PM）" "Installing the command sandbox bubblewrap ($PM)")"
    if [[ -z $SUDO ]] || $SUDO -n true >/dev/null 2>&1; then run_try "$label" pkg_install bubblewrap || true   # run_try：失败只提示，不终止安装
    elif [[ -r /dev/tty ]]; then
      note "$(t "安装 bubblewrap 需要管理员权限，接下来会请你输入密码（$SUDO）" "Installing bubblewrap needs administrator rights; $SUDO will ask for your password")"
      pkg_install bubblewrap </dev/tty >>"$LOG" 2>&1 || true
    fi
  fi
  if [[ -x $QZ_BWRAP ]] && bwrap_works "$QZ_BWRAP"; then SANDBOX=bwrap; ok "$(t '命令沙箱可用（bubblewrap，Quetzal 专用的 AppArmor 配置）' 'Command sandbox available (bubblewrap, Quetzal AppArmor profile)')"; return; fi
  if have bwrap && bwrap_works "$(command -v bwrap)"; then SANDBOX=bwrap; ok "$(t '命令沙箱可用（bubblewrap）' 'Command sandbox available (bubblewrap)')"; return; fi
  if have bwrap && apparmor_restricts_userns && need_root_runner; then
    note "$(t '这台机器用 AppArmor 限制了非特权用户命名空间：给 Quetzal 装一份专用的 bwrap 与只属于它的 AppArmor 配置（不改系统的 bwrap，也不关全局限制）' 'AppArmor restricts unprivileged user namespaces here: installing a Quetzal-only copy of bwrap with its own AppArmor profile (the system bwrap and the global restriction are left alone)')"
    if install_bwrap_apparmor && bwrap_works "$QZ_BWRAP"; then SANDBOX=bwrap; ok "$(t '命令沙箱可用（bubblewrap，Quetzal 专用的 AppArmor 配置）' 'Command sandbox available (bubblewrap, Quetzal AppArmor profile)')"; return; fi
    note "$(t '专用的 AppArmor 配置没有装上（需要 AppArmor 4 与管理员权限）' 'Could not install the Quetzal AppArmor profile (needs AppArmor 4 and administrator rights)')"
  fi
  if have bwrap; then note "$(t "bubblewrap 建不了沙箱：$(userns_blocked_reason)。稍后改用 Landlock 或 proot" "bubblewrap cannot create a sandbox: $(userns_blocked_reason). Will use Landlock or proot instead")"
  else note "$(t '没有 bubblewrap：稍后改用 Landlock 或 proot' 'No bubblewrap: will use Landlock or proot instead')"; fi
}
landlock_supported() { grep -qw landlock /sys/kernel/security/lsm 2>/dev/null; }
download_landrun() { # 版本 架构：landrun（Landlock 启动器，MIT）随 Quetzal 发布资产分发，验签名与哈希后放到 $HOME_DIR/bin/landrun
  local v=$1 arch=$2 name="quetzal-$1-landrun-linux-$2.tar.gz" d want="" base
  d=$(mktemp -d "$HOME_DIR/state/landrun.XXXXXX") || return 1
  for base in "$SITE_DL/v$v" "$REPO_DL/v$v"; do
    fetch_file "$base/SHA256SUMS" "$d/SHA256SUMS" 60 && fetch_file "$base/SHA256SUMS.sig" "$d/SHA256SUMS.sig" 60 || continue
    want=$(release_sum "$d/SHA256SUMS" "$d/SHA256SUMS.sig" "$name" "v$v" 2>>"$LOG") && [[ $want =~ ^[0-9a-f]{64}$ ]] && break
    want=""
  done
  local ok_dl=0
  if [[ -n $want ]]; then
    for base in "$SITE_DL/v$v" "$REPO_DL/v$v"; do fetch_file "$base/$name" "$d/l.tgz" 300 && sha256_is "$d/l.tgz" "$want" && { ok_dl=1; break; }; done
  fi
  if (( ok_dl )) && tar -xzf "$d/l.tgz" -C "$d" landrun LICENSE 2>>"$LOG" && [[ -f $d/landrun ]]; then
    mkdir -p "$HOME_DIR/bin" && install -m 755 "$d/landrun" "$HOME_DIR/bin/landrun" && install -m 644 "$d/LICENSE" "$HOME_DIR/bin/landrun.LICENSE"
  else ok_dl=0; fi
  find "$d" -mindepth 1 -delete 2>/dev/null; rmdir "$d" 2>/dev/null
  (( ok_dl ))
}
ensure_landlock() { # 运行基座装好之后：bubblewrap 不可用时补上 Landlock，再不行补 proot
  [[ $SANDBOX == bwrap ]] && return 0
  local v; v=$(installed_version)
  local arch=""; case "$ARCH" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; esac
  if landlock_supported && [[ -n $arch && -n $v ]]; then
    if run_try "$(t '下载 Landlock 沙箱启动器（landrun，核对发版签名）' 'Downloading the Landlock sandbox launcher (landrun, release signature verified)')" download_landrun "$v" "$arch"; then
      SANDBOX=landlock; ok "$(t '命令沙箱可用（Landlock）' 'Command sandbox available (Landlock)')"; return
    fi
  fi
  if ! have proot && [[ $PM != none ]] && need_root_runner; then
    if [[ -z $SUDO ]] || $SUDO -n true >/dev/null 2>&1; then pkg_install proot >>"$LOG" 2>&1 || true
    elif [[ -r /dev/tty ]]; then pkg_install proot </dev/tty >>"$LOG" 2>&1 || true; fi
  fi
  if have proot; then SANDBOX=proot; ok "$(t '命令沙箱：proot（尽力而为的隔离）' 'Command sandbox: proot (best-effort isolation)')"; return; fi
  warn "$(t '没有可用的命令沙箱：运行基座会拒绝执行她的命令（为了不让命令读到密钥）。装上 bubblewrap 或 proot 后重新运行安装命令；或在控制台「服务」页明确允许不隔离运行（不安全）' 'No command sandbox is available: the runtime will refuse to run her commands (so they cannot read the secrets). Install bubblewrap or proot and rerun the installer, or explicitly allow unsandboxed commands on the console Service page (unsafe)')"
}
ensure_tools() {
  local missing=() tool
  for tool in git curl tar; do have "$tool" || missing+=("$tool"); done
  [[ -d /etc/ssl/certs || -f /etc/ssl/cert.pem || -f /etc/pki/tls/cert.pem ]] || missing+=(certs)
  if (( ${#missing[@]} == 0 )); then ok "$(t 'git、curl、tar 都在' 'git, curl and tar are present')"; return; fi
  have xz || missing+=(xz)        # 反正要装东西，顺手把 xz 带上：nvm 有 xz 时下载 .tar.xz（小一半），没有退回 .tar.gz
  local pkgs=() m; for m in "${missing[@]}"; do pkgs+=("$(pkg_name "$m")"); done
  if [[ $PM == none ]]; then die "$(t "缺少 ${missing[*]}，而且认不出这台机器的包管理器。请先自行安装它们再重试。" "Missing ${missing[*]} and no known package manager found. Install them and rerun.")"; fi
  if ! need_root_runner; then die "$(t "缺少 ${missing[*]}，需要管理员权限安装，但没有 sudo / doas。请以管理员执行：$PM install ${pkgs[*]}" "Missing ${missing[*]}; installing needs root but neither sudo nor doas exists. As an administrator run: $PM install ${pkgs[*]}")"; fi
  local label; label="$(t "安装 ${missing[*]}（$PM）" "Installing ${missing[*]} ($PM)")"
  if [[ -z $SUDO ]] || $SUDO -n true >/dev/null 2>&1; then run_step "$label" pkg_install "${pkgs[@]}"
  else
    note "$(t "需要管理员权限安装 ${missing[*]}，接下来会请你输入密码（$SUDO）" "Installing ${missing[*]} needs administrator rights; $SUDO will ask for your password")"
    run_tty "$label" pkg_install "${pkgs[@]}"
  fi
  for tool in git tar; do have "$tool" || die "$(t "$tool 还是没有装上" "$tool is still missing")"; done
  have curl || have wget || die "curl / wget"
}

# Node：优先 PATH 上已有且够新的（必须连 npm 一起有）；否则 nvm；musl / NixOS 用发行版的包
NODE=""; NPM=""; NODE_FROM=""
node_ok() { # 路径 → 版本 ≥ 22.13 且旁边有 npm
  local v maj min
  v=$("$1" -v 2>/dev/null) || return 1
  v=${v#v}; maj=${v%%.*}; min=${v#*.}; min=${min%%.*}
  [[ $maj =~ ^[0-9]+$ && $min =~ ^[0-9]+$ ]] || return 1
  (( maj > NODE_MAJOR || (maj == NODE_MAJOR && min >= NODE_MIN_MINOR) )) || return 1
  [[ -x "$(dirname "$1")/npm" ]] || have npm || return 1
  NODE_VER="v$v"
}
pick_mirror() {
  case "$MIRROR" in cn|off) return;; esac
  if fetch_ok "https://nodejs.org/dist/index.json" 5; then MIRROR=off; else MIRROR=cn; note "$(t '直连 nodejs.org 不通，改用国内镜像（npmmirror）' 'nodejs.org is unreachable; using the npmmirror mirror')"; fi
}
nvm_env() { # 让 nvm 在这个 shell 里可用（nvm 对 set -u 不友好，调用方负责 set +u）
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ $MIRROR == cn ]]; then export NVM_NODEJS_ORG_MIRROR="https://npmmirror.com/mirrors/node"; fi
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  have nvm
}
install_nvm() { # 先下载到文件、核对固定的 sha256，再执行（不再 curl | bash）；nvm 自己按固定标签 git clone，下载 Node 时核对 SHASUMS256
  local url="https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" f="$HOME_DIR/nvm-install.sh" rc=0
  if [[ $MIRROR == cn ]]; then url="https://gitee.com/mirrors/nvm/raw/$NVM_VERSION/install.sh"; export NVM_SOURCE="https://gitee.com/mirrors/nvm.git"; fi
  rm -f "$f"
  fetch_file "$url" "$f" 60 || return 1
  sha256_is "$f" "$NVM_INSTALL_SHA256" || { rm -f "$f"; return 1; }
  bash "$f" || rc=$?
  rm -f "$f"; return $rc
}
nvm_install_node() { set +u; nvm_env || return 1; nvm install "$NODE_MAJOR" --no-progress && nvm alias default "$NODE_MAJOR" >/dev/null; local rc=$?; set -u; return $rc; }
# 官方不出二进制的架构：Node.js 项目的 unofficial-builds（https://unofficial-builds.nodejs.org）有 loong64（龙芯）、riscv64、armv6l、x64/arm64 的 musl 版。
# 直接下载对应版本到 ~/.quetzal/node/<版本>/，不经 nvm（nvm 不认识这些架构，会退回到几小时的源码编译）。
UNOFFICIAL="https://unofficial-builds.nodejs.org/download/release"
node_direct_arch() { # 这台机器该用 unofficial-builds 的哪个标签；空 = 不需要（官方有二进制）
  [[ -n "${QUETZAL_NODE_ARCH:-}" ]] && { printf '%s' "$QUETZAL_NODE_ARCH"; return; }
  case "$ARCH" in loongarch64|loong64) printf 'loong64';; riscv64) printf 'riscv64';; armv6l) printf 'armv6l';; esac
}
node_direct_install() { # 架构标签：选 unofficial-builds 里最新的 v22，按同一发布目录的 SHASUMS256.txt 核对后解包
  # （unofficial-builds 不出 GPG 签名，只能核对哈希：防的是下载损坏与镜像 / 缓存被替换，信任根是 TLS 与 nodejs.org 本身）
  local arch=$1 index ver dir tmp sums want
  index=$(fetch_text "$UNOFFICIAL/index.json" 60) || return 1
  ver=$(printf '%s' "$index" | tr '}' '\n' | grep "\"version\":\"v$NODE_MAJOR\." | grep "\"linux-$arch\"" | head -n1 | sed 's/.*"version":"\(v[0-9.]*\)".*/\1/')
  [[ -n $ver ]] || { echo "unofficial-builds 没有 linux-$arch 的 v$NODE_MAJOR" >>"$LOG"; return 1; }
  dir="$HOME_DIR/node/$ver"; tmp="$HOME_DIR/node/download.tar.gz"
  mkdir -p "$HOME_DIR/node"; rm -rf "$dir.part" "$tmp"; mkdir -p "$dir.part"
  sums=$(fetch_text "$UNOFFICIAL/$ver/SHASUMS256.txt" 60) || return 1
  want=$(printf '%s\n' "$sums" | grep -E "^[0-9a-f]{64}  node-$ver-linux-$arch\.tar\.gz\$" | cut -d' ' -f1)
  [[ $want =~ ^[0-9a-f]{64}$ ]] || { echo "SHASUMS256.txt 里没有 node-$ver-linux-$arch.tar.gz" >>"$LOG"; return 1; }
  fetch_file "$UNOFFICIAL/$ver/node-$ver-linux-$arch.tar.gz" "$tmp" 900 || return 1
  sha256_is "$tmp" "$want" || { rm -f "$tmp"; return 1; }
  tar -xzf "$tmp" -C "$dir.part" --strip-components=1 || return 1
  rm -f "$tmp"; rm -rf "$dir"; mv "$dir.part" "$dir"
  "$dir/bin/node" -v >>"$LOG" 2>&1 || return 1
  ln -sfn "$dir" "$HOME_DIR/node/current"
}
find_node() {
  local cand
  if cand=$(command -v node 2>/dev/null) && node_ok "$cand"; then NODE=$cand; case "$cand" in */.nvm/*|*/nvm/*) NODE_FROM=nvm;; *) NODE_FROM="$(t '系统' 'system')";; esac; return 0; fi
  # PATH 上没有够新的：nvm 里可能已经有（非交互 shell 没加载 nvm）
  if ( set +u; nvm_env ) 2>/dev/null; then
    set +u; nvm_env; cand=$(nvm which "$NODE_MAJOR" 2>/dev/null); set -u
    if [[ -n $cand ]] && node_ok "$cand"; then NODE=$cand; NODE_FROM=nvm; return 0; fi
  fi
  return 1
}
ensure_node() {
  # 之前直接下载过的（~/.quetzal/node/current）
  if [[ -z $NODE && -x "$HOME_DIR/node/current/bin/node" ]] && node_ok "$HOME_DIR/node/current/bin/node"; then NODE="$HOME_DIR/node/current/bin/node"; NODE_FROM="unofficial-builds"; fi
  if [[ -n $NODE ]] || find_node; then NPM="$(dirname "$NODE")/npm"; [[ -x $NPM ]] || NPM=$(command -v npm); ok "Node.js $NODE_VER $I_DOT $NODE_FROM"; return; fi
  local direct; direct=$(node_direct_arch)
  if [[ -n $direct ]]; then
    # musl 版 Node 动态链接 libstdc++，Alpine 基础系统没有：先装上
    if [[ $PM == apk ]] && ! ls /usr/lib/libstdc++.so.6 >/dev/null 2>&1; then
      need_root_runner || die "$(t '需要管理员权限安装 libstdc++（apk），但没有 sudo / doas。' 'Installing libstdc++ (apk) needs root, but neither sudo nor doas exists.')"
      if [[ -z $SUDO ]] || $SUDO -n true >/dev/null 2>&1; then run_step "$(t '安装 libstdc++（apk）' 'Installing libstdc++ (apk)')" pkg_install libstdc++; else run_tty "$(t '安装 libstdc++（apk）' 'Installing libstdc++ (apk)')" pkg_install libstdc++; fi
    fi
    run_step "$(t "下载 Node.js $NODE_MAJOR（linux-$direct，Node.js 官方的 unofficial-builds）" "Downloading Node.js $NODE_MAJOR (linux-$direct, Node.js unofficial-builds)")" node_direct_install "$direct"
    NODE="$HOME_DIR/node/current/bin/node"; node_ok "$NODE" || die "$(t '下载的 Node.js 跑不起来' 'The downloaded Node.js does not run')"
    NODE_FROM="unofficial-builds"
  elif [[ $LIBC == musl || $DISTRO_ID == *nixos* ]]; then
    # 官方二进制是 glibc 的，nvm 在 musl 上只能从源码编译；NixOS 没有 FHS。用发行版自己的包。
    if [[ $PM == apk ]]; then
      need_root_runner || die "$(t '需要管理员权限安装 nodejs npm（apk），但没有 sudo / doas。' 'Installing nodejs npm (apk) needs root, but neither sudo nor doas exists.')"
      if [[ -z $SUDO ]] || $SUDO -n true >/dev/null 2>&1; then run_step "$(t '安装 Node.js（apk nodejs npm）' 'Installing Node.js (apk nodejs npm)')" pkg_install nodejs npm
      else run_tty "$(t '安装 Node.js（apk nodejs npm）' 'Installing Node.js (apk nodejs npm)')" pkg_install nodejs npm; fi
      find_node || die "$(t "发行版的 Node.js 低于 $NODE_MAJOR.$NODE_MIN_MINOR，请升级系统或自行安装更新的版本。" "The distro's Node.js is older than $NODE_MAJOR.$NODE_MIN_MINOR; upgrade the system or install a newer one.")"
    else
      die "$(t "这台机器（$( [[ $LIBC == musl ]] && echo musl || echo NixOS )）不能用 nvm 的官方二进制。请先用系统的包管理器装好 Node.js ≥ $NODE_MAJOR.$NODE_MIN_MINOR（含 npm）再重试。" "nvm's official binaries do not run here ($( [[ $LIBC == musl ]] && echo musl || echo NixOS )). Install Node.js ≥ $NODE_MAJOR.$NODE_MIN_MINOR with npm from your package manager, then rerun.")"
    fi
  else
    pick_mirror
    if ! ( set +u; nvm_env ) 2>/dev/null; then
      run_step "$(t "安装 nvm $NVM_VERSION（装进 ~/.nvm，不碰系统的 Node）" "Installing nvm $NVM_VERSION (into ~/.nvm; the system Node is untouched)")" install_nvm
    fi
    run_step "$(t "经 nvm 安装 Node.js $NODE_MAJOR" "Installing Node.js $NODE_MAJOR via nvm")" nvm_install_node
    find_node || die "$(t 'Node.js 装完却找不到。' 'Node.js was installed but cannot be found.')"
  fi
  NPM="$(dirname "$NODE")/npm"; [[ -x $NPM ]] || NPM=$(command -v npm)
  ok "Node.js $NODE_VER $I_DOT $NODE_FROM"
}

# ---------------------------------------------------------------- 3. 运行基座（npm 包装进 ~/.quetzal/npm，由它完成版本目录、配置、systemd、健康检查）
NPM_PREFIX=""; QCLI=""
npm_install_pkg() {
  local reg=()
  [[ $MIRROR == cn ]] && reg=(--registry=https://registry.npmmirror.com)
  # npm 的 shebang 是 #!/usr/bin/env node：直接下载的 Node 不在 PATH 里，这里把它的目录放到最前面
  PATH="$(dirname "$NODE"):$PATH" "$NPM" install -g --prefix "$NPM_PREFIX" --no-fund --no-audit --loglevel=error "${reg[@]}" "$PKG@$VERSION"
}
cli_install() {
  local args=(install --home "$HOME_DIR" --no-open)
  (( LAN )) && args+=(--lan)
  "$NODE" "$QCLI" "${args[@]}"
}
installed_version() { readlink "$HOME_DIR/current" 2>/dev/null | sed 's#.*/##'; }
gateway_port() { sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HOME_DIR/config/quetzal.json" 2>/dev/null | head -n1; }
health_ok() { fetch_ok "http://127.0.0.1:$(gateway_port_or_default)/health" 2; }
gateway_port_or_default() { local p; p=$(gateway_port); printf '%s' "${p:-7788}"; }
wait_healthy() { local i; for (( i = 0; i < ${1:-40}; i++ )); do health_ok && return 0; sleep 1; done; return 1; }
install_runtime() {
  NPM_PREFIX="$HOME_DIR/npm"; mkdir -p "$NPM_PREFIX"
  run_step "$(t "下载 $PKG@$VERSION（含运行基座与网页控制台）" "Downloading $PKG@$VERSION (runtime and web console)")" npm_install_pkg
  QCLI="$NPM_PREFIX/lib/node_modules/$PKG/dist/quetzal.mjs"
  [[ -f $QCLI ]] || die "$(t "npm 包装完却找不到 $QCLI" "Installed, but $QCLI is missing")"
  local before; before=$(installed_version)
  run_step "$(t '放入运行基座、注册服务并等它响应' 'Placing the runtime, registering the service, waiting for it to respond')" cli_install
  local now; now=$(installed_version)
  if [[ -n $before && $before != "$now" ]]; then note "$(t "升级：$before → $now" "Upgraded: $before → $now")"; fi
  write_shim
}
write_shim() { # ~/.local/bin/quetzal：固定使用安装时的 node 与包路径，任何 shell（包括没加载 nvm 的）都能用
  mkdir -p "$HOME/.local/bin"
  cat >"$HOME/.local/bin/quetzal" <<EOF
#!/bin/sh
# $(t '由 Quetzal 安装脚本生成：quetzal status / logs -f / open / rollback / uninstall；重装请再跑一次安装命令' 'Generated by the Quetzal installer: quetzal status / logs -f / open / rollback / uninstall; rerun the install command to reinstall')
export QUETZAL_HOME=$(sq "$HOME_DIR")
exec $(sq "$NODE") $(sq "$QCLI") "\$@"
EOF
  chmod 755 "$HOME/.local/bin/quetzal"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
    local rc line='export PATH="$HOME/.local/bin:$PATH"  # Quetzal'
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      [[ -f $rc ]] || [[ $rc == "$HOME/.profile" ]] || continue
      grep -qs '# Quetzal$' "$rc" || printf '\n%s\n' "$line" >>"$rc"
    done
    if [[ -d $HOME/.config/fish ]]; then mkdir -p "$HOME/.config/fish/conf.d"; printf 'fish_add_path -g ~/.local/bin  # Quetzal\n' >"$HOME/.config/fish/conf.d/quetzal.fish"; fi
    note "$(t '已把 ~/.local/bin 加进 PATH（新开的终端生效）' 'Added ~/.local/bin to PATH (takes effect in new terminals)')";;
  esac
}

# ---------------------------------------------------------------- 4. 守护
SUPERVISOR=""
SERVICE_DESC=""
ensure_linger() {
  have loginctl || return 1
  [[ "$(loginctl show-user "$USER_NAME" -p Linger 2>/dev/null)" == *=yes ]] && return 0
  loginctl enable-linger "$USER_NAME" >>"$LOG" 2>&1 && return 0
  if need_root_runner && [[ -n $SUDO ]]; then
    if $SUDO -n true >/dev/null 2>&1; then $SUDO loginctl enable-linger "$USER_NAME" >>"$LOG" 2>&1 && return 0
    elif [[ -r /dev/tty ]]; then
      note "$(t '让服务在没登录时也运行需要管理员权限（loginctl enable-linger），请输入密码' 'Running the service without a login session needs administrator rights (loginctl enable-linger); please enter your password')"
      $SUDO loginctl enable-linger "$USER_NAME" </dev/tty >>"$LOG" 2>&1 && return 0
    fi
  fi
  return 1
}
ensure_service() {
  if (( HAS_SYSTEMD )); then
    systemctl --user is-enabled quetzal >/dev/null 2>&1 || die "$(t 'systemd 用户服务没有注册成功' 'The systemd user service was not registered')"
    wait_healthy 40 || die "$(t '运行基座没有响应' 'The runtime did not respond')"
    ok "$(t 'systemd 用户服务 quetzal：开机自启，退出 3 秒后自动重启' 'systemd user service quetzal: starts at boot, restarts 3 s after any exit')"
    if ensure_linger; then ok "$(t '没登录时也运行（linger）' 'Runs without a login session (linger)')"; SERVICE_DESC="$(t 'systemd 用户服务 · 开机自启 · 崩溃自动重启 · 未登录也运行' 'systemd user service · boot · auto-restart · no login needed')"
    else warn "$(t "没能开启 linger：开机后要登录一次 ta 才醒来。随时可以执行 sudo loginctl enable-linger $USER_NAME" "Could not enable linger: after a reboot it wakes up only once you log in. Run sudo loginctl enable-linger $USER_NAME any time")"; SERVICE_DESC="$(t 'systemd 用户服务 · 登录后自启 · 崩溃自动重启' 'systemd user service · starts at login · auto-restart')"; fi
    return
  fi
  # 没有 systemd 用户实例：自带的守护循环（不装任何额外软件），开机靠 crontab @reboot 与桌面自启动项
  install_supervisor
  start_supervisor
  wait_healthy 40 || die "$(t "运行基座没有响应（日志：$HOME_DIR/logs/runtime.log）" "The runtime did not respond (log: $HOME_DIR/logs/runtime.log)")"
  ok "$(t '守护循环已启动：退出 3 秒后自动重启' 'Supervisor loop running: restarts 3 s after any exit')"
  local boot=()
  if have crontab; then
    if ( crontab -l 2>/dev/null | grep -v 'quetzal-supervise'; printf '@reboot %s\n' "$(cron_q "$SUPERVISOR")" ) | crontab - 2>>"$LOG"; then boot+=("crontab @reboot"); fi
  fi
  if (( HAS_DESKTOP )); then
    mkdir -p "$HOME/.config/autostart"
    cat >"$HOME/.config/autostart/quetzal-runtime.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Quetzal runtime
Comment=$(t 'Quetzal 运行基座的守护循环（登录桌面时拉起）' 'Supervisor loop for the Quetzal runtime (started at desktop login)')
Exec=$(desk_q "$SUPERVISOR")
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
    boot+=("$(t '桌面自启动' 'desktop autostart')")
  fi
  if (( ${#boot[@]} )); then ok "$(t "开机自启：${boot[*]}" "Starts at boot via: ${boot[*]}")"; SERVICE_DESC="$(t "守护循环 · 开机自启（${boot[*]}）· 崩溃自动重启" "supervisor loop · boot (${boot[*]}) · auto-restart")"
  else warn "$(t "没有 crontab 也没有桌面：开机后请手动执行 $SUPERVISOR" "No crontab and no desktop: run $SUPERVISOR after each boot")"; SERVICE_DESC="$(t '守护循环 · 崩溃自动重启（开机需手动拉起）' 'supervisor loop · auto-restart (start by hand after boot)')"; fi
  note "$(t "日志：$HOME_DIR/logs/runtime.log" "Log: $HOME_DIR/logs/runtime.log")"
}
install_supervisor() {
  SUPERVISOR="$HOME_DIR/bin/quetzal-supervise"
  mkdir -p "$HOME_DIR/bin" "$HOME_DIR/state" "$HOME_DIR/logs"
  local tpl
  IFS= read -r -d '' tpl <<'EOF' || true
#!/bin/sh
# Quetzal 守护者（没有 systemd 用户实例的机器）：由安装脚本生成。循环拉起运行基座，退出 3 秒后重启；
# 同一时刻只有一个（flock 或 pid 文件）。开机由 crontab 的 @reboot 或桌面自启动项拉起；停止：kill $(cat state/supervise.pid)
# 控制台「服务」页的守护开关关闭时会放一个 state/supervise.off：循环看到它就暂停拉起（自己不退出），删掉即恢复。
HOME_DIR=__HOME_DIR__
NODE=__NODE__
mkdir -p "$HOME_DIR/state" "$HOME_DIR/logs"
LOCK="$HOME_DIR/state/supervise.lock"; PIDF="$HOME_DIR/state/supervise.pid"; LOG="$HOME_DIR/logs/runtime.log"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"; flock -n 9 || exit 0
else
  old=$(cat "$PIDF" 2>/dev/null); [ -n "$old" ] && kill -0 "$old" 2>/dev/null && exit 0
fi
echo $$ >"$PIDF"
child=
trap 'kill "$child" 2>/dev/null; rm -f "$PIDF"; exit 0' INT TERM
export QUETZAL_HOME="$HOME_DIR" QUETZAL_ADAPTER="$HOME_DIR/current/linux.mjs"
while :; do
  while [ -e "$HOME_DIR/state/supervise.off" ]; do sleep 5; done
  if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 10485760 ]; then mv -f "$LOG" "$LOG.1"; fi
  cd "$HOME_DIR/current" 2>/dev/null || { echo "no current version" >>"$LOG"; sleep 10; continue; }
  "$NODE" --enable-source-maps "$HOME_DIR/current/main.cjs" >>"$LOG" 2>&1 &
  child=$!; wait "$child"
  sleep 3
done
EOF
  tpl=${tpl//__HOME_DIR__/"$(sq "$HOME_DIR")"}; tpl=${tpl//__NODE__/"$(sq "$NODE")"}
  printf '%s' "$tpl" >"$SUPERVISOR"; chmod 755 "$SUPERVISOR"
}
start_supervisor() {
  local pid; pid=$(cat "$HOME_DIR/state/supervise.pid" 2>/dev/null || true)
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then # 已在跑：让它重启运行基座以换到新版本
    pkill -TERM -P "$pid" 2>/dev/null || kill -TERM "$(pgrep -P "$pid" 2>/dev/null)" 2>/dev/null || true; return 0
  fi
  if have setsid; then setsid "$SUPERVISOR" >/dev/null 2>&1 </dev/null & else nohup "$SUPERVISOR" >/dev/null 2>&1 </dev/null & fi
  disown 2>/dev/null || true
}

# ---------------------------------------------------------------- 5. 桌面：原生控制台 + 应用列表里的「Quetzal」
NATIVE=""   # 原生控制台的可执行文件（装上了才非空）
LDCACHE=""  # ldconfig -p 的输出（依赖检查用）
LAUNCHER=""
REPO_DL="https://github.com/PlutoKeating/Project.Quetzal/releases/download"
SITE_DL="$SITE/dl"   # 官网的镜像源（Cloudflare 边缘缓存）：GitHub 连不上的网络先走它
# 发版清单：SHA256SUMS（每个资产一行 `<哈希>  <文件名>`，外加一行 `commit <提交> <标签>`）与 SHA256SUMS.sig（Ed25519 签名的 base64）。
# 用已经装好的 node 验签名（公钥 RELEASE_PUBKEY 写死在本脚本里），再确认提交行的标签就是这个版本，输出资产的期望哈希；任何一步不过返回非 0。
release_sum() { # SHA256SUMS SHA256SUMS.sig 资产名 标签
  "$NODE" -e '
const c = require("crypto"), f = require("fs");
const [sums, sig, name, tag, x] = process.argv.slice(1);
const data = f.readFileSync(sums);
const key = c.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
if (!c.verify(null, data, key, Buffer.from(f.readFileSync(sig, "utf8").trim(), "base64"))) { console.error("SHA256SUMS: bad signature"); process.exit(2); }
const lines = data.toString("utf8").split("\n").map((l) => l.trim());
if (!lines.some((l) => { const m = /^commit ([0-9a-f]{40}) (\S+)$/.exec(l); return m && m[2] === tag; })) { console.error("SHA256SUMS: no commit line for " + tag); process.exit(3); }
for (const l of lines) { const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l); if (m && m[2] === name) { console.log(m[1]); process.exit(0); } }
console.error("SHA256SUMS: no entry for " + name); process.exit(4);
' "$1" "$2" "$3" "$4" "$RELEASE_PUBKEY"
}
# 原生控制台能不能在这台机器上起来：只读地解析 ELF（readelf / objdump，不执行下载来的程序，也不用会执行它的 ldd），
# 看依赖的共享库（包里 lib/ 自带的除外）这台机器有没有、要求的 glibc 版本够不够；两个工具都没有就不查（装了起不来时桌面项照样能用浏览器）。
elf_needed() { if have readelf; then readelf -d "$1" 2>/dev/null | sed -n 's/.*(NEEDED).*\[\(.*\)\].*/\1/p'; else objdump -p "$1" 2>/dev/null | sed -n 's/^ *NEEDED *\([^ ]*\).*/\1/p'; fi; }
elf_glibc() { if have readelf; then readelf -V "$1" 2>/dev/null; else objdump -p "$1" 2>/dev/null; fi | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/GLIBC_//'; }
ver_gt() { local a1=${1%%.*} a2=${1#*.} b1=${2%%.*} b2=${2#*.}; (( a1 > b1 || (a1 == b1 && ${a2%%.*} > ${b2%%.*}) )); }
lib_present() {
  if [[ -n $LDCACHE ]]; then printf '%s\n' "$LDCACHE" | awk -v l="$1" '$1 == l { f = 1 } END { exit !f }' && return 0; fi
  local d; for d in /lib /usr/lib /lib64 /usr/lib64 /lib/*-linux-gnu /usr/lib/*-linux-gnu /usr/local/lib; do [[ -e $d/$1 ]] && return 0; done
  return 1
}
MISSING_LIBS=""   # 原生控制台缺的共享库（console_runs_here 填）
console_runs_here() { # 解包目录
  local d=$1 f lib v sys bad=0
  MISSING_LIBS=""
  have readelf || have objdump || { echo "readelf / objdump 都没有：跳过原生控制台的依赖检查" >>"$LOG"; return 0; }
  LDCACHE=$( { ldconfig -p || /sbin/ldconfig -p; } 2>/dev/null ) || LDCACHE=""
  sys=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed 's/^glibc //')
  for f in "$d/quetzal-console" "$d"/lib/*.so; do
    [[ -f $f ]] || continue
    while IFS= read -r lib; do
      [[ -z $lib || -e "$d/lib/$lib" ]] && continue
      lib_present "$lib" || { echo "$(basename "$f"): $lib not found" >>"$LOG"; bad=1; [[ " $MISSING_LIBS " == *" $lib "* ]] || MISSING_LIBS="$MISSING_LIBS $lib"; }
    done < <(elf_needed "$f")
    if [[ $sys =~ ^[0-9]+\.[0-9]+ ]]; then
      while IFS= read -r v; do ver_gt "$v" "$sys" && { echo "$(basename "$f"): GLIBC_$v > $sys" >>"$LOG"; bad=1; }; done < <(elf_glibc "$f" | sort -u)
    fi
  done
  (( ! bad ))
}
download_console() { # 版本 架构 目标目录：下载同版本的原生控制台，验签名与哈希后解包（顶层目录 quetzal-console/ 去掉）
  local v=$1 arch=$2 dir=$3 tmp="$3.tar.gz" sums="$3.SHA256SUMS" sig="$3.SHA256SUMS.sig" want="" base
  local name="quetzal-$v-linux-$arch-console.tar.gz"
  rm -rf "$dir.part" "$tmp" "$sums" "$sig"; mkdir -p "$dir.part"
  # 清单与签名：先走官网镜像源，验不过再直连 GitHub（信任根是签名，不是下载来源）
  for base in "$SITE_DL/v$v" "$REPO_DL/v$v"; do
    if ! fetch_file "$base/SHA256SUMS" "$sums" 60 || ! fetch_file "$base/SHA256SUMS.sig" "$sig" 60; then continue; fi
    want=$(release_sum "$sums" "$sig" "$name" "v$v" 2>>"$LOG") && [[ $want =~ ^[0-9a-f]{64}$ ]] && break
    want=""; echo "$base: SHA256SUMS 验证失败" >>"$LOG"
  done
  rm -f "$sums" "$sig"
  [[ -n $want ]] || { echo "没有通过签名验证的 SHA256SUMS（v$v 之前的版本没有签名清单），不装原生控制台" >>"$LOG"; return 1; }
  for base in "$SITE_DL/v$v" "$REPO_DL/v$v"; do
    fetch_file "$base/$name" "$tmp" 600 && sha256_is "$tmp" "$want" && break
    rm -f "$tmp"
  done
  [[ -f $tmp ]] || return 1
  tar -xzf "$tmp" -C "$dir.part" --strip-components=1 || return 1
  rm -f "$tmp"
  [[ -x "$dir.part/quetzal-console" ]] || return 1
  # 发行版太旧（glibc / GTK 版本不够）时装了也起不来：缺依赖就放弃，退回浏览器。
  # 只缺托盘图标用的 libayatana-appindicator3（一些精简的桌面没装）：能免密装就用包管理器补上再查一次
  if ! console_runs_here "$dir.part"; then
    [[ ${MISSING_LIBS# } == libayatana-appindicator3.so.1 ]] && install_tray_lib && console_runs_here "$dir.part" || return 1
  fi
  rm -rf "$dir"; mv "$dir.part" "$dir"
}
install_tray_lib() { # 托盘图标的系统库：只在 root / 免密 sudo（或这次安装里已经输过密码）时装，不在转圈中途问密码
  local p; case "$PM" in apt) p=libayatana-appindicator3-1;; dnf|yum) p=libayatana-appindicator-gtk3;; pacman|xbps) p=libayatana-appindicator;; zypper) p=libayatana-appindicator3-1;; *) return 1;; esac
  [[ -z $SUDO ]] || $SUDO -n true >/dev/null 2>&1 || { echo "缺 $p：需要 root 权限才能装，这次不装（装上后再跑一次安装命令即可用原生控制台）" >>"$LOG"; return 1; }
  pkg_install "$p" >>"$LOG" 2>&1
}
install_native_console() {
  local v; v=$(installed_version); [[ -n $v ]] || return 0
  [[ $LIBC == musl ]] && { note "$(t 'musl 系统没有原生控制台（它是 glibc 构建），桌面项用浏览器打开，功能相同' 'No native console on musl systems (it is a glibc build); the app-list entry opens the browser, same features')"; return 0; }
  local arch; case "$ARCH" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) note "$(t "$ARCH 架构暂无原生控制台（Flutter 上游还不支持），桌面项用浏览器打开，功能相同" "No native console for $ARCH yet (upstream Flutter does not support it); the app-list entry opens the browser, same features")"; return 0;; esac
  local base="$HOME_DIR/console" dir="$HOME_DIR/console/$v"
  mkdir -p "$base"
  if [[ ! -x "$dir/quetzal-console" ]]; then
    if ! run_try "$(t "下载原生控制台 $v（Linux 桌面版）" "Downloading the native console $v (Linux desktop)")" download_console "$v" "$arch" "$dir"; then
      rm -rf "$dir.part" "$dir.tar.gz" "$dir.SHA256SUMS" "$dir.SHA256SUMS.sig"
      note "$(t "这个版本没有可用的原生控制台（下载失败、签名或哈希校验没通过，或缺依赖）：桌面项改用浏览器打开；下次升级会再试" "No usable native console for this version (download failed, signature or checksum verification failed, or missing libraries): the app-list entry opens the browser instead; the next upgrade will retry")"
      return 0
    fi
  fi
  ln -sfn "$dir" "$base/current"
  local d; for d in "$base"/*/; do d=${d%/}; [[ $d == "$dir" || $(basename "$d") == current ]] || rm -rf "$d"; done  # 只留当前版本
  NATIVE="$base/current/quetzal-console"
  ok "$(t "原生控制台 $v 就位：应用列表、任务栏、Alt-Tab 都是 Quetzal 自己的图标" "Native console $v in place: Quetzal's own icon in the app list, taskbar and Alt-Tab")"
}
install_desktop() {
  (( HAS_DESKTOP && DESKTOP )) || return 0
  install_native_console
  local icon_src="$HOME_DIR/current/web/icons" apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications" icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" icon_name=xyz.quetzal.console size
  mkdir -p "$apps" "$HOME/.local/bin"
  if [[ -f $icon_src/Icon-512.png ]]; then
    for size in 512 192; do mkdir -p "$icons/${size}x${size}/apps"; cp -f "$icon_src/Icon-$size.png" "$icons/${size}x${size}/apps/xyz.quetzal.console.png" 2>/dev/null || true; done
  else icon_name=applications-internet; fi
  # 早期版本写的桌面项与图标名（quetzal.desktop / quetzal.png）：换成新名字，避免应用列表里出现两个
  rm -f "$apps/quetzal.desktop" "$icons/512x512/apps/quetzal.png" "$icons/192x192/apps/quetzal.png"
  LAUNCHER="$HOME/.local/bin/quetzal-console"
  local tpl
  IFS= read -r -d '' tpl <<'EOF' || true
#!/usr/bin/env bash
# Quetzal 控制台启动器（由安装脚本生成）：应用列表里的「Quetzal」点开就是它。
# 有原生控制台（~/.quetzal/console/current/quetzal-console，Flutter Linux 桌面版）就直接启动它——窗口有 Quetzal 自己的图标；
# 没有（旧版本、arm64、下载失败）就用浏览器打开网页控制台：Chromium 系以独立窗口（--app）打开，否则用默认浏览器。
# 服务没在跑就先拉起来。
HOME_DIR=__HOME_DIR__
port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HOME_DIR/config/quetzal.json" 2>/dev/null | head -n1)
url="http://127.0.0.1:${port:-7788}/"
alive() { if command -v curl >/dev/null 2>&1; then curl -fsS -m 2 -o /dev/null "${url}health"; else wget -q -T 2 -O /dev/null "${url}health"; fi 2>/dev/null; }
if ! alive; then
  systemctl --user start quetzal >/dev/null 2>&1 || { [ -x "$HOME_DIR/bin/quetzal-supervise" ] && ( setsid "$HOME_DIR/bin/quetzal-supervise" >/dev/null 2>&1 </dev/null & ); }
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do alive && break; sleep 0.5; done
fi
if [ -x "$HOME_DIR/console/current/quetzal-console" ]; then exec "$HOME_DIR/console/current/quetzal-console" "$@"; fi
profile="$HOME_DIR/state/console-browser"
for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge microsoft-edge-stable vivaldi-stable vivaldi; do
  if command -v "$b" >/dev/null 2>&1; then
    exec "$b" --app="$url" --user-data-dir="$profile" --no-first-run --no-default-browser-check >/dev/null 2>&1
  fi
done
if command -v flatpak >/dev/null 2>&1; then
  for id in com.google.Chrome org.chromium.Chromium com.brave.Browser com.microsoft.Edge com.vivaldi.Vivaldi; do
    if flatpak info "$id" >/dev/null 2>&1; then
      exec flatpak run "$id" --app="$url" --user-data-dir="$profile" --no-first-run --no-default-browser-check >/dev/null 2>&1
    fi
  done
fi
if command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$url"; fi
for b in firefox x-www-browser sensible-browser; do command -v "$b" >/dev/null 2>&1 && exec "$b" "$url"; done
echo "$url"
EOF
  tpl=${tpl//__HOME_DIR__/"$(sq "$HOME_DIR")"}
  printf '%s' "$tpl" >"$LAUNCHER"; chmod 755 "$LAUNCHER"
  # 文件名 xyz.quetzal.console.desktop：原生控制台的 Wayland app_id 与 X11 WM_CLASS 都是 GTK 应用 id xyz.quetzal.console，桌面按文件名或 StartupWMClass 配图标。
  # 浏览器退路的窗口配不上，任务栏显示的是浏览器图标（已知限制）
  cat >"$apps/xyz.quetzal.console.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Quetzal
Comment=Open the Quetzal console
Comment[zh_CN]=打开 Quetzal 控制台
Exec=$(desk_q "$LAUNCHER")
Icon=$icon_name
Terminal=false
Categories=Network;Utility;
Keywords=agent;quetzal;
StartupNotify=true
StartupWMClass=xyz.quetzal.console
EOF
  have update-desktop-database && update-desktop-database "$apps" >>"$LOG" 2>&1 || true
  # 不在用户的图标目录生成缓存：那里没有 index.theme，gtk-update-icon-cache -t 生成的是空缓存，GTK 与 GNOME Shell 见到缓存就只信它，
  # 用户目录里所有应用的图标（包括 Quetzal 的）都找不到。以前的版本生成过，里面没有 Quetzal 的图标就删掉（缓存只是加速，没有它照样找得到）
  if [[ -f $icons/icon-theme.cache ]] && ! grep -q "$icon_name" "$icons/icon-theme.cache" 2>/dev/null; then rm -f "$icons/icon-theme.cache"; fi
  if [[ -n $NATIVE ]]; then ok "$(t '应用列表里有「Quetzal」了：点开就是原生控制台' 'Quetzal is in the app list: it opens the native console')"
  else ok "$(t '应用列表里有「Quetzal」了：点开在浏览器里打开控制台' 'Quetzal is in the app list: it opens the console in the browser')"; fi
}

# ---------------------------------------------------------------- 6. 收尾
open_console() {
  (( OPEN && HAS_SESSION )) || return 0
  local url; url="http://127.0.0.1:$(gateway_port_or_default)/"
  if [[ -n $LAUNCHER && -x $LAUNCHER ]]; then ( "$LAUNCHER" >/dev/null 2>&1 </dev/null & ) && ok "$(t "已打开控制台$( [[ -n $NATIVE ]] && t '（原生窗口）' ' (native window)' )" "Console opened$( [[ -n $NATIVE ]] && printf ' (native window)' )")"
  elif have xdg-open; then ( xdg-open "$url" >/dev/null 2>&1 </dev/null & ) && ok "$(t '已在浏览器里打开控制台' 'Console opened in the browser')"; fi
}
summary() {
  local port url v; port=$(gateway_port_or_default); url="http://127.0.0.1:$port/"; v=$(installed_version)
  printf '\n%s%s %s%s\n\n' "$AMBER" "$I_DONE" "$(t 'ta 住进来了。' 'It has moved in.')" "$R"
  # 标签后用制表符对齐：中文标签都是 3–4 个全角字（6–8 列），英文 7–11 列，都落在第 16 列
  printf '  %s\t%s%s%s  %s%s%s\n' "$(t '控制台' 'Console')" "$B" "$url" "$R" "$MUTE" "$(t '这台机器上的浏览器打开即登录' 'a browser on this machine is logged in on open')" "$R"
  (( HAS_SESSION )) || printf '  \t%s%s%s\n' "$MUTE" "$(t "没有桌面：在本机 ssh -L $port:127.0.0.1:$port <这台机器> 后打开同样的地址" "Headless: run ssh -L $port:127.0.0.1:$port <this machine> locally, then open the same address")" "$R"
  printf '  %s\t%s %s(%s %s)%s\n' "$(t '运行基座' 'Runtime')" "${v:-?}" "$MUTE" "$(t '家目录' 'home')" "$HOME_DIR" "$R"
  printf '  %s\t%s\n' "$(t '守护者' 'Supervision')" "$SERVICE_DESC"
  local lanport; lanport=$(sed -n 's/.*"lanPort"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HOME_DIR/config/quetzal.json" 2>/dev/null | head -n1); lanport=${lanport:-7789}
  (( LAN )) && printf '  %s\t%s\n' "$(t '局域网' 'Network')" "$(t "网关对局域网开放（加密）：https://<这台机器的地址>:$lanport。手机上的 App 填这台机器的地址并申请配对码，核对 App 显示的证书指纹与通知里的一致（quetzal status 也能看到）" "Gateway open to the LAN (encrypted): https://<this machine>:$lanport. In the phone app enter this machine's address, request a pairing code and check that the certificate fingerprint shown matches the notification (also shown by quetzal status)")"
  printf '\n  %squetzal status%s   %s%s%s\n' "$B" "$R" "$MUTE" "$(t '状态' 'status')" "$R"
  printf '  %squetzal logs -f%s  %s%s%s\n' "$B" "$R" "$MUTE" "$(t '日志' 'logs')" "$R"
  printf '  %squetzal open%s     %s%s%s\n' "$B" "$R" "$MUTE" "$(t '再次打开控制台' 'open the console again')" "$R"
  printf '  %s%s%s\n' "$MUTE" "$(t "升级：再跑一次同一条安装命令。卸载：curl -fsSL $SITE/install | bash -s -- --uninstall" "Upgrade: rerun the same install command. Uninstall: curl -fsSL $SITE/install | bash -s -- --uninstall")" "$R"
  printf '\n'
}

# ---------------------------------------------------------------- 卸载
uninstall() {
  hdr "$(t '卸载 Quetzal' 'Uninstalling Quetzal')"
  local did=0
  if have systemctl && [[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/quetzal.service" ]]; then
    systemctl --user disable --now quetzal >/dev/null 2>&1 || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/quetzal.service"; systemctl --user daemon-reload >/dev/null 2>&1 || true
    ok "$(t 'systemd 用户服务已移除' 'systemd user service removed')"; did=1
  fi
  local pid; pid=$(cat "$HOME_DIR/state/supervise.pid" 2>/dev/null || true)
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null || true; ok "$(t '守护循环已停止' 'Supervisor loop stopped')"; did=1; fi
  if have crontab && crontab -l 2>/dev/null | grep -q quetzal-supervise; then crontab -l 2>/dev/null | grep -v quetzal-supervise | crontab - 2>/dev/null || true; ok "$(t '已移除 crontab 的开机项' 'crontab @reboot entry removed')"; did=1; fi
  local f; for f in "$HOME/.config/autostart/quetzal-runtime.desktop" "${XDG_DATA_HOME:-$HOME/.local/share}/applications/quetzal.desktop" "${XDG_DATA_HOME:-$HOME/.local/share}/applications/xyz.quetzal.console.desktop" "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps/quetzal.png" "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/192x192/apps/quetzal.png" "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps/xyz.quetzal.console.png" "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/192x192/apps/xyz.quetzal.console.png" "$HOME/.local/bin/quetzal-console" "$HOME/.local/bin/quetzal" "$HOME/.config/fish/conf.d/quetzal.fish" "$HOME/.config/systemd/user/quetzal.service.d/quetzal-off.conf"; do
    [[ -e $f ]] && { rm -f "$f"; did=1; }
  done
  if [[ -e "$HOME_DIR/console/current" ]]; then ok "$(t '原生控制台已移除' 'Native console removed')"; did=1; fi
  if [[ -e $QZ_AA || -e $QZ_BWRAP ]] && need_root_runner; then # Quetzal 专用的 bwrap 副本与它的 AppArmor 配置（固定路径）
    local parser; parser=$(command -v apparmor_parser || echo /sbin/apparmor_parser)
    [[ -f $QZ_AA && -x $parser ]] && as_root "$parser" -R "$QZ_AA" >/dev/null 2>&1
    as_root unlink "$QZ_AA" >/dev/null 2>&1; as_root unlink "$QZ_BWRAP" >/dev/null 2>&1; as_root rmdir /usr/local/lib/quetzal >/dev/null 2>&1
    [[ -e $QZ_AA || -e $QZ_BWRAP ]] || { ok "$(t '已移除 Quetzal 专用的 bwrap 与 AppArmor 配置' 'Removed the Quetzal bwrap copy and AppArmor profile')"; did=1; }
  fi
  rm -rf "${HOME_DIR:?}/console"
  have update-desktop-database && update-desktop-database "${XDG_DATA_HOME:-$HOME/.local/share}/applications" >/dev/null 2>&1 || true
  if (( PURGE )); then [[ -e "$HOME_DIR/node/current" ]] && did=1; rm -rf "$HOME_DIR"; ok "$(t "已删除 $HOME_DIR（配置、记忆、对话都没有了；灵魂仓库里的内容仍在远端）" "Deleted $HOME_DIR (configuration, memories and conversations are gone; the soul repository remains remote)")"
  else rm -rf "${HOME_DIR:?}/npm" "${HOME_DIR:?}/bin" "$HOME_DIR/state/supervise.pid" "$HOME_DIR/state/supervise.lock" 2>/dev/null; ok "$(t "保留了 $HOME_DIR（配置、记忆、对话）；要一起删除加 --purge" "Kept $HOME_DIR (configuration, memories, conversations); add --purge to delete it too")"; fi
  note "$(t 'nvm、Node.js、git 不动。' 'nvm, Node.js and git are left in place.')"
  (( did || PURGE )) || note "$(t '没有发现已安装的内容。' 'Nothing installed was found.')"
  say ""
}

# ---------------------------------------------------------------- 主流程
main() {
  parse_args "$@"
  pick_lang; setup_term
  trap cleanup INT TERM
  [[ -n $HOME_DIR ]] || { HOME_DIR="$HOME/.quetzal"; DEFAULT_HOME=1; }
  case "$HOME_DIR" in /*) ;; *) HOME_DIR="$PWD/$HOME_DIR";; esac
  if [[ $MODE == uninstall ]]; then detect_machine; uninstall; exit 0; fi

  banner
  detect_machine
  migrate_legacy_home
  mkdir -p "$HOME_DIR" || die "$(t "建不了家目录 $HOME_DIR" "Cannot create $HOME_DIR")"
  LOG="$HOME_DIR/install.log"; { printf '\n== %s install.sh\n' "$(date 2>/dev/null)"; } >>"$LOG" 2>/dev/null || { LOG=$(mktemp "${TMPDIR:-/tmp}/quetzal-install.XXXXXX" 2>/dev/null) || LOG=/dev/null; }

  hdr "$(t '这台机器' 'This machine')"
  describe_machine

  hdr "$(t '依赖' 'Dependencies')"
  ensure_tools
  ensure_sandbox
  ensure_node

  hdr "$(t '运行基座' 'Runtime')"
  install_runtime

  ensure_landlock

  hdr "$(t '守护' 'Supervision')"
  ensure_service

  if (( HAS_DESKTOP && DESKTOP )); then hdr "$(t '桌面' 'Desktop')"; install_desktop; fi

  open_console
  summary
}

main "$@"
