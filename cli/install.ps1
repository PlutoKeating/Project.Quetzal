# Quetzal one-line installer for Windows:  irm https://quetzal.plutokeating.beer/install.ps1 | iex
#
# This file is GENERATED from cli/windows/install.src.ps1 by cli/windows/gen-install-ps1.mjs; edit the source, not this file.
#
# What it does: checks this computer (Windows 10 1809+, the real CPU architecture even under x64 emulation on ARM),
# Smart App Control, downloads SHA256SUMS + SHA256SUMS.sig of the release, verifies the Ed25519 signature with the
# public key below (implemented here: Windows PowerShell 5.1 / .NET Framework have no Ed25519), checks the setup.exe
# SHA-256 against the signed list, and runs it silently. Same download sources as cli/install.sh: the website mirror
# (/dl/<tag>/<file>, /api/releases/latest) first, then GitHub directly; the signature is the root of trust.
#
# Settings (environment variables; iex cannot pass arguments):
#   QUETZAL_VERSION=X.Y.Z   install this version (default: the latest release)
#   QUETZAL_LANG=zh|en      interface language (default: the Windows display language)
#   QUETZAL_YES=1           do not ask before closing a running Quetzal
#   QUETZAL_UPGRADE=1       upgrade started from the console: silent, no questions, running Quetzal may be closed;
#                           output goes to %LOCALAPPDATA%\Quetzal\home\logs\upgrade.log; QUETZAL_UPGRADE_ID names the run
# Pure ASCII (Chinese text is UTF-8 base64, decoded at run time): Windows PowerShell 5.1 reads scripts in the ANSI code page.
# All logic is inside functions and the last line calls Install-Quetzal, so a truncated download runs nothing.

$QuetzalReleasePubKey = 'QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8'   # Ed25519, raw 32 bytes, base64url (same as cli/install.sh)
$QuetzalSite = 'https://quetzal.plutokeating.beer'
$QuetzalRepo = 'PlutoKeating/Project.Quetzal'

function Z([string]$b64) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
function T([string]$zh, [string]$en) { if ($script:QzZh) { return $zh } else { return $en } }

# ---------------------------------------------------------------- output (and the upgrade log the console reads)
function Emit([string]$mark, [string]$text, [string]$color) {
  Write-Host ("$mark " + $text) -ForegroundColor $color
  if ($script:QzLog) { try { [IO.File]::AppendAllText($script:QzLog, "$mark $text`n", (New-Object Text.UTF8Encoding $false)) } catch { } }
}
function Step([string]$t) { Emit ([string][char]0x25B8) $t 'Cyan' }
function Ok([string]$t) { Emit ([string][char]0x2713) $t 'Green' }
function Note([string]$t) { Emit '!' $t 'Yellow' }
function Bad([string]$t) { Emit ([string][char]0x2717) $t 'Red' }
# Start / end lines of one run in upgrade.log, parsed by the runtime (runtime/adapters/linux/upgrade.ts parseUpgradeLog).
function Upgrade-StartLine([string]$id, [string]$target, [string]$time) {
  $t = ''
  if ($target) { $t = (Z '77yI55uu5qCHIA==') + $target + (Z '77yJ') }
  return (Z 'PT0g5Y2H57qnIA==') + $id + (Z 'IOW8gOWniyA=') + $time + $t
}
function Upgrade-EndLine([string]$id, [int]$code) { return (Z 'PT0g5Y2H57qnIA==') + $id + (Z 'IOmAgOWHuueggSA=') + $code }
function LogLine([string]$line) { if ($script:QzLog) { try { [IO.File]::AppendAllText($script:QzLog, "$line`n", (New-Object Text.UTF8Encoding $false)) } catch { } } }

# ---------------------------------------------------------------- Ed25519 verification (RFC 8032, cofactorless), System.Numerics.BigInteger
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
function Ed-Mod($x) { $r = [System.Numerics.BigInteger]::Remainder($x, $script:EdP); if ($r.Sign -lt 0) { $r = [System.Numerics.BigInteger]::Add($r, $script:EdP) }; return $r }
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
  $e = Ed-Mod ($B::Subtract($b, $a)); $f = Ed-Mod ($B::Subtract($d, $c)); $g = Ed-Mod ($B::Add($d, $c)); $h = Ed-Mod ($B::Add($b, $a))
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

# True when $sig (64 bytes) is a valid Ed25519 signature of $msg by $pub (32 bytes).
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

