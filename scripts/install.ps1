# Quetzalcoatl installer for Windows: irm https://quetzal.plutokeating.beer/install.ps1 | iex
# GENERATED from scripts/install.src.ps1 by scripts/gen-install-ps1.mjs - edit the source, not this file.
# source sha256: 171e227d8489b399d556eb921a7f2a81d9afc227d08a4b2fa8929c6f2f5de78a
# The Ed25519 verifier and the embedded release key are part of this file: there is no black box.
<#
.SYNOPSIS
  Quetzalcoatl one-line installer for Windows:  irm https://quetzal.plutokeating.beer/install.ps1 | iex

.DESCRIPTION
  The root of trust is the Ed25519 signature on SHA256SUMS.sig, verified with the
  public key embedded below. A mirror or a compromised GitHub account cannot swap
  the key. Nothing unsigned is executed.

  Installs qz.exe, quetzalcoatld.exe and quetzalcoatl-sandbox-exec.exe into
  %LOCALAPPDATA%\Quetzalcoatl\bin and registers two scheduled tasks:
    \Quetzalcoatl\Runtime-Boot   at system startup
    \Quetzalcoatl\Runtime-Logon  at user logon
  Both run as the current user with limited privileges. If registration fails the
  script prints the command for you to run; it never silently elevates.

  On a failed health check (qz.exe --version) the previous version is restored.

.PARAMETER Version
  Version to install, e.g. 0.1.0. Default: the latest signed release.
  Also read from $env:QUETZALCOATL_VERSION.

.PARAMETER Prefix
  Install root. Default: %LOCALAPPDATA%\Quetzalcoatl.
  Also read from $env:QUETZALCOATL_PREFIX.

.PARAMETER Uninstall
  Remove the scheduled tasks, binaries and service state. Keeps QUETZALCOATL_HOME.

.PARAMETER Purge
  With -Uninstall, also delete QUETZALCOATL_HOME (spine, memory and settings).

.PARAMETER NoDesktop
  Do not create shortcuts (currently informational; the native app carries its own).

.PARAMETER PrintPlatform
  Print "<os> <arch>" and exit. Used by CI.

  Test and packager overrides (documented, not needed in normal use):
    QUETZALCOATL_RELEASE_BASE        whitespace separated release bases to try
    QUETZALCOATL_TEST_RELEASE_PUBKEY raw-32-byte Ed25519 key, base64url
    QUETZALCOATL_SKIP_TASKS=1        write the task plan but do not register tasks
    QUETZALCOATL_HOME                runtime home (default: the install root)
    QUETZALCOATL_OS / _ARCH          override platform detection

  Pure ASCII: Windows PowerShell 5.1 reads scripts in the ANSI code page.
#>
param(
  [string]$Version = $env:QUETZALCOATL_VERSION,
  [string]$Prefix = $env:QUETZALCOATL_PREFIX,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$NoDesktop,
  [switch]$PrintPlatform
)

# Ed25519, raw 32 bytes, base64url. Same key as scripts/install.sh and the docs
# page reference/release-signing; the private key is only the RELEASE_SIGNING_KEY secret.
$script:ReleasePubKey = 'QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8'
$script:Repo = 'PlutoKeating/Project.Quetzal'
$script:Site = if ($env:QZ_SITE) { $env:QZ_SITE } else { 'https://quetzal.plutokeating.beer' }
$script:Brand = 'quetzalcoatl'
$script:TaskPath = '\Quetzalcoatl\'
$script:BootTask = 'Runtime-Boot'
$script:LogonTask = 'Runtime-Logon'

function Write-Step([string]$text) { Write-Host ''; Write-Host ("== " + $text) -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host ("  + " + $text) -ForegroundColor Green }
function Write-Note([string]$text) { Write-Host ("  - " + $text) -ForegroundColor DarkGray }
function Write-Warn([string]$text) { Write-Host ("  ! " + $text) -ForegroundColor Yellow }
function Fail([string]$text) { throw $text }

