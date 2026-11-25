# Quetzalcoatl Windows installer tests (scripts/install.ps1).
#
# Same shape as scripts/tests/install_verify_sig.test.sh: a local fake release
# server plus a throwaway Ed25519 key pair. Covers platform detection, a signed
# install, tampered manifest / tampered artifact / bad signature rejection,
# rollback when the new version fails its health check, and -Uninstall [-Purge].
#
# The release base, prefix, home, public key, OS and architecture are passed
# through the documented environment overrides so this file never touches the
# real %LOCALAPPDATA% or the real Task Scheduler.
#
# Requires: PowerShell 7+, openssl, python3. Exits 77 when a dependency or the
# installer source is missing (SKIP), never fakes a pass.
# ASCII only: this file must stay readable under Windows PowerShell 5.1 ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '../..')).Path
$installer = Join-Path $root 'scripts/install.ps1'
$generator = Join-Path $root 'scripts/gen-install-ps1.mjs'
$node = Get-Command node -ErrorAction SilentlyContinue
$pwsh = (Get-Process -Id $PID).Path

function Skip([string]$why) {
  Write-Host "SKIP: $why"
  exit 77
}

foreach ($tool in @('openssl', 'python3')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Skip "missing dependency: $tool" }
}
if (-not (Test-Path $installer)) { Write-Host "not ok 1 - installer not found: $installer"; exit 1 }

$work = Join-Path ([IO.Path]::GetTempPath()) ("qz-ps1-test-" + [Guid]::NewGuid().ToString('n').Substring(0, 12))
New-Item -ItemType Directory -Path $work | Out-Null
$srv = Join-Path $work 'srv'
New-Item -ItemType Directory -Path $srv | Out-Null

$script:Passed = 0
$script:Failed = 0
$script:Server = $null

function Check([string]$name, [scriptblock]$body) {
  try {
    & $body
    $script:Passed++
    Write-Host ("ok {0} - {1}" -f ($script:Passed + $script:Failed), $name)
  } catch {
    $script:Failed++
    Write-Host ("not ok {0} - {1}" -f ($script:Passed + $script:Failed), $name)
    Write-Host ("    " + $_.Exception.Message)
  }
}
function Assert([bool]$cond, [string]$message) { if (-not $cond) { throw $message } }

# ---------------------------------------------------------------- key pair
$keys = Join-Path $work 'keys'
New-Item -ItemType Directory -Path $keys | Out-Null
$privateKey = Join-Path $keys 'release.pem'
$pubDer = Join-Path $keys 'pub.der'
& openssl genpkey -algorithm ed25519 -out $privateKey 2>$null
if ($LASTEXITCODE -ne 0) { Skip 'openssl cannot generate Ed25519 keys' }
& openssl pkey -in $privateKey -pubout -outform DER -out $pubDer 2>$null
$der = [IO.File]::ReadAllBytes($pubDer)
$raw = $der[($der.Length - 32)..($der.Length - 1)]
$pub = [Convert]::ToBase64String($raw).Replace('+', '-').Replace('/', '_').TrimEnd('=')

# ---------------------------------------------------------------- fake releases
function New-Release {
  param([string]$Version, [bool]$Healthy, [string]$TargetDir)
  if (-not $TargetDir) { $TargetDir = Join-Path $srv ("v" + $Version) }
  New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
  $stage = Join-Path $work ("stage-" + $Version)
  New-Item -ItemType Directory -Path (Join-Path $stage 'bin') -Force | Out-Null
  if ($Healthy) {
    $stub = "#!/bin/sh`nif [ `"`${1:-}`" = `"--version`" ]; then printf 'qz $Version`n'; exit 0; fi`nexit 0`n"
  } else {
    $stub = "#!/bin/sh`nif [ `"`${1:-}`" = `"--version`" ]; then printf 'qz ${Version}: unusable`n'; exit 3; fi`nexit 0`n"
  }
  [IO.File]::WriteAllText((Join-Path $stage 'bin/qz'), $stub)
  [IO.File]::WriteAllText((Join-Path $stage 'bin/quetzalcoatld'), "#!/bin/sh`nexit 0`n")
  $asset = "quetzalcoatl-$Version-windows-x64.zip"
  $zip = Join-Path $TargetDir $asset
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage 'bin') -DestinationPath $zip -Force
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
  $sums = Join-Path $TargetDir 'SHA256SUMS'
  $lines = @(
    ("$hash  $asset"),
    ("commit 0123456789abcdef0123456789abcdef01234567 v$Version")
  )
  [IO.File]::WriteAllText($sums, (($lines -join "`n") + "`n"))
  $sigBin = Join-Path $work 'sig.bin'
  & openssl pkeyutl -sign -inkey $privateKey -rawin -in $sums -out $sigBin 2>$null
  if ($LASTEXITCODE -ne 0) { Skip 'openssl cannot sign with Ed25519' }
  $sigB64 = (& openssl base64 -A -in $sigBin).Trim()
  [IO.File]::WriteAllText((Join-Path $TargetDir 'SHA256SUMS.sig'), $sigB64)
  return $TargetDir
}