# Signed release list: verify SHA256SUMS against SHA256SUMS.sig, require the "commit <sha> <tag>" line for this tag,
# return the SHA-256 of $name. Throws on any failure.
function Get-ReleaseSum([byte[]]$sums, [string]$sigText, [string]$name, [string]$tag, [string]$pubB64Url) {
  $sig = [Convert]::FromBase64String($sigText.Trim())
  if (-not (Test-Ed25519 (From-Base64Url $pubB64Url) $sums $sig)) { throw 'SHA256SUMS: bad signature' }
  $lines = ([Text.Encoding]::UTF8.GetString($sums) -split "`n") | ForEach-Object { $_.Trim() }
  $tagOk = $false
  foreach ($l in $lines) { if ($l -cmatch '^commit [0-9a-f]{40} (\S+)$' -and $Matches[1] -ceq $tag) { $tagOk = $true } }
  if (-not $tagOk) { throw "SHA256SUMS: no commit line for $tag" }
  foreach ($l in $lines) { if ($l -cmatch '^([0-9a-f]{64}) [ *](.+)$' -and $Matches[2] -ceq $name) { return $Matches[1] } }
  throw "SHA256SUMS: no entry for $name"
}

# ---------------------------------------------------------------- this computer
# The real CPU: an x64 PowerShell emulated on ARM64 reports AMD64 in its own environment, but not in the registry or WMI.
function Get-NativeArch {
  $vals = @()
  try { $vals += [string](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE } catch { }
  try { $a = (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1).Architecture; if ($a -eq 12) { $vals += 'ARM64' } elseif ($a -eq 9) { $vals += 'AMD64' } } catch { }
  $vals += [string]$env:PROCESSOR_ARCHITEW6432; $vals += [string]$env:PROCESSOR_ARCHITECTURE
  if ($vals -contains 'ARM64') { return 'arm64' }
  if ($vals -contains 'AMD64') { return 'x64' }
  return ''
}

# Smart App Control: 0 off, 1 on (blocks unsigned programs such as Quetzal's), 2 evaluation, -1 not present.
function Get-SacState {
  try { return [int](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction Stop).VerifiedAndReputablePolicyState } catch { return -1 }
}

function Get-QuetzalRunning([string]$root) {
  $rt = (Join-Path $root 'runtime\').ToLowerInvariant(); $cs = (Join-Path $root 'console\').ToLowerInvariant()
  $n = 0
  foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
    $exe = ([string]$p.ExecutablePath).ToLowerInvariant(); $cmd = ([string]$p.CommandLine).ToLowerInvariant()
    if (($exe -and ($exe.StartsWith($rt) -or $exe.StartsWith($cs))) -or ($cmd -and $cmd.Contains($rt))) { $n++ }
  }
  return $n
}

function Fetch([string]$url, [string]$out, [int]$timeout) {
  try {
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec $timeout -Headers @{ 'User-Agent' = 'quetzal-install-ps1' } -ErrorAction Stop
    return $true
  } catch { return $false }
}

function Get-LatestTag {
  foreach ($u in @("$QuetzalSite/api/releases/latest", "https://api.github.com/repos/$QuetzalRepo/releases/latest")) {
    try {
      $r = Invoke-RestMethod -Uri $u -UseBasicParsing -TimeoutSec 20 -Headers @{ 'User-Agent' = 'quetzal-install-ps1'; 'Accept' = 'application/vnd.github+json' } -ErrorAction Stop
      if ([string]$r.tag_name -match '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { return [string]$r.tag_name }
    } catch { }
  }
  return ''
}

function Wait-SacOff([bool]$interactive) {
  $s = Get-SacState
  if ($s -eq 2) {
    Note (T (Z '5pm66IO95bqU55So5o6n5Yi25aSE5LqO44CM6K+E5Lyw44CN5qih5byP77yaV2luZG93cyDku6XlkI7lj6/og73oh6rliqjmiorlroPmiZPlvIDvvIzpgqPml7bkvJrmi6bkuIsgUXVldHphbCDov5jmsqHmnInku6PnoIHnrb7lkI3nmoTnqIvluo/jgILlu7rorq7lnKjjgIxXaW5kb3dzIOWuieWFqOS4reW/gyDigLog5bqU55So5ZKM5rWP6KeI5Zmo5o6n5Yi2IOKAuiDmmbrog73lupTnlKjmjqfliLborr7nva7jgI3ph4zlhbPpl63jgII=') 'Smart App Control is in evaluation mode: Windows may turn it on later, and then it would block Quetzal''s not-yet-code-signed programs. Consider turning it off in Windows Security > App & browser control > Smart App Control settings.')
    return $true
  }
  if ($s -ne 1) { return $true }
  Bad (T (Z '5pm66IO95bqU55So5o6n5Yi25bey5omT5byA77ya5a6D5Lya5oum5LiLIFF1ZXR6YWwg6L+Y5rKh5pyJ5Luj56CB562+5ZCN55qE56iL5bqP77yI5o6n5Yi25Y+w44CB5ZG95Luk5rKZ566x44CB5aSa5YW36Lqr5L2T55u06L+e55qE57uE5Lu277yJ77yM6KOF5LiK5Lmf55So5LiN5LqG44CC') 'Smart App Control is on: it blocks Quetzal''s programs that are not code-signed yet (console, command sandbox, the multi-body connection module), so Quetzal would not work.')
  if (-not $interactive) { Bad (T (Z '6ZyA6KaB5Zyo6L+Z5Y+w55S16ISR5LiK5YWz6Zet5pm66IO95bqU55So5o6n5Yi25ZCO77yM5YaN6L+Q6KGM5LiA5qyh5a6J6KOF44CC') 'Turn off Smart App Control on this computer, then run the installer once.'); return $false }
  Write-Host (T (Z '6K+35Zyo5o6l5LiL5p2l5omT5byA55qE44CMV2luZG93cyDlronlhajkuK3lv4Mg4oC6IOW6lOeUqOWSjOa1j+iniOWZqOaOp+WItiDigLog5pm66IO95bqU55So5o6n5Yi26K6+572u44CN6YeM6YCJ44CM5YWz6Zet44CN44CC5rOo5oSP77ya5Zyo6YOo5YiGIFdpbmRvd3Mg54mI5pys5LiK77yM5YWz6Zet5ZCO6KaB6YeN6KOF57O757uf5omN6IO95YaN5omT5byA44CC5YWz6Zet5ZCO6L+Z6YeM5Lya6Ieq5Yqo57un57ut77yIQ3RybCtDIOmAgOWHuu+8ieOAgg==') 'In Windows Security > App & browser control > Smart App Control settings, which opens next, choose Off. Note: on some Windows versions it can only be turned back on by reinstalling Windows. This installer continues by itself once it is off (Ctrl+C to quit).')
  try { Start-Process 'windowsdefender://appbrowser/' } catch { }
  while ((Get-SacState) -eq 1) { Start-Sleep -Seconds 2 }
  Ok (T (Z '5pm66IO95bqU55So5o6n5Yi25bey5YWz6Zet') 'Smart App Control is off')
  return $true
}

function Explain-Setup([int]$code) {
  switch ($code) {
    3 { return (T (Z 'UXVldHphbCDmraPlnKjov5DooYzvvIzmsqHmnInlkIzmhI/lhbPpl63vvIzmiYDku6XmsqHmnInlronoo4XjgII=') 'Quetzal is running and closing it was not agreed, so nothing was installed.') }
    4 { return (T (Z '5pyJIFF1ZXR6YWwg6L+b56iL5YWz5LiN5o6J44CC6K+36YeN5ZCv55S16ISR5ZCO5YaN6L+Q6KGM5a6J6KOF44CC') 'Some Quetzal processes could not be closed. Restart the computer and run the installer again.') }
    5 { return (T (Z '6L+Z5Y+w55S16ISR55qE57O757uf5oiW5aSE55CG5Zmo5LiN56ym5ZCI6KaB5rGC44CC') 'This computer''s Windows version or processor is not supported.') }
    13 { return (T (Z 'Tm9kZS5qcyDmsqHmnInoo4XkuIrvvIxRdWV0emFsIOaXoOazlei/kOihjOOAgg==') 'Node.js could not be installed, so Quetzal cannot run.') }
    14 { return (T (Z '6ZyA6KaB5Zyo6L+Z5Y+w55S16ISR5LiK6L+Q6KGM5LiA5qyh5a6J6KOF77yI6L+Z5LiA5q2l6ZyA6KaB566h55CG5ZGY5p2D6ZmQ77yJ44CC') 'Run the installer once on this computer (this step needs administrator permission).') }
    20 { return (T (Z '5paw54mI5pys5rKh5pyJ5ZyoIDQwIOenkuWGheato+W4uOWTjeW6lO+8jOW3sumAgOWbnuS4iuS4gOeJiOOAgg==') 'The new version did not respond within 40 seconds; the previous version was restored.') }
    21 { return (T (Z 'UXVldHphbCDmsqHmnInlnKggNDAg56eS5YaF5ZON5bqU44CC') 'Quetzal did not respond within 40 seconds.') }
    default { return ((T (Z '5a6J6KOF56iL5bqP5Lul6YCA5Ye656CBIHswfSDnu5PmnZ/jgII=') 'The installer ended with exit code {0}.') -f $code) }
  }
}

function Install-Core {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest many times slower in Windows PowerShell 5.1
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  $upgrade = $env:QUETZAL_UPGRADE -eq '1'
  $interactive = (-not $upgrade) -and [Environment]::UserInteractive

  if ($PSVersionTable.PSVersion.Major -lt 5) { Bad (T (Z '6ZyA6KaBIFdpbmRvd3MgUG93ZXJTaGVsbCA1LjEg5oiW5pu05paw44CC') 'Windows PowerShell 5.1 or newer is required.'); return 5 }
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Bad (T (Z '6L+Z5Liq6ISa5pys5Y+q55So5LqOIFdpbmRvd3PjgIJMaW51eCDor7fnlKjvvJpjdXJsIC1mc1NMIGh0dHBzOi8vcXVldHphbC5wbHV0b2tlYXRpbmcuYmVlci9pbnN0YWxsIHwgYmFzaA==') 'This script is for Windows. On Linux use: curl -fsSL https://quetzal.plutokeating.beer/install | bash'); return 5 }
  $build = [Environment]::OSVersion.Version.Build
  if ([Environment]::OSVersion.Version.Major -lt 10 -or $build -lt 17763) { Bad (T (Z 'UXVldHphbCDpnIDopoEgV2luZG93cyAxMCAxODA5IOaIluabtOaWsOeahOeJiOacrOOAgg==') 'Quetzal needs Windows 10 version 1809 or later.'); return 5 }
  $arch = Get-NativeArch
  if (-not $arch) { Bad (T (Z '5LiN5pSv5oyBIDMyIOS9jSBXaW5kb3dz44CC') '32-bit Windows is not supported.'); return 5 }
  Ok ((T (Z 'V2luZG93cyB7MH3vvIh7MX3vvIk=') 'Windows {0} ({1})') -f $build, $arch)

  if (-not (Wait-SacOff $interactive)) { return 6 }

  $root = Join-Path $env:LOCALAPPDATA 'Quetzal'
  $close = $upgrade -or ($env:QUETZAL_YES -eq '1')
  if (-not $close) {
    $n = Get-QuetzalRunning $root
    if ($n -gt 0) {
      if (-not $interactive) { $close = $true }
      else {
        $a = Read-Host (T (Z 'UXVldHphbCDmraPlnKjov5DooYzvvJrlronoo4Xml7bkvJrlhYjlhbPmjonlroPvvIjlh6Dnp5Lpkp/vvInvvIzoo4Xlpb3lkI7oh6rliqjph43mlrDlkK/liqjjgILnu6fnu63lkJfvvJ9bWS9uXQ==') 'Quetzal is running: it will be closed for a few seconds and started again after the installation. Continue? [Y/n]')
        if ($a -and $a -notmatch '^[Yy]') { Note (T (Z '5rKh5pyJ5a6J6KOF44CC') 'Nothing was installed.'); return 3 }
        $close = $true
      }
    }
  }

  $tag = ''
  if ($env:QUETZAL_VERSION) {
    $v = $env:QUETZAL_VERSION.Trim().TrimStart('v')
    if ($v -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { Bad ((T (Z '54mI5pys5Y+35LiN5a+577yaezB9') 'Not a version: {0}') -f $v); return 2 }
    $tag = "v$v"
  } else {
    Step (T (Z '5p+l5om+5pyA5paw54mI5pys') 'Looking up the latest version')
    $tag = Get-LatestTag
    if (-not $tag) { Bad (T (Z '5p+l5LiN5Yiw5pyA5paw54mI5pys77yI572R57uc5LiN6YCa77yf77yJ44CC') 'Could not look up the latest version (no network?).'); return 7 }
  }
  $v = $tag.Substring(1)
  $name = "quetzal-$v-windows-$arch-setup.exe"
  $bases = @("$QuetzalSite/dl/$tag", "https://github.com/$QuetzalRepo/releases/download/$tag")

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('quetzal-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Step ((T (Z '5qC45a+5IHswfSDnmoTlj5HluIPnrb7lkI0=') 'Verifying the release signature of {0}') -f $tag)
    $want = ''
    foreach ($b in $bases) {
      if (-not (Fetch "$b/SHA256SUMS" (Join-Path $tmp 'SHA256SUMS') 60)) { continue }
      if (-not (Fetch "$b/SHA256SUMS.sig" (Join-Path $tmp 'SHA256SUMS.sig') 60)) { continue }
      try {
        $want = Get-ReleaseSum ([IO.File]::ReadAllBytes((Join-Path $tmp 'SHA256SUMS'))) ([IO.File]::ReadAllText((Join-Path $tmp 'SHA256SUMS.sig'))) $name $tag $QuetzalReleasePubKey
        break
      } catch { $want = ''; LogLine ("$b " + $_.Exception.Message) }
    }
    if (-not $want) { Bad ((T (Z 'ezB9IOayoeaciemAmui/h+etvuWQjeaguOWvueeahCBXaW5kb3dzIOWuieijheWMhe+8iHsxfe+8ieOAgg==') 'No signature-verified Windows installer for {0} ({1}).') -f $tag, $name); return 8 }
    Ok (T (Z '5Y+R5biD562+5ZCN5pyJ5pWI') 'Release signature is valid')

    Step ((T (Z '5LiL6L29IHswfQ==') 'Downloading {0}') -f $name)
    $exe = Join-Path $tmp $name
    $got = $false
    foreach ($b in $bases) {
      if ((Fetch "$b/$name" $exe 1800) -and ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -eq $want)) { $got = $true; break }
      Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    }
    if (-not $got) { Bad (T (Z '5LiL6L295aSx6LSl77yM5oiW5paH5Lu25LiO562+5ZCN5riF5Y2V6YeM55qEIFNIQS0yNTYg5LiN56ym44CC') 'The download failed, or the file does not match the SHA-256 in the signed list.'); return 9 }
    Ok (T (Z '5a6J6KOF5YyF5LiO562+5ZCN5riF5Y2V55u456ym') 'The installer matches the signed list')

    Step (T (Z '5a6J6KOF77yI5Lit6YCUIFdpbmRvd3Mg5Y+v6IO96K+35rGC5LiA5qyh566h55CG5ZGY5p2D6ZmQ77yJ') 'Installing (Windows may ask once for administrator permission)')
    $argv = @('/S')
    if ($close) { $argv += '/CLOSEAPPS' }
    if ($upgrade) { $argv += '/UPGRADE' } else { $argv += '/OPEN' }
    $p = Start-Process -FilePath $exe -ArgumentList $argv -Wait -PassThru
    $code = [int]$p.ExitCode
    if ($code -ne 0) { Bad (Explain-Setup $code); Bad ((T (Z '6K+m5oOF77yaezB9') 'Details: {0}') -f (Join-Path $root 'install.log')); return $code }
    Ok ((T (Z 'UXVldHphbCB7MH0g5bey6KOF5aW9') 'Quetzal {0} is installed') -f $v)
    if (-not $upgrade) { Write-Host (T (Z '5o6n5Yi25Y+w5bey57uP5omT5byA44CC5paw5byA55qE57uI56uv6YeM5Y+v5Lul55SoIHF1ZXR6YWwgc3RhdHVzIOafpeeci+eKtuaAgeOAgg==') 'The console is open. In a new terminal, quetzal status shows the state.') }
    return 0
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-Quetzal {
  $lang = [string]$env:QUETZAL_LANG
  if (-not $lang) { try { $lang = (Get-UICulture).Name } catch { $lang = '' } }
  $script:QzZh = $lang -like 'zh*'
  $script:QzLog = $null
  $upgrade = $env:QUETZAL_UPGRADE -eq '1'
  $id = [string]$env:QUETZAL_UPGRADE_ID
  if ($upgrade) {
    if ($id -notmatch '^[0-9]+$') { $id = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $logs = Join-Path $env:LOCALAPPDATA 'Quetzal\home\logs'
    try { New-Item -ItemType Directory -Path $logs -Force | Out-Null; $script:QzLog = Join-Path $logs 'upgrade.log' } catch { }
    $target = ''
    if ($env:QUETZAL_VERSION) { $target = $env:QUETZAL_VERSION.Trim().TrimStart('v') }
    LogLine (Upgrade-StartLine $id $target ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')))
  }
  $code = 1
  try { $code = [int](Install-Core) } catch { Bad ([string]$_.Exception.Message); $code = 1 }
  if ($upgrade) {
    LogLine (Upgrade-EndLine $id $code)
    exit $code   # powershell -Command "irm ... | iex": the exit code reaches the console's runtime
  }
  # Interactive irm | iex: never exit (it would close the window); leave the code in $LASTEXITCODE.
  $global:LASTEXITCODE = $code
}

if ($env:QUETZAL_PS1_LIB -ne '1') { Install-Quetzal }