# ---------------------------------------------------------------- Ed25519 (RFC 8032, cofactorless)
# Windows PowerShell 5.1 / .NET Framework have no Ed25519 API, so this is a direct
# implementation over System.Numerics.BigInteger. Publishing the algorithm here is
# intentional: there is no black box in the trust path.
function Ed-Init {
  if ($script:EdP) { return }
  try { Add-Type -AssemblyName System.Numerics -ErrorAction Stop } catch { }
  $B = [System.Numerics.BigInteger]
  $script:EdB = $B
  $script:EdP = $B::Subtract($B::Pow(2, 255), 19)
  $script:EdL = $B::Add($B::Pow(2, 252), $B::Parse('27742317777372353535851937790883648493'))
  $script:EdD = Ed-Mod ($B::Multiply(-121665, (Ed-Inv 121666)))
  $script:EdI = $B::ModPow(2, $B::Divide($B::Subtract($script:EdP, 1), 4), $script:EdP)
  $gy = Ed-Mod ($B::Multiply(4, (Ed-Inv 5)))
  $gx = Ed-RecoverX $gy 0
  $script:EdG = @($gx, $gy, $B::One, (Ed-Mul $gx $gy))
}
function Ed-Mod($x) {
  $r = [System.Numerics.BigInteger]::Remainder($x, $script:EdP)
  if ($r.Sign -lt 0) { $r = [System.Numerics.BigInteger]::Add($r, $script:EdP) }
  return $r
}
function Ed-Mul($a, $b) { return Ed-Mod ([System.Numerics.BigInteger]::Multiply($a, $b)) }
function Ed-Inv($x) { return [System.Numerics.BigInteger]::ModPow((Ed-Mod $x), [System.Numerics.BigInteger]::Subtract($script:EdP, 2), $script:EdP) }
function Ed-FromLE([byte[]]$bytes) { return New-Object System.Numerics.BigInteger (,([byte[]]($bytes + [byte]0))) }

function Ed-RecoverX($y, [int]$sign) {
  $B = $script:EdB; $p = $script:EdP
  if ($y.CompareTo($p) -ge 0) { return $null }
  $yy = Ed-Mul $y $y
  $x2 = Ed-Mul (Ed-Mod ($B::Subtract($yy, 1))) (Ed-Inv ($B::Add((Ed-Mul $script:EdD $yy), 1)))
  if ($x2.IsZero) { if ($sign -ne 0) { return $null } else { return $B::Zero } }
  $x = $B::ModPow($x2, $B::Divide($B::Add($p, 3), 8), $p)
  if (-not (Ed-Mod ($B::Subtract((Ed-Mul $x $x), $x2))).IsZero) { $x = Ed-Mul $x $script:EdI }
  if (-not (Ed-Mod ($B::Subtract((Ed-Mul $x $x), $x2))).IsZero) { return $null }
  if ([int]($B::Remainder($x, 2)) -ne $sign) { $x = $B::Subtract($p, $x) }
  return $x
}

function Ed-Add($P1, $Q1) {
  $B = $script:EdB
  $a = Ed-Mul (Ed-Mod ($B::Subtract($P1[1], $P1[0]))) (Ed-Mod ($B::Subtract($Q1[1], $Q1[0])))
  $b = Ed-Mul ($B::Add($P1[1], $P1[0])) ($B::Add($Q1[1], $Q1[0]))
  $c = Ed-Mul (Ed-Mul ($B::Multiply(2, $P1[3])) $Q1[3]) $script:EdD
  $d = Ed-Mul ($B::Multiply(2, $P1[2])) $Q1[2]
  $e = Ed-Mod ($B::Subtract($b, $a)); $f = Ed-Mod ($B::Subtract($d, $c))
  $g = Ed-Mod ($B::Add($d, $c)); $h = Ed-Mod ($B::Add($b, $a))
  return @((Ed-Mul $e $f), (Ed-Mul $g $h), (Ed-Mul $f $g), (Ed-Mul $e $h))
}

