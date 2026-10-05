#!/data/data/com.termux/files/usr/bin/bash
# Quetzal 安装脚本：由控制台 App 通过 Termux 的 RUN_COMMAND 下发并在 Termux 里执行；进度与结果回报给控制台的本机 HTTP 服务。
# 用法：install.sh <控制台端口> [cn]      cn = 使用中国大陆的软件源镜像
# 幂等：可重复执行用于升级或修复。新版本放进 ~/quetzal/releases/<版本>/，切换后健康检查失败自动切回上一版。
set -u
PORT=${1:?用法: install.sh <控制台端口> [cn]}; MIRROR=${2:-}
BASE="http://127.0.0.1:$PORT"
W=$HOME/quetzal; R=$W/releases; SV=$PREFIX/var/service/quetzal; LOG=$W/install.log
export DEBIAN_FRONTEND=noninteractive
mkdir -p "$W" "$R"
echo "== $(date) 安装开始（端口 $PORT，镜像 ${MIRROR:-默认}）" >>"$LOG"

report() { curl -s -m 5 -X POST "$BASE/progress" -H 'Content-Type: application/json' --data-binary "$1" >/dev/null 2>&1 || true; }
step() { echo "## $1" >>"$LOG"; report "{\"step\":\"$1\"}"; }
esc() { sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "%s\\n", $0}'; }
fail() { echo "!! $1" >>"$LOG"; report "{\"error\":\"$(printf '%s' "$1" | esc)\",\"log\":\"$(tail -n 20 "$LOG" | esc)\"}"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 1. 软件包：Node.js、runit（termux-services）、Termux:API 命令、git、ssh-keygen
step pkg
if ! { have node && have runsvdir && have termux-battery-status && have git && have ssh-keygen; }; then
  if [ "$MIRROR" = cn ] && [ -d "$PREFIX/etc/termux/mirrors/chinese_mainland" ]; then
    ln -sfn "$PREFIX/etc/termux/mirrors/chinese_mainland" "$PREFIX/etc/termux/chosen_mirrors"   # 与 termux-change-repo 的做法一致
  fi
  { yes | pkg update -y -o Dpkg::Options::=--force-confnew; } >>"$LOG" 2>&1 || fail "更新软件源失败（网络不通，或软件源不可用）"
  pkg install -y -o Dpkg::Options::=--force-confnew nodejs-lts termux-services termux-api git openssh >>"$LOG" 2>&1 || fail "安装软件包失败"
fi
have node || fail "Node.js 没有装上"
echo "node $(node -v)" >>"$LOG"

# ---------- 2. 运行基座：从控制台取回本 App 内置的版本
step runtime
V=$(curl -fsS "$BASE/runtime/VERSION") || fail "取不到运行基座版本（控制台是否还在前台？）"
V=$(printf '%s' "$V" | tr -cd 'A-Za-z0-9.-'); [ -n "$V" ] || fail "运行基座版本号为空"
mkdir -p "$R/$V"
for f in main.cjs termux.mjs; do
  curl -fsS "$BASE/runtime/$f" -o "$R/$V/$f.part" && mv "$R/$V/$f.part" "$R/$V/$f" || fail "下载 $f 失败"
done
[ "$(stat -c %s "$R/$V/main.cjs")" -gt 100000 ] || fail "运行基座文件不完整"
node -e "require('fs').readFileSync('$R/$V/main.cjs')" || fail "运行基座文件不可读"

# ---------- 2b. 网状层的原生组件（node-datachannel）：按锁定文件的版本与 sha512 下载并核对，装进 ~/quetzal/mesh-modules/<版本>/（各版本共用，升级不重复下载）。
#      失败不影响安装：只是暂时没有网状层，身体之间仍用 git 同步；下次安装再试。
step mesh
MM_OK=
if curl -fsS "$BASE/runtime/mesh-modules.lock.json" -o "$R/$V/mesh-modules.lock.json" && curl -fsS "$BASE/runtime/install-mesh-modules.mjs" -o "$R/$V/install-mesh-modules.mjs"; then
  NDC_V=$(node -p "require('$R/$V/mesh-modules.lock.json').common['node-datachannel'].version" 2>/dev/null)
  MM="$W/mesh-modules/$NDC_V"
  if [ -n "$NDC_V" ] && [ ! -f "$MM/node_modules/node-datachannel/package.json" ]; then
    mkdir -p "$MM"
    if [ "$MIRROR" = cn ]; then REGS="https://registry.npmmirror.com https://registry.npmjs.org"; else REGS="https://registry.npmjs.org https://registry.npmmirror.com"; fi
    # shellcheck disable=SC2086
    node "$R/$V/install-mesh-modules.mjs" "$R/$V/mesh-modules.lock.json" "$MM" android-arm64 $REGS >>"$LOG" 2>&1 || echo "!! 网状层组件没有装上（不影响使用，下次安装再试）" >>"$LOG"
  fi
  [ -f "$MM/node_modules/node-datachannel/package.json" ] && ln -sfn "../../mesh-modules/$NDC_V/node_modules" "$R/$V/node_modules" && MM_OK=1   # 相对链接：家目录整体搬迁也不断
  ( cd "$W/mesh-modules" 2>/dev/null && ls -1t | tail -n +3 | xargs -r rm -rf )   # 只保留最近 2 个版本的组件
fi
echo "网状层组件：${MM_OK:+已就绪}${MM_OK:-缺失}" >>"$LOG"

# ---------- 3. 服务：runit 守护、日志轮转、开机脚本、允许控制台点火
step service
mkdir -p "$SV/log" "$PREFIX/var/log/sv/quetzal" "$HOME/.termux/boot"
cat >"$SV/run" <<'RUN'
#!/data/data/com.termux/files/usr/bin/sh
# runit 服务：Quetzal 运行基座。退出即被 runit 重新拉起；熔断逻辑在运行基座内。
exec 2>&1
cd "$HOME/quetzal/current" || exit 1
export QUETZAL_ADAPTER="$HOME/quetzal/current/termux.mjs"
exec node --enable-source-maps main.cjs
RUN
cat >"$SV/log/run" <<'RUN'
#!/data/data/com.termux/files/usr/bin/sh
exec svlogd -tt "$PREFIX/var/log/sv/quetzal"
RUN
cat >"$HOME/.termux/boot/quetzal" <<'RUN'
#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot 开机脚本：保持 CPU 唤醒，启动 runit（quetzal 由其守护）
termux-wake-lock
. $PREFIX/etc/profile.d/start-services.sh
RUN
chmod 700 "$SV/run" "$SV/log/run" "$HOME/.termux/boot/quetzal"
grep -qs '^allow-external-apps *= *true' "$HOME/.termux/termux.properties" || { mkdir -p "$HOME/.termux"; echo 'allow-external-apps=true' >>"$HOME/.termux/termux.properties"; }

# ---------- 4. 设备配置：身体名字（机型，公开的非唯一信息）与时区；只在还没有配置时写入，其余配置由控制台管理
step config
MODEL=$(getprop ro.product.model 2>/dev/null | tr -c 'A-Za-z0-9-' '-' | sed -e 's/^-*//' -e 's/-*$//' | cut -c1-32)
TZ_SYS=$(getprop persist.sys.timezone 2>/dev/null)
mkdir -p "$W/config"
MODEL="$MODEL" TZ_SYS="$TZ_SYS" node -e '
const fs=require("fs"),f=process.env.HOME+"/quetzal/config/quetzal.json";let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
if(!c.body||c.body==="default")c.body=(process.env.MODEL||"android").toLowerCase();
if(!c.timezone&&process.env.TZ_SYS)c.timezone=process.env.TZ_SYS;
fs.writeFileSync(f,JSON.stringify(c,null,2));console.log("body",c.body,"timezone",c.timezone||"(系统)")' >>"$LOG" 2>&1 || fail "写入配置失败"
GW=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/quetzal/config/quetzal.json","utf8")).gateway.port||7788)}catch{console.log(7788)}')

# ---------- 5. 切换版本并启动
step start
CUR=$(readlink "$W/current" 2>/dev/null || true)
[ -n "$CUR" ] && [ "$CUR" != "$R/$V" ] && ln -sfn "$CUR" "$W/previous"
ln -sfn "$R/$V" "$W/current"
termux-wake-lock 2>/dev/null || true
. "$PREFIX/etc/profile.d/start-services.sh" >>"$LOG" 2>&1 || true   # 启动 runsvdir（已在运行则无事）
rm -f "$SV/down"
for i in $(seq 1 20); do sv status "$SV" >/dev/null 2>&1 && break; sleep 1; done   # 等 runsvdir 发现新服务
sv restart "$SV" >>"$LOG" 2>&1 || sv up "$SV" >>"$LOG" 2>&1 || fail "启动服务失败（runit 没有运行？）"

# ---------- 6. 健康检查；失败就切回上一版
step health
ok=
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$GW/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
if [ -z "$ok" ]; then
  tail -n 30 "$PREFIX/var/log/sv/quetzal/current" >>"$LOG" 2>/dev/null
  if [ -n "$CUR" ] && [ -d "$CUR" ]; then ln -sfn "$CUR" "$W/current"; sv restart "$SV" >/dev/null 2>&1; fail "新版本 40 秒内没有响应，已切回上一版"; fi
  fail "运行基座 40 秒内没有响应（日志在 $PREFIX/var/log/sv/quetzal/current）"
fi
TOKEN=$(cat "$W/secrets/gateway.token" 2>/dev/null) || fail "读不到网关令牌"
( cd "$R" && ls -1t | tail -n +4 | xargs -r rm -rf )   # 只保留最近 3 个版本
echo "== 完成：$V" >>"$LOG"
report "{\"done\":true,\"version\":\"$V\",\"port\":$GW,\"token\":\"$TOKEN\"}"
