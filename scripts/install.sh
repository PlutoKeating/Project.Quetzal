#!/usr/bin/env bash
# Quetzalcoatl one-line installer for Linux and macOS.
#
#   curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- [options]
#
# The release signature is the root of trust: SHA256SUMS is signed with Ed25519
# (SHA256SUMS.sig, base64) and the public key is embedded below, so a compromised
# mirror or GitHub account cannot substitute a different binary. Nothing here
# downloads or executes unsigned code.
#
# Options (also accepted as environment variables):
#   --version X.Y.Z        QUETZALCOATL_VERSION      version to install (default: latest signed release)
#   --prefix DIR           QUETZALCOATL_PREFIX       install prefix (default: ~/.local); binaries go to DIR/bin
#   --no-desktop           QUETZALCOATL_NO_DESKTOP=1 do not write the desktop entry
#   --cn | --no-cn         QUETZALCOATL_CN=1|0       prefer the mainland-China mirror (default: automatic direct first)
#   --uninstall [--purge]  remove the service, the binaries and the state dir;
#                          --purge also removes QUETZALCOATL_HOME (spine, memory, settings)
#   --print-platform       print "<os> <arch>" and exit (used by CI matrix checks)
#   --help
#
# Environment knobs used by tests and packagers:
#   QZ_RELEASE_BASE        whitespace-separated release bases to try, e.g. "http://127.0.0.1:8000/v1.0.0"
#   QZ_TEST_RELEASE_PUBKEY raw-32-byte Ed25519 public key (base64url) replacing the embedded one
#   QZ_VERIFIER            auto (default) | openssl | perl
#   QZ_SKIP_SERVICE=1      write the unit/plist but do not call systemctl/launchctl
#   QZ_OS / QZ_ARCH        override platform detection (linux|macos, x64|arm64)
#
# Runs on macOS bash 3.2: no associative arrays, no ${var,,}, no mapfile.
# The whole program lives in main() and is invoked on the last line, so an
# interrupted download can only cause a syntax error, never a half-run install.

set -u
set -o pipefail

REPO="PlutoKeating/Project.Quetzal"
SITE="${QZ_SITE:-https://quetzal.plutokeating.beer}"
BRAND="quetzalcoatl"
# Ed25519, raw 32 bytes, base64url. Same key as the release workflow secret
# RELEASE_SIGNING_KEY. Rotating the key means updating this file, the Windows
# installer and the docs page reference/release-signing in lockstep.
RELEASE_PUBKEY="QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8"
LAUNCHD_LABEL="beer.plutokeating.quetzalcoatl"

OS=""
ARCH=""
ASSET=""
VERSION=""
TAG=""
PREFIX=""
QZ_HOME=""
TMP=""
LOG=""
MODE="install"
PURGE=0
NO_DESKTOP=0
CN=0
PRINT_PLATFORM=0
INSTALLED_BY_US=0
ROLLED_BACK=0

say() { printf '%s\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() {
  printf '  x %s\n' "$*" >&2
  if [ -n "$LOG" ] && [ -s "$LOG" ]; then
    printf '  recent log (%s):\n' "$LOG" >&2
    tail -n 20 "$LOG" | sed 's/^/    /' >&2
  fi
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- [options]
  --version X.Y.Z        install this version (default: latest signed release)
  --prefix DIR           install prefix, binaries land in DIR/bin (default: ~/.local)
  --no-desktop           do not write a desktop entry
  --cn | --no-cn         prefer / avoid the mainland-China mirror
  --uninstall [--purge]  remove service and binaries; --purge also removes QUETZALCOATL_HOME
  --print-platform       print "<os> <arch>" and exit
  --help                 this text
USAGE
}