function Ed-ScalarMul($s, $Pt) {
  $B = $script:EdB
  $q = @($B::Zero, $B::One, $B::One, $B::Zero)
  while ($s.Sign -gt 0) {
    if (-not $s.IsEven) { $q = Ed-Add $q $Pt }
    $Pt = Ed-Add $Pt $Pt
    $s = $B::Divide($s, 2)
  }
  return $q
}

function Ed-Decompress([byte[]]$bytes) {
  if ($bytes.Length -ne 32) { return $null }
  $c = [byte[]]$bytes.Clone()
  $sign = [int]($c[31] -shr 7)
  $c[31] = $c[31] -band 0x7F
  $y = Ed-FromLE $c
  $x = Ed-RecoverX $y $sign
  if ($null -eq $x) { return $null }
  return @($x, $y, $script:EdB::One, (Ed-Mul $x $y))
}

function Test-Ed25519([byte[]]$pub, [byte[]]$msg, [byte[]]$sig) {
  Ed-Init
  $B = $script:EdB
  if ($pub.Length -ne 32 -or $sig.Length -ne 64) { return $false }
  $A = Ed-Decompress $pub; if ($null -eq $A) { return $false }
  $rb = [byte[]]$sig[0..31]
  $R = Ed-Decompress $rb; if ($null -eq $R) { return $false }
  $s = Ed-FromLE ([byte[]]$sig[32..63])
  if ($s.CompareTo($script:EdL) -ge 0) { return $false }
  $sha = [Security.Cryptography.SHA512]::Create()
  $h = Ed-FromLE ($sha.ComputeHash([byte[]]($rb + $pub + $msg)))
  $h = $B::Remainder($h, $script:EdL)
  $sB = Ed-ScalarMul $s $script:EdG
  $rhs = Ed-Add $R (Ed-ScalarMul $h $A)
  $e1 = Ed-Mod ($B::Subtract((Ed-Mul $sB[0] $rhs[2]), (Ed-Mul $rhs[0] $sB[2])))
  $e2 = Ed-Mod ($B::Subtract((Ed-Mul $sB[1] $rhs[2]), (Ed-Mul $rhs[1] $sB[2])))
  return ($e1.IsZero -and $e2.IsZero)
}

function From-Base64Url([string]$s) {
  $t = $s.Replace('-', '+').Replace('_', '/')
  switch ($t.Length % 4) { 2 { $t += '==' } 3 { $t += '=' } }
  return [Convert]::FromBase64String($t)
}

# Verify SHA256SUMS against SHA256SUMS.sig, require the commit line for this tag,
# return the SHA-256 of $Name. Throws on any failure.
function Get-ReleaseSum([byte[]]$Sums, [string]$SigText, [string]$Name, [string]$Tag, [string]$PubB64Url) {
  $sig = [Convert]::FromBase64String($SigText.Trim())
  if (-not (Test-Ed25519 (From-Base64Url $PubB64Url) $Sums $sig)) { Fail 'SHA256SUMS: bad signature' }
  $lines = ([Text.Encoding]::UTF8.GetString($Sums) -split "`n") | ForEach-Object { $_.Trim() }
  $tagOk = $false
  foreach ($l in $lines) { if ($l -cmatch '^commit [0-9a-f]{40} (\S+)$' -and $Matches[1] -ceq $Tag) { $tagOk = $true } }
  if (-not $tagOk) { Fail "SHA256SUMS: no commit line for $Tag" }
  foreach ($l in $lines) { if ($l -cmatch '^([0-9a-f]{64}) [ *](.+)$' -and $Matches[2] -ceq $Name) { return $Matches[1] } }
  Fail "SHA256SUMS: no entry for $Name"
}

