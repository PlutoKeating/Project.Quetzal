#!/usr/bin/env bash
# Quetzal 同步服务：一行启动。
#
#   ./start.sh            启动或更新配置后重启（第一次运行会引导填写 .env）
#   ./start.sh status     查看状态
#   ./start.sh logs [服务] 跟踪日志（sync / caddy / coturn）
#   ./start.sh restart    重启
#   ./start.sh update     拉取仓库最新代码并重建
#   ./start.sh stop       停止（数据保留）
#
# 依赖只有 Docker 与 Docker Compose 插件（≥ 2.23.1）；没有时询问后用 Docker 官方脚本安装。
# 幂等：重复运行只会补齐缺的部分。数据都在本目录的 data/ 里（不入库）。
# 对外方式（.env 的 SYNC_FRONT）：caddy（默认，本机 80 / 443）或 tunnel（交给已有的反向隧道，见 compose.tunnel.yaml）。
set -euo pipefail
umask 077 # 新建的文件（.env、临时文件、data/）只有自己能读写；git pull 与安装 Docker 时临时放宽（见下）
cd "$(dirname "$(readlink -f "$0")")"
TMPFILES=()
cleanup() { if [[ ${#TMPFILES[@]} -gt 0 ]]; then rm -f "${TMPFILES[@]}"; fi; }
trap cleanup EXIT

# ---------- 界面
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh*|*_CN*|*_TW*|*_HK*) ZH=1 ;; *) ZH=0 ;; esac
t() { if [[ $ZH == 1 ]]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
if [[ -t 1 ]]; then B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'; A=$'\e[38;5;215m'; G=$'\e[32m'; Y=$'\e[33m'; E=$'\e[31m'; else B='' D='' R='' A='' G='' Y='' E=''; fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s●%s %s\n' "$A" "$R" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$R" "$*"; }
die()  { printf '%s✗ %s%s\n' "$E" "$*" "$R" >&2; exit 1; }
TTY=0; if [[ -r /dev/tty && -w /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then TTY=1; fi
ask() { # ask <提示> <默认> → 读一行（没有终端时返回默认值）
  local reply=""
  if [[ $TTY == 1 ]]; then printf '  %s%s%s ' "$B" "$1" "$R" >/dev/tty; IFS= read -r reply </dev/tty || true; fi
  printf '%s' "${reply:-$2}"
}
ask_secret() { # ask_secret <提示> → 读一行，不回显（没有终端时返回空）
  local reply=""
  if [[ $TTY == 1 ]]; then printf '  %s%s%s ' "$B" "$1" "$R" >/dev/tty; IFS= read -rs reply </dev/tty || true; printf '\n' >/dev/tty; fi
  printf '%s' "$reply"
}
have() { command -v "$1" >/dev/null 2>&1; }

[[ $(uname -s) == Linux ]] || die "$(t '同步服务只支持 Linux 服务器' 'The sync service runs on Linux servers only')"

# ---------- Docker
SUDO=()
docker_ready() { "${SUDO[@]}" docker info >/dev/null 2>&1; }
compose_ok() { # Compose 插件 ≥ 2.23.1（compose.yaml 用到 configs.content）
  local v; v=$("${SUDO[@]}" docker compose version --short 2>/dev/null) || return 1
  v=${v#v}; local IFS=.; read -r ma mi pa <<<"${v%%-*}"
  (( ma > 2 || (ma == 2 && (mi > 23 || (mi == 23 && ${pa:-0} >= 1))) ))
}
ensure_docker() {
  if have docker; then
    if ! docker_ready; then
      if [[ $EUID -ne 0 ]] && have sudo && sudo docker info >/dev/null 2>&1; then SUDO=(sudo); fi
      docker_ready || die "$(t 'Docker 已安装但没有运行，或当前用户没有权限。试试：sudo systemctl enable --now docker' 'Docker is installed but not running or not accessible. Try: sudo systemctl enable --now docker')"
    fi
    compose_ok || die "$(t '需要 Docker Compose 插件 2.23.1 以上（docker compose version）。请升级 Docker。' 'Docker Compose plugin 2.23.1+ is required (docker compose version). Please upgrade Docker.')"
    return
  fi
  step "$(t '没有找到 Docker' 'Docker not found')"
  [[ $TTY == 1 ]] || die "$(t '请先安装 Docker（https://docs.docker.com/engine/install/）再运行。' 'Install Docker first (https://docs.docker.com/engine/install/), then rerun.')"
  local yn; yn=$(ask "$(t '用 Docker 官方脚本（get.docker.com）安装？[Y/n]' 'Install it with the official script (get.docker.com)? [Y/n]')" y)
  [[ $yn =~ ^[Yy] ]] || die "$(t '已取消。' 'Cancelled.')"
  [[ $EUID -eq 0 ]] || have sudo || die "$(t '安装 Docker 需要 root 或 sudo。' 'Installing Docker needs root or sudo.')"
  local root=(); [[ $EUID -eq 0 ]] || root=(sudo)
  local script; script=$(mktemp); TMPFILES+=("$script")
  local mirror=()
  if ! curl -fsSL --max-time 20 https://get.docker.com -o "$script"; then die "$(t '下载 get.docker.com 失败，请检查网络。' 'Could not download get.docker.com.')"; fi
  curl -fsS --max-time 8 -o /dev/null https://download.docker.com 2>/dev/null || mirror=(--mirror Aliyun)
  (umask 022; "${root[@]}" sh "$script" "${mirror[@]}") # 安装脚本写的 apt 源与密钥要让 apt 读得到
  "${root[@]}" systemctl enable --now docker >/dev/null 2>&1 || true
  [[ $EUID -eq 0 ]] || SUDO=(sudo)
  docker_ready || die "$(t 'Docker 安装后仍然无法使用。' 'Docker is still unusable after installation.')"
  compose_ok || die "$(t 'Docker Compose 插件版本过低。' 'The Docker Compose plugin is too old.')"
  ok "$(t 'Docker 已安装' 'Docker installed')"
}
dc() { "${SUDO[@]}" docker compose "$@"; }

# ---------- .env
envget() { sed -n "s/^$1=//p" .env | tail -1; }
envset() { # 原地改一行。值里可能有 / 与 &，用 awk 而不是 sed；经环境变量传值（awk -v 会处理反斜杠转义）。
  local k=$1 v=$2 tmp
  if grep -q "^$k=" .env; then
    tmp=$(mktemp .env.XXXXXX); TMPFILES+=("$tmp") # 同一目录、权限 600，退出时清理
    K=$k V=$v awk 'BEGIN{FS=OFS="="} $1==ENVIRON["K"]{$0=ENVIRON["K"]"="ENVIRON["V"]} {print}' .env >"$tmp"
    chmod 600 "$tmp"; mv -f "$tmp" .env
  else printf '%s=%s\n' "$k" "$v" >>.env; fi
}
random_secret() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48; }
public_ip() { curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true; }
is_private4() { [[ $1 =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; }

# TURN 的中转地址：主网卡（默认路由出口）的 IPv4。coturn 不指定时会把 Docker 网桥等所有网卡地址都当作中转地址，对外宣告的地址却收不到数据。
# 主网卡上是内网地址（云服务器常见的 1:1 NAT）时，external-ip 写成 公网/内网 的映射。
detect_turn_addresses() {
  local relay pub
  if [[ -n $(envget TURN_RELAY_IP) ]]; then ok "$(t "TURN 中转地址沿用 .env 里的设置（清空 TURN_RELAY_IP 可重新探测）" "TURN relay address kept from .env (clear TURN_RELAY_IP to re-detect)")"; return; fi
  relay=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  [[ -n $relay ]] || relay=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -n $relay ]] || die "$(t '探测不到本机的 IPv4 地址（TURN 中转需要）。请在 .env 里手动填写 TURN_RELAY_IP。' 'Could not detect this server'"'"'s IPv4 address (needed for TURN). Set TURN_RELAY_IP in .env.')"
  envset TURN_RELAY_IP "$relay"
  if is_private4 "$relay"; then
    pub=$(public_ip)
    if [[ -n $pub ]]; then envset TURN_EXTERNAL_IP "$pub/$relay"; ok "$(t 'TURN 中转地址：内网网卡，已映射到公网地址' 'TURN relay: private interface mapped to the public address')"
    else warn "$(t '主网卡是内网地址，但探测不到公网地址：请在 .env 里填写 TURN_EXTERNAL_IP=<公网>/<内网>。' 'The primary interface is private and the public address could not be detected; set TURN_EXTERNAL_IP=<public>/<private> in .env.')"; fi
  else
    envset TURN_EXTERNAL_IP ""; ok "$(t 'TURN 中转地址：公网网卡' 'TURN relay: public interface')"
  fi
}

# coturn 禁止中转到本机的公网地址（TURN_PUBLIC_IP，由 TURN_EXTERNAL_IP 的公网部分推出；中转地址本身是公网时就是它，已单独禁止）
turn_public_ip() {
  local ext pub; ext=$(envget TURN_EXTERNAL_IP); pub=${ext%%/*}
  if [[ -n $pub && ! $pub =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then warn "$(t "TURN_EXTERNAL_IP 的公网部分不是 IPv4：$pub" "The public part of TURN_EXTERNAL_IP is not an IPv4 address: $pub")"; pub=""; fi
  envset TURN_PUBLIC_IP "$pub"
}

# TURN 配额与带宽：都是整数；总配额不能超过中转端口段的端口数（一个分配占一个端口）
check_turn_limits() {
  local k v lo hi total
  for k in TURN_MIN_PORT TURN_MAX_PORT TURN_USER_QUOTA TURN_TOTAL_QUOTA TURN_MAX_BPS TURN_BPS_CAPACITY; do
    v=$(envget "$k"); [[ -z $v || $v =~ ^[0-9]+$ ]] || die "$(t "$k 必须是整数：$v" "$k must be an integer: $v")"
  done
  lo=$(envget TURN_MIN_PORT); hi=$(envget TURN_MAX_PORT); total=$(envget TURN_TOTAL_QUOTA); lo=${lo:-49160}; hi=${hi:-49250}; total=${total:-90}
  (( lo >= 1024 && hi <= 65535 && hi > lo )) || die "$(t "TURN 中转端口段不合法：$lo-$hi" "Invalid TURN relay port range: $lo-$hi")"
  if (( total > hi - lo + 1 )); then envset TURN_TOTAL_QUOTA "$((hi - lo + 1))"; warn "$(t "TURN_TOTAL_QUOTA 超过了中转端口数，已改为 $((hi - lo + 1))" "TURN_TOTAL_QUOTA exceeded the relay port count; set to $((hi - lo + 1))")"; fi
}

# 镜像：.env 里仍是官方地址的同一个 tag（不带摘要，或带旧摘要）时，跟到 .env.example 里当前固定的摘要；换成镜像源的不动
follow_image_pins() {
  local k cur def
  for k in NODE_IMAGE CADDY_IMAGE COTURN_IMAGE; do
    def=$(sed -n "s/^$k=//p" .env.example | tail -1); cur=$(envget "$k")
    [[ -n $def && $cur != "$def" ]] || continue
    if [[ -z $cur || ${cur%%@*} == "${def%%@*}" ]]; then envset "$k" "$def"; ok "$(t "$k 已固定到 ${def#*@}" "$k pinned to ${def#*@}")"; fi
  done
}

configure() {
  if [[ ! -f .env ]]; then (umask 077; cp .env.example .env); ok "$(t '已创建 .env（权限 600）' 'Created .env (mode 600)')"; fi
  chmod 600 .env
  if [[ -z $(envget TURN_SECRET) ]]; then envset TURN_SECRET "$(random_secret)"; ok "$(t '已生成 TURN_SECRET' 'Generated TURN_SECRET')"; fi
  follow_image_pins

  local domain; domain=$(envget SYNC_DOMAIN)
  if [[ -z $domain ]]; then
    say "  $(t '这台服务器的域名（DNS 记录要指向本机，用来申请 HTTPS 证书）：' 'Domain name of this server (its DNS record must point here; used for the HTTPS certificate):')"
    domain=$(ask "$(t '域名' 'Domain')" "")
    [[ -n $domain ]] || die "$(t '需要域名。也可以直接编辑 .env 填写 SYNC_DOMAIN。' 'A domain is required. You can also edit SYNC_DOMAIN in .env.')"
    domain=${domain#https://}; domain=${domain#http://}; domain=${domain%%/*}
    envset SYNC_DOMAIN "$domain"
  fi
  [[ $domain =~ ^[A-Za-z0-9.-]+$ ]] || die "$(t "SYNC_DOMAIN 不是合法的域名：$domain" "SYNC_DOMAIN is not a valid domain: $domain")"
  ok "$(t '域名' 'Domain') ${B}$domain${R}"

  # 对外方式：写好 COMPOSE_FILE / COMPOSE_PROFILES，之后手动运行 docker compose 也是同一套服务
  FRONT=$(envget SYNC_FRONT); FRONT=${FRONT:-caddy}
  [[ $FRONT == caddy || $FRONT == tunnel ]] || die "$(t "SYNC_FRONT 只能是 caddy 或 tunnel：$FRONT" "SYNC_FRONT must be caddy or tunnel: $FRONT")"
  envset SYNC_FRONT "$FRONT"
  LOCAL_PORT=$(envget SYNC_LOCAL_PORT); LOCAL_PORT=${LOCAL_PORT:-8788}
  [[ $LOCAL_PORT =~ ^[0-9]+$ ]] && (( LOCAL_PORT > 0 && LOCAL_PORT < 65536 )) || die "$(t "SYNC_LOCAL_PORT 不是合法的端口：$LOCAL_PORT" "SYNC_LOCAL_PORT is not a valid port: $LOCAL_PORT")"
  if [[ $FRONT == tunnel ]]; then
    envset COMPOSE_FILE "compose.yaml:compose.tunnel.yaml"; envset COMPOSE_PROFILES ""
    ok "$(t "对外方式：隧道（同步服务只监听 127.0.0.1:$LOCAL_PORT，不用 80 / 443）" "Front: tunnel (the sync service listens on 127.0.0.1:$LOCAL_PORT only; ports 80/443 unused)")"
  else
    envset COMPOSE_FILE "compose.yaml"; envset COMPOSE_PROFILES "caddy"
    ok "$(t '对外方式：Caddy（本机 80 / 443，自动 HTTPS）' 'Front: Caddy (ports 80/443 on this server, automatic HTTPS)')"
  fi

  # STUN / TURN 的主机名：隧道模式下必须单独指定一个直连本机的（隧道只转发 HTTP）
  local turn_host; turn_host=$(envget TURN_HOST)
  if [[ $FRONT == tunnel && -z $turn_host ]]; then
    say "  $(t 'STUN / TURN 不经隧道，需要一个直连本机的主机名（DNS 记录指向本机、不开代理），也可以直接用公网 IP：' 'STUN / TURN do not go through the tunnel; give a host name that points straight at this server (DNS only, no proxy), or the public IP:')"
    turn_host=$(ask "TURN_HOST" "$(public_ip)")
    [[ -n $turn_host ]] || die "$(t '隧道模式需要 TURN_HOST。' 'Tunnel mode needs TURN_HOST.')"
    envset TURN_HOST "$turn_host"
  fi
  [[ -z $turn_host || $turn_host =~ ^[A-Za-z0-9.:-]+$ ]] || die "$(t "TURN_HOST 不合法：$turn_host" "TURN_HOST is invalid: $turn_host")"
  TURN_NAME=${turn_host:-$domain}
  if [[ -n $turn_host && ! $turn_host =~ ^[0-9.:]+$ ]] && have getent; then
    local tr ip; tr=$(getent ahostsv4 "$turn_host" 2>/dev/null | awk 'NR==1{print $1}' || true); ip=$(public_ip)
    if [[ -z $tr ]]; then warn "$(t "$turn_host 还没有解析记录：加一条 A 记录指向本机（不开代理）。" "$turn_host does not resolve yet: add an A record pointing here (no proxy).")"
    elif [[ -n $ip && $tr != "$ip" ]]; then warn "$(t "$turn_host 解析到的不是本机的公网地址（开了 CDN 代理？STUN / TURN 必须直连）。" "$turn_host does not resolve to this server's public IP (CDN proxy on? STUN / TURN must connect directly).")"; fi
  fi

  # DNS 指向检查（只提醒，不阻止：可能用了 CDN 或 IPv6）；隧道模式下域名本来就指向隧道
  if [[ $FRONT == caddy && $domain != localhost ]] && have getent; then
    local resolved ip; resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR==1{print $1}' || true); ip=$(public_ip)
    if [[ -z $resolved ]]; then warn "$(t "$domain 还没有解析记录：证书会申请失败。先在 DNS 里加一条 A 记录指向本机。" "$domain does not resolve yet; the certificate request will fail. Add an A record pointing here.")"
    elif [[ -n $ip && $resolved != "$ip" ]]; then warn "$(t "$domain 解析到的地址与本机的公网地址不同（如果用了 CDN，请对这个域名关闭代理：TURN 与 WebSocket 需要直连）。" "$domain resolves to a different address than this server's public IP (if it is behind a CDN proxy, disable proxying for it: TURN and WebSockets need a direct connection).")"; fi
  fi

  if [[ -z $(envget GITHUB_CLIENT_ID) || -z $(envget GITHUB_CLIENT_SECRET) ]]; then
    say ""
    say "  $(t 'GitHub 登录：在 https://github.com/settings/applications/new 创建一个 OAuth App，填写：' 'GitHub sign-in: create an OAuth App at https://github.com/settings/applications/new with:')"
    say "    Homepage URL                ${B}https://$domain${R}"
    say "    Authorization callback URL  ${B}https://$domain/auth/github/callback${R}"
    local id secret
    id=$(ask "Client ID $(t '（直接回车跳过，之后可以再运行一次填写）' '(Enter to skip; rerun later to fill in)')" "")
    if [[ -n $id ]]; then
      secret=$(ask_secret "Client secret $(t '（输入时不显示）' '(input hidden)')")
      [[ -n $secret ]] && { envset GITHUB_CLIENT_ID "$id"; envset GITHUB_CLIENT_SECRET "$secret"; ok "$(t '已保存 GitHub 登录配置' 'Saved GitHub sign-in settings')"; }
    fi
    [[ -n $(envget GITHUB_CLIENT_ID) ]] || warn "$(t '没有配置 GitHub 登录：网页无法登录，身体无法绑定。' 'GitHub sign-in is not configured: nobody can sign in or bind bodies.')"
  fi
}

# ---------- 防火墙（只处理本机的 ufw / firewalld；云服务器的安全组要在控制台放行）
open_firewall() {
  local lo hi; lo=$(envget TURN_MIN_PORT); hi=$(envget TURN_MAX_PORT); lo=${lo:-49160}; hi=${hi:-49250}
  local root=(); [[ $EUID -eq 0 ]] || { have sudo || return 0; root=(sudo -n); }
  local web=(80/tcp 443/tcp 443/udp); [[ $FRONT == tunnel ]] && web=()
  if have ufw && "${root[@]}" ufw status 2>/dev/null | grep -q "Status: active"; then
    for r in "${web[@]}" 3478/tcp 3478/udp "$lo:$hi/udp"; do "${root[@]}" ufw allow "$r" >/dev/null 2>&1 || true; done
    ok "$(t 'ufw 已放行所需端口' 'ufw: required ports opened')"
  elif have firewall-cmd && "${root[@]}" firewall-cmd --state >/dev/null 2>&1; then
    for r in "${web[@]}" 3478/tcp 3478/udp "$lo-$hi/udp"; do "${root[@]}" firewall-cmd --permanent --add-port="$r" >/dev/null 2>&1 || true; done
    "${root[@]}" firewall-cmd --reload >/dev/null 2>&1 || true
    ok "$(t 'firewalld 已放行所需端口' 'firewalld: required ports opened')"
  fi
  if [[ $FRONT == tunnel ]]; then PORTS_NOTE="UDP 3478, $lo-$hi · TCP 3478"; else PORTS_NOTE="TCP 80, 443 · UDP 443, 3478, $lo-$hi · TCP 3478"; fi
}

ports_busy() { # 需要的端口被别的程序占用时提醒（caddy 模式 80 / 443 / 3478；隧道模式 3478 与本机端口）
  have ss || return 0
  local want='80|443|3478'; [[ $FRONT == tunnel ]] && want="3478|$LOCAL_PORT"
  local busy; busy=$(ss -Hltnup 2>/dev/null | awk '{print $5}' | grep -E "[:.]($want)\$" || true)
  [[ -z $busy ]] && return 0
  [[ -n $(dc ps --quiet 2>/dev/null || true) ]] && return 0 # 是我们自己的容器（不用 grep -q：pipefail 下它提前退出会让管道算失败）
  warn "$(t "这些端口已被占用：$(echo "$busy" | tr '\n' ' ')。同步服务需要它们（${want//|/、}）。" "These ports are in use: $(echo "$busy" | tr '\n' ' '). The sync service needs them (${want//|/, }).")"
}

prepare_data() {
  mkdir -p data/sync data/caddy data/caddy-config
  chmod 700 data
  # 容器丢弃了全部 capability（包括越权读写文件），所以数据目录的属主必须与容器里的用户一致：
  # 同步服务以 node 用户（uid 1000）运行；Caddy 以 root 运行。用一次性的普通容器改属主（宿主机上不需要 root）。
  local dir owner
  for pair in "data/sync:1000:1000" "data/caddy:0:0" "data/caddy-config:0:0"; do
    dir=${pair%%:*}; owner=${pair#*:}
    "${SUDO[@]}" docker run --rm --user 0 --network none -v "$PWD/$dir:/d" --entrypoint chown quetzal-sync:local -R "$owner" /d
    "${SUDO[@]}" docker run --rm --user 0 --network none -v "$PWD/$dir:/d" --entrypoint chmod quetzal-sync:local 700 /d
  done
}

wait_healthy() {
  local st="" domain; domain=$(envget SYNC_DOMAIN)
  for _ in $(seq 1 60); do
    st=$("${SUDO[@]}" docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q sync)" 2>/dev/null || true)
    [[ $st == healthy ]] && break
    sleep 2
  done
  [[ $st == healthy ]] || { dc logs --tail 30 sync; die "$(t '同步服务没有在 2 分钟内就绪，见上面的日志。' 'The sync service did not become healthy within 2 minutes; see the logs above.')"; }
  ok "$(t '同步服务就绪' 'Sync service healthy')"
  [[ $domain == localhost ]] && return 0
  if [[ $FRONT == tunnel ]]; then
    curl -fsS --max-time 5 "http://127.0.0.1:$LOCAL_PORT/v1/health" >/dev/null 2>&1 && ok "$(t "本机端口可用：http://127.0.0.1:$LOCAL_PORT" "Local port is up: http://127.0.0.1:$LOCAL_PORT")" || warn "$(t "本机端口 127.0.0.1:$LOCAL_PORT 连不上" "Local port 127.0.0.1:$LOCAL_PORT is unreachable")"
    if curl -fsS --max-time 8 "https://$domain/v1/health" >/dev/null 2>&1; then ok "$(t "HTTPS 可用：https://$domain" "HTTPS is up: https://$domain")"
    else warn "$(t "还连不上 https://$domain ：在隧道里加一条 public hostname，$domain → http://localhost:$LOCAL_PORT。" "https://$domain is not reachable yet: add a public hostname to your tunnel, $domain → http://localhost:$LOCAL_PORT.")"; fi
    return 0
  fi
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 5 "https://$domain/v1/health" >/dev/null 2>&1; then ok "$(t "HTTPS 可用：https://$domain" "HTTPS is up: https://$domain")"; return 0; fi
    sleep 2
  done
  warn "$(t "还连不上 https://$domain （证书可能还在申请，或 80 / 443 端口没有放行）。稍后用 ./start.sh status 再看；证书问题见 ./start.sh logs caddy。" "https://$domain is not reachable yet (the certificate may still be pending, or ports 80/443 are blocked). Check ./start.sh status later; see ./start.sh logs caddy for certificate issues.")"
}

up() {
  printf '\n%s●%s %sQuetzal Sync%s %s\n\n' "$A" "$R" "$B" "$R" "$D$(t '同步服务' 'sync service')$R"
  step "$(t '检查 Docker' 'Checking Docker')"; ensure_docker; ok "Docker $("${SUDO[@]}" docker version -f '{{.Server.Version}}') · Compose $("${SUDO[@]}" docker compose version --short)"
  step "$(t '配置' 'Configuration')"; configure
  detect_turn_addresses; turn_public_ip; check_turn_limits
  step "$(t '端口与防火墙' 'Ports and firewall')"; ports_busy; open_firewall
  step "$(t '构建并启动（第一次需要下载镜像，可能要几分钟）' 'Building and starting (the first run downloads images; this can take a few minutes)')"
  dc build --pull sync
  prepare_data
  if [[ $FRONT == tunnel ]]; then
    dc rm -sf caddy >/dev/null 2>&1 || true # 从 caddy 模式换过来时停掉它，让出 80 / 443
    dc up -d --remove-orphans --force-recreate coturn sync # coturn 的配置内联在 compose 里，改了 .env 必须重建才生效
  else
    dc up -d --remove-orphans --force-recreate coturn caddy sync
  fi
  wait_healthy
  local domain; domain=$(envget SYNC_DOMAIN)
  say ""
  say "  ${B}https://$domain${R}  $(t '账户与绑定' 'accounts and binding')"
  say "  ${B}turn:$TURN_NAME:3478${R}  STUN / TURN"
  say "  $(t '云服务器请在安全组里放行：' 'On a cloud server, allow in the security group:') $PORTS_NOTE"
  say "  $(t "在身体的控制台里把同步服务地址设为 https://$domain 即可绑定。" "Set the sync server to https://$domain in each body's console to bind it.")"
  say ""
}

case "${1:-up}" in
  up|start) up ;;
  status)
    ensure_docker; dc ps; domain=$(envget SYNC_DOMAIN)
    if [[ $(envget SYNC_FRONT) == tunnel ]]; then p=$(envget SYNC_LOCAL_PORT); curl -fsS --max-time 5 "http://127.0.0.1:${p:-8788}/v1/health" && echo || warn "127.0.0.1:${p:-8788} $(t '不可达' 'unreachable')"; fi
    if curl -fsS --max-time 5 "https://$domain/v1/health"; then echo; else warn "https://$domain/v1/health $(t '不可达' 'unreachable')"; fi ;;
  logs) ensure_docker; shift || true; dc logs -f --tail 100 "$@" ;;
  restart) ensure_docker; dc restart ;;
  update) ensure_docker; (umask 022; git pull --ff-only); up ;; # 拉下来的源码要让镜像里的 node 用户读得到
  stop|down) ensure_docker; dc down ;;
  -h|--help|help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "$(t "未知命令：$1（./start.sh help 查看用法）" "Unknown command: $1 (see ./start.sh help)")" ;;
esac