# ---------------------------------------------------------------- arguments
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION=$2; shift 2 ;;
      --version=*) VERSION=${1#*=}; shift ;;
      --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; PREFIX=$2; shift 2 ;;
      --prefix=*) PREFIX=${1#*=}; shift ;;
      --uninstall) MODE=uninstall; shift ;;
      --purge) PURGE=1; shift ;;
      --no-desktop) NO_DESKTOP=1; shift ;;
      --cn) CN=1; shift ;;
      --no-cn) CN=0; shift ;;
      --print-platform) PRINT_PLATFORM=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  [ -n "${QUETZALCOATL_VERSION:-}" ] && VERSION=$QUETZALCOATL_VERSION
  [ -n "${QUETZALCOATL_PREFIX:-}" ] && PREFIX=$QUETZALCOATL_PREFIX
  [ -n "${QZ_PREFIX:-}" ] && PREFIX=$QZ_PREFIX
  [ "${QUETZALCOATL_NO_DESKTOP:-0}" = 1 ] && NO_DESKTOP=1
  [ "${QUETZALCOATL_CN:-}" = 1 ] && CN=1
  [ "${QUETZALCOATL_CN:-}" = 0 ] && CN=0
}

# ---------------------------------------------------------------- platform
detect_platform() {
  local os arch
  os=${QZ_OS:-$(uname -s 2>/dev/null || echo unknown)}
  case "$os" in
    Linux) OS=linux ;;
    Darwin) OS=macos ;;
    *) die "unsupported operating system: $os (this installer covers Linux and macOS; Windows uses install.ps1)" ;;
  esac
  arch=${QZ_ARCH:-$(uname -m 2>/dev/null || echo unknown)}
  case "$arch" in
    x86_64|amd64|x64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "no official builds for CPU architecture: $arch (build from source: https://github.com/$REPO)" ;;
  esac
}

