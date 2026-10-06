# Quetzal one-line installer for Windows:  irm https://quetzal.plutokeating.beer/install.ps1 | iex
#
# GENERATED-HEADER
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
  if ($target) { $t = '（目标 ' + $target + '）' }
  return '== 升级 ' + $id + ' 开始 ' + $time + $t
}
function Upgrade-EndLine([string]$id, [int]$code) { return '== 升级 ' + $id + ' 退出码 ' + $code }
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
    Note (T '智能应用控制处于「评估」模式：Windows 以后可能自动把它打开，那时会拦下 Quetzal 还没有代码签名的程序。建议在「Windows 安全中心 › 应用和浏览器控制 › 智能应用控制设置」里关闭。' 'Smart App Control is in evaluation mode: Windows may turn it on later, and then it would block Quetzal''s not-yet-code-signed programs. Consider turning it off in Windows Security > App & browser control > Smart App Control settings.')
    return $true
  }
  if ($s -ne 1) { return $true }
  Bad (T '智能应用控制已打开：它会拦下 Quetzal 还没有代码签名的程序（控制台、命令沙箱、多具身体直连的组件），装上也用不了。' 'Smart App Control is on: it blocks Quetzal''s programs that are not code-signed yet (console, command sandbox, the multi-body connection module), so Quetzal would not work.')
  if (-not $interactive) { Bad (T '需要在这台电脑上关闭智能应用控制后，再运行一次安装。' 'Turn off Smart App Control on this computer, then run the installer once.'); return $false }
  Write-Host (T '请在接下来打开的「Windows 安全中心 › 应用和浏览器控制 › 智能应用控制设置」里选「关闭」。注意：在部分 Windows 版本上，关闭后要重装系统才能再打开。关闭后这里会自动继续（Ctrl+C 退出）。' 'In Windows Security > App & browser control > Smart App Control settings, which opens next, choose Off. Note: on some Windows versions it can only be turned back on by reinstalling Windows. This installer continues by itself once it is off (Ctrl+C to quit).')
  try { Start-Process 'windowsdefender://appbrowser/' } catch { }
  while ((Get-SacState) -eq 1) { Start-Sleep -Seconds 2 }
  Ok (T '智能应用控制已关闭' 'Smart App Control is off')
  return $true
}

function Explain-Setup([int]$code) {
  switch ($code) {
    3 { return (T 'Quetzal 正在运行，没有同意关闭，所以没有安装。' 'Quetzal is running and closing it was not agreed, so nothing was installed.') }
    4 { return (T '有 Quetzal 进程关不掉。请重启电脑后再运行安装。' 'Some Quetzal processes could not be closed. Restart the computer and run the installer again.') }
    5 { return (T '这台电脑的系统或处理器不符合要求。' 'This computer''s Windows version or processor is not supported.') }
    13 { return (T 'Node.js 没有装上，Quetzal 无法运行。' 'Node.js could not be installed, so Quetzal cannot run.') }
    14 { return (T '需要在这台电脑上运行一次安装（这一步需要管理员权限）。' 'Run the installer once on this computer (this step needs administrator permission).') }
    20 { return (T '新版本没有在 40 秒内正常响应，已退回上一版。' 'The new version did not respond within 40 seconds; the previous version was restored.') }
    21 { return (T 'Quetzal 没有在 40 秒内响应。' 'Quetzal did not respond within 40 seconds.') }
    default { return ((T '安装程序以退出码 {0} 结束。' 'The installer ended with exit code {0}.') -f $code) }
  }
}