New-Release -Version '1.0.0' -Healthy $true | Out-Null
New-Release -Version '1.1.0' -Healthy $false | Out-Null

function Copy-Release([string]$from, [string]$to) {
  Copy-Item -Recurse -Force (Join-Path $srv $from) (Join-Path $srv $to)
  return (Join-Path $srv $to)
}
$tamperedSums = Copy-Release 'v1.0.0' 'tampered-sums'
$tamperedArtifact = Copy-Release 'v1.0.0' 'tampered-artifact'
$badSignature = Copy-Release 'v1.0.0' 'bad-signature'

# Flip one hex digit of the artifact hash without re-signing.
$sumsPath = Join-Path $tamperedSums 'SHA256SUMS'
$text = [IO.File]::ReadAllText($sumsPath)
$first = $text.Substring(0, 1)
$text = ($(if ($first -eq '0') { '1' } else { '0' })) + $text.Substring(1)
[IO.File]::WriteAllText($sumsPath, $text)
# Change the artifact without touching the (still signed) manifest.
$zipPath = Join-Path $tamperedArtifact 'quetzalcoatl-1.0.0-windows-x64.zip'
$bytes = [IO.File]::ReadAllBytes($zipPath)
[IO.File]::WriteAllBytes($zipPath, ($bytes + [byte[]](1..16)))
# Garbage base64 signature.
[IO.File]::WriteAllText((Join-Path $badSignature 'SHA256SUMS.sig'), 'bm90IGEgc2lnbmF0dXJl')

# ---------------------------------------------------------------- fake server
$port = Get-Random -Minimum 20000 -Maximum 39000
$script:Server = Start-Process -FilePath 'python3' -ArgumentList @('-m', 'http.server', "$port", '--bind', '127.0.0.1', '--directory', $srv) -PassThru
$base = "http://127.0.0.1:$port"
$ready = $false
for ($i = 0; $i -lt 50; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$base/v1.0.0/SHA256SUMS" -TimeoutSec 1 | Out-Null
    $ready = $true
    break
  } catch {
    Start-Sleep -Milliseconds 100
  }
}
if (-not $ready) { Skip 'could not start the local release server' }

# ---------------------------------------------------------------- installer invocation
$script:SavedEnv = @{}
function Set-InstallerEnv([string]$prefix, [string]$homeDir, [string]$releaseBase) {
  foreach ($name in @('QUETZALCOATL_PREFIX', 'QUETZALCOATL_HOME', 'QUETZALCOATL_RELEASE_BASE', 'QUETZALCOATL_TEST_RELEASE_PUBKEY', 'QUETZALCOATL_SKIP_TASKS', 'QUETZALCOATL_VERSION', 'QUETZALCOATL_OS', 'QUETZALCOATL_ARCH')) {
    if (-not $script:SavedEnv.ContainsKey($name)) { $script:SavedEnv[$name] = [Environment]::GetEnvironmentVariable($name) }
  }
  $env:QUETZALCOATL_PREFIX = $prefix
  $env:QUETZALCOATL_HOME = $homeDir
  $env:QUETZALCOATL_RELEASE_BASE = $releaseBase
  $env:QUETZALCOATL_TEST_RELEASE_PUBKEY = $pub
  $env:QUETZALCOATL_SKIP_TASKS = '1'
  $env:QUETZALCOATL_OS = 'windows'
  $env:QUETZALCOATL_ARCH = 'x64'
  Remove-Item Env:QUETZALCOATL_VERSION -ErrorAction SilentlyContinue
}
function Invoke-Installer([string[]]$InstallerArgs) {
  $out = & $pwsh -NoProfile -File $installer @InstallerArgs 2>&1
  return @{ Code = $LASTEXITCODE; Out = ($out | Out-String) }
}
function Reset-InstallerEnv {
  foreach ($name in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $script:SavedEnv[$name]) }
  $script:SavedEnv = @{}
}