# ---------------------------------------------------------------- platform
function Get-PlatformInfo {
  $os = 'windows'
  if ($env:QUETZALCOATL_OS) { $os = $env:QUETZALCOATL_OS }
  $raw = $env:QUETZALCOATL_ARCH
  if (-not $raw) {
    $vals = @()
    $vals += [string]$env:PROCESSOR_ARCHITEW6432
    $vals += [string]$env:PROCESSOR_ARCHITECTURE
    try {
      $a = (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1).Architecture
      if ($a -eq 12) { $vals += 'ARM64' } elseif ($a -eq 9) { $vals += 'AMD64' }
    } catch { }
    if ($vals -contains 'ARM64') { $raw = 'arm64' } elseif ($vals -contains 'AMD64') { $raw = 'x64' }
  }
  switch ($raw) {
    'arm64' { $arch = 'arm64' }
    'aarch64' { $arch = 'arm64' }
    'x64' { $arch = 'x64' }
    'amd64' { $arch = 'x64' }
    'x86_64' { $arch = 'x64' }
    default { Fail "no official builds for CPU architecture: '$raw' (supported: x64, arm64)" }
  }
  $script:OS = $os
  $script:Arch = $arch
  # The real release contains .exe files. A non-Windows host only happens in the
  # cross-platform test harness, which ships a POSIX stub instead.
  if ($env:OS -eq 'Windows_NT') { $script:ExeSuffix = '.exe' } else { $script:ExeSuffix = '' }
}

function Resolve-InstallRoot {
  if (-not $Prefix) {
    if ($env:LOCALAPPDATA) { $Prefix = Join-Path $env:LOCALAPPDATA 'Quetzalcoatl' }
    elseif ($env:USERPROFILE) { $Prefix = Join-Path $env:USERPROFILE 'AppData\Local\Quetzalcoatl' }
    else { Fail 'cannot determine %LOCALAPPDATA%; pass -Prefix' }
  }
  $script:InstallRoot = [IO.Path]::GetFullPath($Prefix)
  if ($env:QUETZALCOATL_HOME) { $script:QzHome = [IO.Path]::GetFullPath($env:QUETZALCOATL_HOME) }
  else { $script:QzHome = $script:InstallRoot }
  $script:BinDir = Join-Path $script:InstallRoot 'bin'
  $script:ServiceDir = Join-Path $script:InstallRoot 'service'
}

# ---------------------------------------------------------------- download
function Invoke-Download([string]$Url, [string]$OutFile, [int]$TimeoutSec = 300) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -TimeoutSec $TimeoutSec
}

function Get-LatestVersion {
  $urls = @("$script:Site/api/releases/latest", "https://api.github.com/repos/$($script:Repo)/releases/latest")
  foreach ($url in $urls) {
    try {
      $res = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 20 -Headers @{ Accept = 'application/json' }
      $json = $res.Content | ConvertFrom-Json
      $tag = [string]$json.tag_name
      if ($tag) { return $tag.TrimStart('v') }
    } catch { }
  }
  Fail 'could not determine the latest version; pass -Version X.Y.Z'
}

function Get-ReleaseBases([string]$Tag) {
  if ($env:QUETZALCOATL_RELEASE_BASE) { return @($env:QUETZALCOATL_RELEASE_BASE -split '\s+' | Where-Object { $_ }) }
  return @("$script:Site/dl/$Tag", "https://github.com/$($script:Repo)/releases/download/$Tag")
}