function Install-Core {
  $ErrorActionPreference = 'Stop'
# SHA-256（小写十六进制），直接用 .NET：从 PowerShell 7 启动的 Windows PowerShell 5.1 会继承 7 的 PSModulePath，Get-FileHash 这类模块里的命令可能找不到；
# 下面一行同理把模块路径改回 5.1 自己的
function Sha256Hex([string]$path) { $s = [IO.File]::OpenRead($path); try { $h = [Security.Cryptography.SHA256]::Create(); try { return (($h.ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $h.Dispose() } } finally { $s.Dispose() } }
if ($PSVersionTable.PSEdition -ne 'Core') { $env:PSModulePath = (@([IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'WindowsPowerShell', 'Modules'), [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')) -join ';') }
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest many times slower in Windows PowerShell 5.1
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  $upgrade = $env:QUETZAL_UPGRADE -eq '1'
  $interactive = (-not $upgrade) -and [Environment]::UserInteractive

  if ($PSVersionTable.PSVersion.Major -lt 5) { Bad (T '需要 Windows PowerShell 5.1 或更新。' 'Windows PowerShell 5.1 or newer is required.'); return 5 }
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Bad (T '这个脚本只用于 Windows。Linux 请用：curl -fsSL https://quetzal.plutokeating.beer/install | bash' 'This script is for Windows. On Linux use: curl -fsSL https://quetzal.plutokeating.beer/install | bash'); return 5 }
  $build = [Environment]::OSVersion.Version.Build
  if ([Environment]::OSVersion.Version.Major -lt 10 -or $build -lt 17763) { Bad (T 'Quetzal 需要 Windows 10 1809 或更新的版本。' 'Quetzal needs Windows 10 version 1809 or later.'); return 5 }
  $arch = Get-NativeArch
  if (-not $arch) { Bad (T '不支持 32 位 Windows。' '32-bit Windows is not supported.'); return 5 }
  Ok ((T 'Windows {0}（{1}）' 'Windows {0} ({1})') -f $build, $arch)

  if (-not (Wait-SacOff $interactive)) { return 6 }

  $root = Join-Path $env:LOCALAPPDATA 'Quetzal'
  $close = $upgrade -or ($env:QUETZAL_YES -eq '1')
  if (-not $close) {
    $n = Get-QuetzalRunning $root
    if ($n -gt 0) {
      if (-not $interactive) { $close = $true }
      else {
        $a = Read-Host (T 'Quetzal 正在运行：安装时会先关掉它（几秒钟），装好后自动重新启动。继续吗？[Y/n]' 'Quetzal is running: it will be closed for a few seconds and started again after the installation. Continue? [Y/n]')
        if ($a -and $a -notmatch '^[Yy]') { Note (T '没有安装。' 'Nothing was installed.'); return 3 }
        $close = $true
      }
    }
  }

  $tag = ''
  if ($env:QUETZAL_VERSION) {
    $v = $env:QUETZAL_VERSION.Trim().TrimStart('v')
    if ($v -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { Bad ((T '版本号不对：{0}' 'Not a version: {0}') -f $v); return 2 }
    $tag = "v$v"
  } else {
    Step (T '查找最新版本' 'Looking up the latest version')
    $tag = Get-LatestTag
    if (-not $tag) { Bad (T '查不到最新版本（网络不通？）。' 'Could not look up the latest version (no network?).'); return 7 }
  }
  $v = $tag.Substring(1)
  $name = "quetzal-$v-windows-$arch-setup.exe"
  $bases = @("$QuetzalSite/dl/$tag", "https://github.com/$QuetzalRepo/releases/download/$tag")

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('quetzal-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Step ((T '核对 {0} 的发布签名' 'Verifying the release signature of {0}') -f $tag)
    $want = ''
    foreach ($b in $bases) {
      if (-not (Fetch "$b/SHA256SUMS" (Join-Path $tmp 'SHA256SUMS') 60)) { continue }
      if (-not (Fetch "$b/SHA256SUMS.sig" (Join-Path $tmp 'SHA256SUMS.sig') 60)) { continue }
      try {
        $want = Get-ReleaseSum ([IO.File]::ReadAllBytes((Join-Path $tmp 'SHA256SUMS'))) ([IO.File]::ReadAllText((Join-Path $tmp 'SHA256SUMS.sig'))) $name $tag $QuetzalReleasePubKey
        break
      } catch { $want = ''; LogLine ("$b " + $_.Exception.Message) }
    }
    if (-not $want) { Bad ((T '{0} 没有通过签名核对的 Windows 安装包（{1}）。' 'No signature-verified Windows installer for {0} ({1}).') -f $tag, $name); return 8 }
    Ok (T '发布签名有效' 'Release signature is valid')

    Step ((T '下载 {0}' 'Downloading {0}') -f $name)
    $exe = Join-Path $tmp $name
    $got = $false
    foreach ($b in $bases) {
      if ((Fetch "$b/$name" $exe 1800) -and ((Sha256Hex $exe) -eq $want)) { $got = $true; break }
      Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    }
    if (-not $got) { Bad (T '下载失败，或文件与签名清单里的 SHA-256 不符。' 'The download failed, or the file does not match the SHA-256 in the signed list.'); return 9 }
    Ok (T '安装包与签名清单相符' 'The installer matches the signed list')

    Step (T '安装（中途 Windows 可能请求一次管理员权限）' 'Installing (Windows may ask once for administrator permission)')
    $argv = @('/S')
    if ($close) { $argv += '/CLOSEAPPS' }
    if ($upgrade) { $argv += '/UPGRADE' } else { $argv += '/OPEN' }
    $p = Start-Process -FilePath $exe -ArgumentList $argv -Wait -PassThru
    $code = [int]$p.ExitCode
    if ($code -ne 0) { Bad (Explain-Setup $code); Bad ((T '详情：{0}' 'Details: {0}') -f (Join-Path $root 'install.log')); return $code }
    Ok ((T 'Quetzal {0} 已装好' 'Quetzal {0} is installed') -f $v)
    if (-not $upgrade) { Write-Host (T '控制台已经打开。新开的终端里可以用 quetzal status 查看状态。' 'The console is open. In a new terminal, quetzal status shows the state.') }
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