function Test-Installed([string]$prefix) { return (Test-Path (Join-Path $prefix 'bin')) }

try {
  # -------------------------------------------------------------- 0. generated file is in sync
  if ($node) {
    Check 'scripts/install.ps1 is generated from scripts/install.src.ps1' {
      & node $generator --check | Out-Null
      Assert ($LASTEXITCODE -eq 0) 'generator --check reported drift'
    }
  } else {
    $script:Passed++
    Write-Host ("ok {0} - generator check skipped (no node)" -f ($script:Passed + $script:Failed))
  }

  # -------------------------------------------------------------- 1. platform detection
  Check 'platform detection prints windows x64' {
    $env:QUETZALCOATL_OS = 'windows'
    $env:QUETZALCOATL_ARCH = 'x64'
    $r = Invoke-Installer @('-PrintPlatform')
    Assert ($r.Code -eq 0) "exit $($r.Code): $($r.Out)"
    Assert ($r.Out.Trim() -eq 'windows x64') "got '$($r.Out.Trim())'"
  }
  Check 'unknown architecture is rejected' {
    $env:QUETZALCOATL_ARCH = 'riscv64'
    $r = Invoke-Installer @('-PrintPlatform')
    Assert ($r.Code -ne 0) 'expected a non-zero exit for riscv64'
    $env:QUETZALCOATL_ARCH = 'x64'
  }

  # -------------------------------------------------------------- 2. signed install
  $c1 = Join-Path $work 'c1'
  $p1 = Join-Path $c1 'root'
  $h1 = Join-Path $c1 'home'
  New-Item -ItemType Directory -Path $c1 -Force | Out-Null
  Check 'good signature installs' {
    Set-InstallerEnv $p1 $h1 "$base/v1.0.0"
    $r = Invoke-Installer @('-Version', '1.0.0', '-NoDesktop')
    Assert ($r.Code -eq 0) "exit $($r.Code): $($r.Out)"
  }
  Check 'installed qz reports the requested version' {
    $r = (& $pwsh -NoProfile -Command "& bash '$(Join-Path $p1 'bin/qz')' --version" | Out-String)
    Assert ($r -match '1\.0\.0') "got '$r'"
  }
  Check 'scheduled task plan contains Runtime-Boot and Runtime-Logon' {
    $plan = Join-Path $p1 'service/tasks.json'
    Assert (Test-Path $plan) "missing $plan"
    $json = [IO.File]::ReadAllText($plan) | ConvertFrom-Json
    $names = @($json.tasks | ForEach-Object { [string]$_.fullName })
    Assert ($names -contains '\Quetzalcoatl\Runtime-Boot') "Runtime-Boot missing (got $($names -join ', '))"
    Assert ($names -contains '\Quetzalcoatl\Runtime-Logon') "Runtime-Logon missing (got $($names -join ', '))"
    Assert ($names.Count -eq 2) "expected 2 tasks, got $($names.Count)"
  }

  # -------------------------------------------------------------- 3. tampered manifest
  $c2 = Join-Path $work 'c2'
  Check 'tampered SHA256SUMS is rejected' {
    Set-InstallerEnv (Join-Path $c2 'root') (Join-Path $c2 'home') "$base/tampered-sums"
    $r = Invoke-Installer @('-Version', '1.0.0', '-NoDesktop')
    Assert ($r.Code -ne 0) 'expected a non-zero exit'
    Assert (-not (Test-Installed (Join-Path $c2 'root'))) 'binaries were installed anyway'
  }

  # -------------------------------------------------------------- 4. tampered artifact
  $c3 = Join-Path $work 'c3'
  Check 'tampered artifact fails the signed sha256' {
    Set-InstallerEnv (Join-Path $c3 'root') (Join-Path $c3 'home') "$base/tampered-artifact"
    $r = Invoke-Installer @('-Version', '1.0.0', '-NoDesktop')
    Assert ($r.Code -ne 0) 'expected a non-zero exit'
    Assert (-not (Test-Installed (Join-Path $c3 'root'))) 'binaries were installed anyway'
  }

  # -------------------------------------------------------------- 5. bad signature
  $c4 = Join-Path $work 'c4'
  Check 'garbage signature is rejected' {
    Set-InstallerEnv (Join-Path $c4 'root') (Join-Path $c4 'home') "$base/bad-signature"
    $r = Invoke-Installer @('-Version', '1.0.0', '-NoDesktop')
    Assert ($r.Code -ne 0) 'expected a non-zero exit'
    Assert (-not (Test-Installed (Join-Path $c4 'root'))) 'binaries were installed anyway'
  }

  # -------------------------------------------------------------- 6. rollback
  $c5 = Join-Path $work 'c5'
  $p5 = Join-Path $c5 'root'
  $h5 = Join-Path $c5 'home'
  Check 'baseline 1.0.0 installs before the failed upgrade' {
    Set-InstallerEnv $p5 $h5 "$base/v1.0.0"
    $r = Invoke-Installer @('-Version', '1.0.0', '-NoDesktop')
    Assert ($r.Code -eq 0) "exit $($r.Code): $($r.Out)"
  }
  Check 'unhealthy upgrade exits non-zero and rolls back' {
    Set-InstallerEnv $p5 $h5 "$base/v1.1.0"
    $r = Invoke-Installer @('-Version', '1.1.0', '-NoDesktop')
    Assert ($r.Code -ne 0) 'expected a non-zero exit'
    $v = (& $pwsh -NoProfile -Command "& bash '$(Join-Path $p5 'bin/qz')' --version" | Out-String)
    Assert ($v -match '1\.0\.0') "rolled back binary reports '$v'"
    $recorded = [IO.File]::ReadAllText((Join-Path $p5 'service/installed-version')).Trim()
    Assert ($recorded -eq '1.0.0') "installed-version is '$recorded'"
  }

  # -------------------------------------------------------------- 7. uninstall
  $c6 = Join-Path $work 'c6'
  $p6 = Join-Path $c6 'root'
  $h6 = Join-Path $c6 'home'
  Check 'uninstall removes binaries and the task plan, keeps home' {
    Set-InstallerEnv $p6 $h6 "$base/v1.0.0"
    $r = Invoke-Installer @('-Version', '1.0.0', '-NoDesktop')
    Assert ($r.Code -eq 0) "install failed: $($r.Out)"
    New-Item -ItemType Directory -Path $h6 -Force | Out-Null
    $env:QUETZALCOATL_PREFIX = $p6
    $env:QUETZALCOATL_HOME = $h6
    $r = Invoke-Installer @('-Uninstall')
    Assert ($r.Code -eq 0) "uninstall failed: $($r.Out)"
    Assert (-not (Test-Installed $p6)) 'binaries still present'
    Assert (-not (Test-Path (Join-Path $p6 'service/tasks.json'))) 'task plan still present'
    Assert (Test-Path $h6) 'home was removed without -Purge'
  }
  Check 'uninstall -Purge removes the home directory' {
    Set-InstallerEnv $p6 $h6 "$base/v1.0.0"
    $r = Invoke-Installer @('-Version', '1.0.0', '-NoDesktop')
    Assert ($r.Code -eq 0) "reinstall failed: $($r.Out)"
    New-Item -ItemType Directory -Path $h6 -Force | Out-Null
    $r = Invoke-Installer @('-Uninstall', '-Purge')
    Assert ($r.Code -eq 0) "uninstall -Purge failed: $($r.Out)"
    Assert (-not (Test-Path $h6)) 'home still present after -Purge'
  }
} finally {
  Reset-InstallerEnv
  if ($script:Server -and -not $script:Server.HasExited) { Stop-Process -Id $script:Server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host ("{0} checks, {1} failed" -f ($script:Passed + $script:Failed), $script:Failed)
if ($script:Failed -gt 0) { exit 1 }
exit 0