function Get-VerifiedRelease([string]$Tag, [string]$AssetName, [string]$TempDir) {
  $sums = Join-Path $TempDir 'SHA256SUMS'
  $sig = Join-Path $TempDir 'SHA256SUMS.sig'
  $asset = Join-Path $TempDir $AssetName
  $pub = $script:ReleasePubKey
  if ($env:QUETZALCOATL_TEST_RELEASE_PUBKEY) {
    # Test-only key override: it must be opened explicitly so a stray environment
    # variable cannot silently replace the production trust root.
    if ($env:QUETZALCOATL_ALLOW_TEST_PUBKEY -ne '1') {
      Fail 'QUETZALCOATL_TEST_RELEASE_PUBKEY is for tests only; set QUETZALCOATL_ALLOW_TEST_PUBKEY=1 to use it'
    }
    $pub = $env:QUETZALCOATL_TEST_RELEASE_PUBKEY
  }
  foreach ($base in (Get-ReleaseBases $Tag)) {
    Write-Note "source: $base"
    foreach ($f in @($sums, $sig, $asset)) { if (Test-Path $f) { Remove-Item $f -Force } }
    try {
      Invoke-Download "$base/SHA256SUMS" $sums 60
      Invoke-Download "$base/SHA256SUMS.sig" $sig 60
      $sumsBytes = [IO.File]::ReadAllBytes($sums)
      $sigText = [IO.File]::ReadAllText($sig)
      $expected = Get-ReleaseSum $sumsBytes $sigText $AssetName $Tag $pub
      Write-Ok 'SHA256SUMS signature verified'
    } catch {
      Write-Warn "signed manifest unavailable or untrusted at $base ($($_.Exception.Message))"
      continue
    }
    try { Invoke-Download "$base/$AssetName" $asset 900 } catch { Write-Warn "download failed at $base"; continue }
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $asset).Hash.ToLowerInvariant()
    if ($got -ne $expected) { Write-Warn "$AssetName sha256 mismatch (got $got, signed $expected)"; continue }
    Write-Ok "sha256 verified: $AssetName"
    return $asset
  }
  Fail "no trusted source could provide $AssetName"
}

# ---------------------------------------------------------------- service
function Set-TaskPlan {
  $tasks = @(
    @{ fullName = "$($script:TaskPath)$($script:BootTask)"; trigger = 'AtStartup'; argument = 'up'; runLevel = 'Limited' },
    @{ fullName = "$($script:TaskPath)$($script:LogonTask)"; trigger = 'AtLogOn'; argument = 'up'; runLevel = 'Limited' }
  )
  New-Item -ItemType Directory -Path $script:ServiceDir -Force | Out-Null
  $plan = @{ tasks = $tasks; executable = (Join-Path $script:BinDir ("quetzalcoatld" + $script:ExeSuffix)) }
  $json = $plan | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $script:ServiceDir 'tasks.json'), $json)
  if ($env:QUETZALCOATL_SKIP_TASKS -eq '1') { Write-Note 'QUETZALCOATL_SKIP_TASKS=1: task plan written, tasks not registered'; return }
  if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    Write-Warn "Register-ScheduledTask is unavailable; register $($script:TaskPath) manually"
    return
  }
  $exe = Join-Path $script:BinDir ("quetzalcoatld" + $script:ExeSuffix)
  foreach ($t in $tasks) {
    try {
      $action = New-ScheduledTaskAction -Execute $exe -Argument $t.argument
      $trigger = if ($t.trigger -eq 'AtStartup') { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn }
      $principal = New-ScheduledTaskPrincipal -UserId ([string]$env:USERNAME) -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $t.fullName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
      Write-Ok "task registered: $($t.fullName)"
    } catch {
      Write-Warn "could not register $($t.fullName): $($_.Exception.Message)"
      Write-Warn "run manually: Register-ScheduledTask -TaskName '$($t.fullName)' -Action (New-ScheduledTaskAction -Execute '$exe' -Argument 'up')"
    }
  }
}

function Remove-TaskPlan {
  $planFile = Join-Path $script:ServiceDir 'tasks.json'
  if ($env:QUETZALCOATL_SKIP_TASKS -ne '1' -and (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue)) {
    foreach ($name in @("$($script:TaskPath)$($script:BootTask)", "$($script:TaskPath)$($script:LogonTask)")) {
      try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch { }
    }
  }
  if (Test-Path $planFile) { Remove-Item $planFile -Force }
}