resolve_paths() {
  if [ -z "$PREFIX" ]; then PREFIX="$HOME/.local"; fi
  case "$PREFIX" in
    /*) : ;;
    *) PREFIX="$PWD/$PREFIX" ;;
  esac
  if [ -z "$QZ_HOME" ]; then
    QZ_HOME=${QUETZALCOATL_HOME:-$HOME/.quetzalcoatl}
  fi
  STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/quetzalcoatl"
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
}

# ---------------------------------------------------------------- network
fetch_text() { # url [timeout]
  local url=$1 t=${2:-10}
  if have curl; then curl -fsSL -m "$t" "$url" 2>>"${LOG:-/dev/null}"
  elif have wget; then wget -q -T "$t" -O - "$url" 2>>"${LOG:-/dev/null}"
  else return 1; fi
}
fetch_file() { # url dest [timeout]
  local url=$1 dest=$2 t=${3:-300}
  if have curl; then curl -fsSL -m "$t" -o "$dest" "$url" 2>>"${LOG:-/dev/null}"
  elif have wget; then wget -q -T "$t" -O "$dest" "$url" 2>>"${LOG:-/dev/null}"
  else return 1; fi
}
fetch_ok() { # url [timeout]
  local url=$1 t=${2:-6}
  if have curl; then curl -fsSL -m "$t" -o /dev/null "$url" 2>/dev/null
  elif have wget; then wget -q -T "$t" -O /dev/null "$url" 2>/dev/null
  else return 1; fi
}

sha256_of() { # file -> lowercase hex on stdout, non-zero when no tool is available
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  elif have openssl; then openssl dgst -sha256 -r "$1" 2>/dev/null | cut -d' ' -f1
  else return 1; fi
}

resolve_version() {
  [ -n "$VERSION" ] && return 0
  local body tag url
  for url in "$SITE/api/releases/latest" "https://api.github.com/repos/$REPO/releases/latest"; do
    body=$(fetch_text "$url" 20) || continue
    tag=$(printf '%s' "$body" | tr ',' '\n' | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    if [ -n "$tag" ]; then VERSION=${tag#v}; return 0; fi
  done
  die "could not determine the latest version; pass --version X.Y.Z"
}

release_bases() {
  if [ -n "${QZ_RELEASE_BASE:-}" ]; then printf '%s\n' ${QZ_RELEASE_BASE}; return 0; fi
  local mirror="https://github.com/$REPO/releases/download/$TAG"
  local site="$SITE/dl/$TAG"
  if [ "$CN" = 1 ]; then
    printf '%s\n%s\n' "${QZ_CN_MIRROR:-$site}" "$mirror"
  else
    printf '%s\n%s\n' "$site" "$mirror"
  fi
}

# ---------------------------------------------------------------- signature verification
hex_to_bin() { # hex -> stdout (bash 3.2 printf %b understands \xHH)
  local h=$1 esc=""
  while [ ${#h} -gt 0 ]; do
    esc="$esc\\x${h%${h#??}}"
    h=${h#??}
  done
  printf '%b' "$esc"
}

pubkey_der_hex() { # base64url pubkey -> DER hex (SPKI prefix 302a300506032b6570032100)
  local b64=$1 raw
  b64=$(printf '%s' "$b64" | tr '_-' '/+')
  case $((${#b64} % 4)) in
    2) b64="$b64==" ;;
    3) b64="$b64=" ;;
  esac
  raw=$(printf '%s' "$b64" | openssl base64 -d -A 2>/dev/null | od -An -tx1 -v 2>/dev/null | tr -d ' \n')
  [ ${#raw} -eq 64 ] || return 1
  printf '302a300506032b6570032100%s' "$raw"
}

verify_openssl() { # sums sig pubkey
  local sums=$1 sig=$2 pub=$3 der sumspem sigbin
  have openssl || return 1
  case "$(openssl version 2>/dev/null)" in
    "OpenSSL 1."|"OpenSSL 0."*) return 1 ;; # Ed25519 needs 1.1.1+; macOS LibreSSL falls back to perl
  esac
  der=$(pubkey_der_hex "$pub") || return 1
  hex_to_bin "$der" >"$TMP/pub.der" || return 1
  {
    printf -- '-----BEGIN PUBLIC KEY-----\n'
    openssl base64 -A -in "$TMP/pub.der" 2>/dev/null
    printf '\n-----END PUBLIC KEY-----\n'
  } >"$TMP/pub.pem" || return 1
  sumspem="$sums"
  sigbin="$TMP/sig.bin"
  openssl base64 -d -A -in "$sig" -out "$sigbin" 2>/dev/null || return 1
  openssl pkeyutl -verify -pubin -inkey "$TMP/pub.pem" -rawin -in "$sumspem" -sigfile "$sigbin" >>"$LOG" 2>&1
}

verify_perl() { # sums sig pubkey — portable fallback (macOS ships perl 5, Linux usually does too)
  local sums=$1 sig=$2 pub=$3
  have perl || return 1
  perl - "$pub" "$sums" "$sig" >>"$LOG" 2>&1 <<'PERL'
use strict;
use warnings;
use Digest::SHA qw(sha512);
use Math::BigInt;
use MIME::Base64 qw(decode_base64);

my ($pub_b64, $msgfile, $sigfile) = @ARGV;
$pub_b64 =~ tr{-_}{+/};
$pub_b64 .= '=' x ((4 - length($pub_b64) % 4) % 4);
my $pub = decode_base64($pub_b64);
die "public key is not 32 bytes\n" unless length($pub) == 32;
open(my $mf, '<:raw', $msgfile) or die "open $msgfile: $!\n";
my $msg = do { local $/; <$mf> };
close $mf;
open(my $sf, '<:raw', $sigfile) or die "open $sigfile: $!\n";
my $sig_b64 = do { local $/; <$sf> };
close $sf;
$sig_b64 =~ s/\s+//g;
my $sig = decode_base64($sig_b64);
die "signature is not 64 bytes\n" unless length($sig) == 64;

my $p = Math::BigInt->new(2)->bpow(255)->bsub(19);
my $L = Math::BigInt->new(2)->bpow(252)
      ->badd(Math::BigInt->new('27742317777372353535851937790883648493'));

sub modp { my $x = shift; my $r = $x->copy->bmod($p); $r->badd($p) if $r->is_neg; $r }
sub mulp { my ($a, $b) = @_; modp($a->copy->bmul($b)) }
sub addp { my ($a, $b) = @_; modp($a->copy->badd($b)) }
sub subp { my ($a, $b) = @_; modp($a->copy->bsub($b)) }
sub invp { my $a = shift; modp($a->copy->bmodpow($p->copy->bsub(2), $p)) }
sub from_le {
  my $s = shift;
  my $n = Math::BigInt->new(0);
  my $m = Math::BigInt->new(1);
  for my $b (unpack('C*', $s)) {
    $n->badd($m->copy->bmul($b)) if $b;
    $m->bmul(256);
  }
  return $n;
}

my $d = modp(Math::BigInt->new(-121665)->bmul(invp(Math::BigInt->new(121666))));
my $d2 = mulp($d, Math::BigInt->new(2));
my $exp4 = $p->copy->bsub(1)->bdiv(4);
my $sqrt_m1 = Math::BigInt->new(2)->bmodpow($exp4, $p);

sub recover_x { # y, sign bit -> x or undef
  my ($y, $sign) = @_;
  return undef if $y->bcmp($p) >= 0;
  my $yy = mulp($y, $y);
  my $u = subp($yy, Math::BigInt->new(1));
  my $v = addp(mulp($d, $yy), Math::BigInt->new(1));
  my $x2 = mulp($u, invp($v));
  if ($x2->is_zero) { return $sign ? undef : Math::BigInt->new(0); }
  my $exp8 = $p->copy->badd(3)->bdiv(8);
  my $x = $x2->copy->bmodpow($exp8, $p);
  if (!modp($x->copy->bmul($x)->bsub($x2))->is_zero) { $x = mulp($x, $sqrt_m1); }
  return undef unless modp($x->copy->bmul($x)->bsub($x2))->is_zero;
  my $odd = $x->is_odd ? 1 : 0;
  $x = subp($p, $x) if $odd != $sign;
  return $x;
}

sub decompress { # 32 bytes -> [X, Y, Z, T] or undef
  my $bytes = shift;
  return undef unless length($bytes) == 32;
  my $sign = (ord(substr($bytes, 31, 1)) >> 7) & 1;
  my $copy = $bytes;
  substr($copy, 31, 1) = chr(ord(substr($copy, 31, 1)) & 0x7f);
  my $y = from_le($copy);
  my $x = recover_x($y, $sign);
  return undef unless defined $x;
  return [$x, $y, Math::BigInt->new(1), mulp($x, $y)];
}

sub padd {
  my ($P, $Q) = @_;
  my ($x1, $y1, $z1, $t1) = @$P;
  my ($x2, $y2, $z2, $t2) = @$Q;
  my $a = mulp(subp($y1, $x1), subp($y2, $x2));
  my $b = mulp(addp($y1, $x1), addp($y2, $x2));
  my $c = mulp($t1, mulp($d2, $t2));
  my $dd = mulp($z1, mulp($z2, Math::BigInt->new(2)));
  my $e = subp($b, $a);
  my $f = subp($dd, $c);
  my $g = addp($dd, $c);
  my $h = addp($b, $a);
  return [mulp($e, $f), mulp($g, $h), mulp($f, $g), mulp($e, $h)];
}

sub smul {
  my ($k, $P) = @_;
  my $q = [Math::BigInt->new(0), Math::BigInt->new(1), Math::BigInt->new(1), Math::BigInt->new(0)];
  my $bits = $k->as_bin();
  $bits =~ s/^0b//;
  for my $bit (split //, $bits) {
    $q = padd($q, $q);
    $q = padd($q, $P) if $bit eq '1';
  }
  return $q;
}

sub peq {
  my ($P, $Q) = @_;
  return 0 unless modp($P->[0]->copy->bmul($Q->[2])->bsub($Q->[0]->copy->bmul($P->[2])))->is_zero;
  return 0 unless modp($P->[1]->copy->bmul($Q->[2])->bsub($Q->[1]->copy->bmul($P->[2])))->is_zero;
  return 1;
}

my $gy = modp(Math::BigInt->new(4)->bmul(invp(Math::BigInt->new(5))));
my $gx = recover_x($gy, 0);
die "base point\n" unless defined $gx;
my $G = [$gx, $gy, Math::BigInt->new(1), mulp($gx, $gy)];

my $A = decompress($pub) or die "public key is not a point\n";
my $rb = substr($sig, 0, 32);
my $R = decompress($rb) or die "signature R is not a point\n";
my $S = from_le(substr($sig, 32, 32));
die "signature S is out of range\n" if $S->bcmp($L) >= 0;
my $h = from_le(sha512($rb . $pub . $msg))->bmod($L);
my $sB = smul($S, $G);
my $rhs = padd($R, smul($h, $A));
exit(peq($sB, $rhs) ? 0 : 3);
PERL
}

verify_signature() { # sums sig
  local sums=$1 sig=$2 pub mode
  pub=${QZ_TEST_RELEASE_PUBKEY:-$RELEASE_PUBKEY}
  mode=${QZ_VERIFIER:-auto}
  case "$mode" in
    openssl) verify_openssl "$sums" "$sig" "$pub" ;;
    perl) verify_perl "$sums" "$sig" "$pub" ;;
    *) verify_openssl "$sums" "$sig" "$pub" || verify_perl "$sums" "$sig" "$pub" ;;
  esac
}

sums_hash() { # sums asset tag -> hex, fails when the commit line or the asset is missing
  awk -v asset="$2" -v tag="$3" '
    $1 == "commit" { if (length($2) == 40 && $2 ~ /^[0-9a-f]+$/ && $3 == tag) found = 1; next }
    $2 == asset && length($1) == 64 && $1 ~ /^[0-9a-f]+$/ { print $1; hit = 1 }
    END { if (!found || !hit) exit 1 }' "$1"
}

# ---------------------------------------------------------------- download + verify
fetch_release() {
  local base expected got
  for base in $(release_bases); do
    note "source: $base"
    rm -f "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig" "$TMP/$ASSET"
    if ! fetch_file "$base/SHA256SUMS" "$TMP/SHA256SUMS" 60 || ! fetch_file "$base/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig" 60; then
      warn "could not download the signed manifest from $base"
      continue
    fi
    if ! verify_signature "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig"; then
      warn "SHA256SUMS signature verification failed for $base"
      continue
    fi
    if ! expected=$(sums_hash "$TMP/SHA256SUMS" "$ASSET" "$TAG"); then
      warn "$base/SHA256SUMS has no signed entry for $ASSET at $TAG"
      continue
    fi
    if ! fetch_file "$base/$ASSET" "$TMP/$ASSET" 900; then
      warn "could not download $ASSET from $base"
      continue
    fi
    got=$(sha256_of "$TMP/$ASSET") || die "no sha256 tool (sha256sum / shasum / openssl)"
    if [ "$got" != "$expected" ]; then
      warn "$ASSET sha256 mismatch (got $got, signed $expected)"
      continue
    fi
    say "  signature and sha256 verified: $ASSET"
    return 0
  done
  return 1
}

# ---------------------------------------------------------------- install
backup_current() {
  if [ -d "$PREFIX/bin" ] && [ -n "$(ls -A "$PREFIX/bin" 2>/dev/null)" ]; then
    rm -rf "$STATE_DIR/backup"
    mkdir -p "$STATE_DIR/backup"
    cp -R "$PREFIX/bin" "$STATE_DIR/backup/bin" || die "could not back up $PREFIX/bin"
    if [ -f "$STATE_DIR/installed-version" ]; then
      cp "$STATE_DIR/installed-version" "$STATE_DIR/backup/installed-version" 2>/dev/null || true
    fi
    say "  previous version kept aside for rollback"
  fi
}

restore_backup() {
  if [ -d "$STATE_DIR/backup/bin" ]; then
    rm -rf "$PREFIX/bin"
    mkdir -p "$(dirname "$PREFIX/bin")"
    cp -R "$STATE_DIR/backup/bin" "$PREFIX/bin" || return 1
    if [ -f "$STATE_DIR/backup/installed-version" ]; then
      cp "$STATE_DIR/backup/installed-version" "$STATE_DIR/installed-version" 2>/dev/null || true
    fi
    ROLLED_BACK=1
  fi
}

install_binaries() {
  local stage=$1 f
  mkdir -p "$PREFIX/bin" || die "could not create $PREFIX/bin"
  for f in "$stage"/bin/*; do
    [ -f "$f" ] || continue
    cp "$f" "$PREFIX/bin/" || die "could not install $(basename "$f")"
    chmod 0755 "$PREFIX/bin/$(basename "$f")" || die "could not chmod $(basename "$f")"
    INSTALLED_BY_US=1
  done
  [ -x "$PREFIX/bin/qz" ] || die "the archive does not contain bin/qz"
}

write_service_linux() {
  local unit="$CONFIG_DIR/systemd/user/quetzalcoatld.service"
  mkdir -p "$(dirname "$unit")" || return 1
  {
    printf '[Unit]\n'
    printf 'Description=Quetzalcoatl spine daemon (quetzalcoatld)\n'
    printf 'Documentation=%s/docs/reference/release-signing\n' "$SITE"
    printf 'After=network-online.target\n\n'
    printf '[Service]\n'
    printf 'Type=simple\n'
    printf 'ExecStart=%s/bin/quetzalcoatld\n' "$PREFIX"
    printf 'Environment=QUETZALCOATL_HOME=%s\n' "$QZ_HOME"
    printf 'Restart=on-failure\n'
    printf 'RestartSec=3\n\n'
    printf '[Install]\n'
    printf 'WantedBy=default.target\n'
  } >"$unit" || return 1
  say "  systemd user unit: $unit"
  if [ "${QZ_SKIP_SERVICE:-0}" = 1 ]; then
    note "QZ_SKIP_SERVICE=1: not calling systemctl"
    return 0
  fi
  if have systemctl && systemctl --user daemon-reload >>"$LOG" 2>&1; then
    systemctl --user enable quetzalcoatld.service >>"$LOG" 2>&1 && systemctl --user restart quetzalcoatld.service >>"$LOG" 2>&1 \
      || warn "could not start quetzalcoatld.service; run: systemctl --user enable --now quetzalcoatld"
  else
    warn "no systemd user instance here; the unit was written but not enabled"
  fi
}

write_service_macos() {
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  mkdir -p "$(dirname "$plist")" || return 1
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PREFIX/bin/quetzalcoatld</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>QUETZALCOATL_HOME</key><string>$QZ_HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
PLIST
  say "  launchd user agent: $plist"
  if [ "${QZ_SKIP_SERVICE:-0}" = 1 ]; then
    note "QZ_SKIP_SERVICE=1: not calling launchctl"
    return 0
  fi
  if have launchctl; then
    launchctl unload "$plist" >>"$LOG" 2>&1 || true
    launchctl load "$plist" >>"$LOG" 2>&1 || warn "could not load the launchd agent; run: launchctl load $plist"
  fi
}

write_desktop_entry() {
  [ "$NO_DESKTOP" = 1 ] && { note "--no-desktop: no desktop entry"; return 0; }
  [ -x "$PREFIX/bin/quetzalcoatl-desktop" ] || return 0
  case "$OS" in
    linux)
      local app="$HOME/.local/share/applications/quetzalcoatl.desktop"
      mkdir -p "$(dirname "$app")" || return 1
      {
        printf '[Desktop Entry]\nType=Application\nName=Quetzalcoatl\n'
        printf 'Comment=A sovereign, spine-backed agent body\n'
        printf 'Exec=%s/bin/quetzalcoatl-desktop\n' "$PREFIX"
        printf 'Terminal=false\nCategories=Utility;\n'
      } >"$app" || return 1
      say "  desktop entry: $app"
      ;;
    macos) : ;; # the app bundle carries its own Info.plist
  esac
}

health_check() {
  local out rc pid watcher
  [ -x "$PREFIX/bin/qz" ] || return 1
  out="$TMP/health.out"
  "$PREFIX/bin/qz" --version >"$out" 2>>"$LOG" &
  pid=$!
  ( sleep 30; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watcher=$!
  wait "$pid"
  rc=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  [ $rc -eq 0 ] || return 1
  grep -q "$VERSION" "$out" || return 1
  return 0
}

do_install() {
  case "$VERSION" in
    *[!0-9A-Za-z.-]*|"") die "invalid version: $VERSION" ;;
  esac
  case "$VERSION" in
    [0-9]*) : ;;
    *) die "invalid version: $VERSION" ;;
  esac
  TAG="v$VERSION"
  ASSET="$BRAND-$VERSION-$OS-$ARCH.tar.gz"

  say ""
  say "Quetzalcoatl installer"
  say "  version  $VERSION"
  say "  platform $OS $ARCH"
  say "  prefix   $PREFIX"
  say "  home     $QZ_HOME"
  say ""

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/quetzalcoatl.XXXXXX") || die "could not create a temp dir"
  LOG="$TMP/install.log"

  say "Downloading the signed release"
  fetch_release || die "no trusted source could provide $ASSET"
  say ""

  mkdir -p "$TMP/stage" || die "could not create $TMP/stage"
  tar -xzf "$TMP/$ASSET" -C "$TMP/stage" >>"$LOG" 2>&1 || die "could not extract $ASSET"
  [ -f "$TMP/stage/bin/qz" ] || die "unexpected archive layout: bin/qz missing"

  backup_current
  install_binaries "$TMP/stage"
  if ! health_check; then
    if [ "$ROLLED_BACK" = 0 ] && [ -d "$STATE_DIR/backup/bin" ]; then
      warn "the new version did not pass its health check; rolling back"
      restore_backup || die "health check failed and the rollback failed too; your previous binaries were not replaced safely"
      say "  rolled back to the previous version"
    fi
    die "quetzalcoatl $VERSION failed its health check (qz --version); nothing was activated"
  fi

  mkdir -p "$STATE_DIR" || die "could not create $STATE_DIR"
  mkdir -p "$QZ_HOME" 2>/dev/null && chmod 700 "$QZ_HOME" 2>/dev/null || true
  printf '%s\n' "$VERSION" >"$STATE_DIR/installed-version"
  case "$OS" in
    linux) write_service_linux ;;
    macos) write_service_macos ;;
  esac
  write_desktop_entry

  say ""
  say "Quetzalcoatl $VERSION installed."
  case ":$PATH:" in
    *":$PREFIX/bin:"*) : ;;
    *) say "Add $PREFIX/bin to PATH, then run: qz up" ;;
  esac
  say "Next: qz up      (starts quetzalcoatld, the single spine owner)"
  say "Docs: $SITE/docs/start/install"
}

# ---------------------------------------------------------------- uninstall
do_uninstall() {
  local unit="$CONFIG_DIR/systemd/user/quetzalcoatld.service"
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  say "Removing Quetzalcoatl"

  if [ "${QZ_SKIP_SERVICE:-0}" != 1 ]; then
    if [ "$OS" = linux ] && have systemctl; then
      systemctl --user disable --now quetzalcoatld.service >>"${TMPDIR:-/tmp}/qz-uninstall.log" 2>&1 || true
    fi
    if [ "$OS" = macos ] && have launchctl; then
      launchctl unload "$plist" >>"${TMPDIR:-/tmp}/qz-uninstall.log" 2>&1 || true
    fi
  fi
  rm -f "$unit" "$plist" "$HOME/.local/share/applications/quetzalcoatl.desktop"
  rm -f "$PREFIX/bin/qz" "$PREFIX/bin/quetzalcoatld" "$PREFIX/bin/quetzalcoatl-sandbox-exec" "$PREFIX/bin/quetzalcoatl-desktop"
  rm -rf "$STATE_DIR"
  say "  service, binaries and state removed"

  if [ "$PURGE" = 1 ]; then
    case "$QZ_HOME" in
      ""|"/"|"$HOME") die "refusing to purge $QZ_HOME" ;;
    esac
    if [ -d "$QZ_HOME" ]; then
      rm -rf "$QZ_HOME" || die "could not remove $QZ_HOME"
      say "  purged $QZ_HOME (spine, memory, settings)"
    else
      note "$QZ_HOME does not exist"
    fi
  else
    say "  kept $QZ_HOME (add --purge to remove your spine, memory and settings)"
  fi
}

main() {
  parse_args "$@"
  detect_platform
  if [ "$PRINT_PLATFORM" = 1 ]; then
    printf '%s %s\n' "$OS" "$ARCH"
    return 0
  fi
  resolve_paths
  if [ "$MODE" = uninstall ]; then
    TMP=$(mktemp -d "${TMPDIR:-/tmp}/quetzalcoatl.XXXXXX") || die "could not create a temp dir"
    do_uninstall
    return 0
  fi
  resolve_version
  do_install
}

main "$@"