# ---------------------------------------------------------------- health / rollback
function Test-Health([string]$ExpectedVersion) {
  $exe = Join-Path $script:BinDir ("qz" + $script:ExeSuffix)
  if (-not (Test-Path $exe)) { return $false }
  try {
    if ($env:OS -eq 'Windows_NT') { $out = & $exe --version 2>&1 }
    else { $out = & bash $exe --version 2>&1 }
    if ($LASTEXITCODE -ne 0) { return $false }
    return ([string]($out | Out-String)) -match [regex]::Escape($ExpectedVersion)
  } catch { return $false }
}

function Backup-Current {
  $backup = Join-Path $script:ServiceDir 'backup'
  if (Test-Path $script:BinDir) {
    if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -Recurse -Force $script:BinDir (Join-Path $backup 'bin')
    $record = Join-Path $script:ServiceDir 'installed-version'
    if (Test-Path $record) { Copy-Item -Force $record (Join-Path $backup 'installed-version') }
    Write-Note 'previous version kept aside for rollback'
  }
}

function Restore-Backup {
  $backup = Join-Path $script:ServiceDir 'backup'
  if (-not (Test-Path (Join-Path $backup 'bin'))) { return $false }
  if (Test-Path $script:BinDir) { Remove-Item -Recurse -Force $script:BinDir }
  Copy-Item -Recurse -Force (Join-Path $backup 'bin') $script:BinDir
  $old = Join-Path $backup 'installed-version'
  if (Test-Path $old) { Copy-Item -Force $old (Join-Path $script:ServiceDir 'installed-version') }
  return $true
}

# ---------------------------------------------------------------- install
function Install-Qz {
  Get-PlatformInfo
  Resolve-InstallRoot
  if (-not $Version) { $Version = Get-LatestVersion }
  $Version = $Version.TrimStart('v')
  if ($Version -notmatch '^[0-9][0-9A-Za-z.\-]*$') { Fail "invalid version: $Version" }
  $tag = "v$Version"
  $assetName = "$($script:Brand)-$Version-$($script:OS)-$($script:Arch).zip"

  Write-Step 'Quetzalcoatl installer'
  Write-Note "version  $Version"
  Write-Note "platform $($script:OS) $($script:Arch)"
  Write-Note "prefix   $($script:InstallRoot)"

  $temp = Join-Path ([IO.Path]::GetTempPath()) ("quetzalcoatl-" + [Guid]::NewGuid().ToString('n').Substring(0, 12))
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  try {
    Write-Step 'Download the signed release'
    $zip = Get-VerifiedRelease $tag $assetName $temp
    $stage = Join-Path $temp 'stage'
    Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
    $stagedBin = Join-Path $stage 'bin'
    if (-not (Test-Path $stagedBin)) { Fail 'unexpected archive layout: bin/ missing' }

    $fresh = (-not (Test-Path $script:BinDir)) -or (@(Get-ChildItem -LiteralPath $script:BinDir -Force -ErrorAction SilentlyContinue).Count -eq 0)
    Backup-Current
    New-Item -ItemType Directory -Path $script:BinDir -Force | Out-Null
    $copied = @(Get-ChildItem -LiteralPath $stagedBin)
    $copied | ForEach-Object {
      Copy-Item -Force $_.FullName (Join-Path $script:BinDir $_.Name)
    }

    Write-Step 'Health check'
    if (-not (Test-Health $Version)) {
      if (Restore-Backup) {
        Write-Warn 'the new version did not pass its health check; rolled back'
        Fail "quetzalcoatl $Version failed its health check (qz --version); the previous version was restored"
      }
      foreach ($file in $copied) {
        $target = Join-Path $script:BinDir $file.Name
        if (Test-Path -LiteralPath $target) { Remove-Item -Force -LiteralPath $target }
      }
      if ($fresh) { Remove-Item -Recurse -Force $script:BinDir -ErrorAction SilentlyContinue }
      if ($fresh) {
        Fail "quetzalcoatl $Version failed its health check (qz --version); this first install was removed and nothing is active"
      }
      Fail "quetzalcoatl $Version failed its health check (qz --version); the files this run wrote were removed"
    }
    Write-Ok "qz $Version responds"

    New-Item -ItemType Directory -Path $script:ServiceDir -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $script:ServiceDir 'installed-version'), "$Version`r`n")
    Set-TaskPlan
    if (-not (Test-Path $script:QzHome)) { New-Item -ItemType Directory -Path $script:QzHome -Force | Out-Null }

    Write-Step 'Installed'
    Write-Ok "Quetzalcoatl $Version"
    Write-Note "add $($script:BinDir) to PATH, then run: qz up"
    Write-Note "docs: $($script:Site)/docs/start/install"
  } finally {
    if (Test-Path $temp) { Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
  }
}

# Canonical absolute path: normalise separators, drop a trailing separator.
function Get-CanonicalPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  while ($full.Length -gt $root.Length -and ($full.EndsWith([string][IO.Path]::DirectorySeparatorChar) -or $full.EndsWith([string][IO.Path]::AltDirectorySeparatorChar))) {
    $full = $full.Substring(0, $full.Length - 1)
  }
  return $full
}

# -Purge guard: refuse empty paths, drive roots, HOME itself, ancestors of HOME,
# and symlinks / reparse points (a link to HOME must not be followed).
function Assert-PurgeSafe([string]$Path) {
  if (-not $Path) { Fail 'refusing to purge an empty path' }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($item) {
    if ($item.LinkType) { Fail "refusing to purge $Path`: it is a symlink" }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "refusing to purge $Path`: it is a symlink or reparse point"
    }
  }
  $canon = Get-CanonicalPath $Path
  $homeCanon = Get-CanonicalPath $HOME
  $rootCanon = [IO.Path]::GetPathRoot($canon)
  if ($canon -eq $rootCanon) { Fail "refusing to purge $canon" }
  if ($canon -eq $homeCanon) { Fail "refusing to purge $Path`: it resolves to your home directory" }
  $sep = [string][IO.Path]::DirectorySeparatorChar
  if ($homeCanon.StartsWith($canon + $sep, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "refusing to purge $Path`: it is an ancestor of your home directory"
  }
  return $canon
}

function Uninstall-Qz {
  Get-PlatformInfo
  Resolve-InstallRoot
  Write-Step 'Removing Quetzalcoatl'
  Remove-TaskPlan
  if (Test-Path $script:BinDir) {
    Get-ChildItem -LiteralPath $script:BinDir | ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
    Remove-Item -Recurse -Force $script:BinDir -ErrorAction SilentlyContinue
  }
  $record = Join-Path $script:ServiceDir 'installed-version'
  if (Test-Path $record) { Remove-Item -Force $record }
  $backup = Join-Path $script:ServiceDir 'backup'
  if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
  Write-Ok 'tasks, binaries and service state removed'

  if ($Purge) {
    $full = Assert-PurgeSafe $script:QzHome
    if (Test-Path -LiteralPath $full) {
      Remove-Item -Recurse -Force -LiteralPath $full
      Write-Ok "purged $full (spine, memory, settings)"
    } else {
      Write-Note "$full does not exist"
    }
  } else {
    Write-Note "kept $($script:QzHome) (add -Purge to remove your spine, memory and settings)"
  }
}

function Invoke-QzMain {
  Get-PlatformInfo
  if ($PrintPlatform) { Write-Output "$($script:OS) $($script:Arch)"; return }
  Resolve-InstallRoot
  if ($Uninstall) { Uninstall-Qz; return }
  Install-Qz
}

try {
  Invoke-QzMain
} catch {
  Write-Host ("x " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
