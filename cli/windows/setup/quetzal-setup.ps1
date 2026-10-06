# Quetzal setup helper (runs as the installing user; called by quetzal.nsi). ASCII only: Windows PowerShell 5.1 reads
# BOM-less scripts in the ANSI code page. User-facing text lives in the NSIS script (zh / en); this file only logs.
#
#   -Action Processes   exit code = number of running Quetzal processes (capped at 99)
#   -Action Stop        create home\state\quit, end the scheduled tasks, wait, then force-stop what is left (0 = all gone)
#   -Action Detect      find node (>= 22.13, same arch), git, python 3 for this user; write <Root>\deps.json;
#                       exit code bits: 1 node missing, 2 git missing, 4 python missing, 8 machine step needed anyway
#   -Action Machine     run quetzal-machine.ps1 elevated (one UAC prompt) when needed; write node.txt
#                       0 ok, 10 UAC declined (node usable), 11 UAC declined and no node, 12 machine step reported errors, 13 no node,
#                       14 elevation needed but this is an upgrade started outside an interactive desktop (session 0): no UAC can show
#   -Action Activate    pointers (runtime\previous.txt <- current.txt, current.txt <- Version; console\current.txt), body default, PATH
#   -Action Start       start \Quetzal\Runtime-Boot (or Runtime-Logon), falling back to the launcher directly
#   -Action Health      wait up to 40 s for GET /health with this version; on failure roll back and restart
#                       0 healthy, 20 rolled back to previous.txt, 21 failed and nothing to roll back to
#   -Action MachineUninstall   elevated: remove the scheduled tasks and the sandbox (srt-win uninstall); 0 ok, 10 declined
#   -Action UninstallUser      remove <Root>\bin from the user PATH
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Version = '',
  [string]$Arch = '',
  [string]$Deps = '',
  [string]$SrtWin = '',
  [switch]$Force,
  [switch]$Upgrade
)

# SHA-256 (lowercase hex) via .NET: Windows PowerShell 5.1 started from PowerShell 7 inherits 7's PSModulePath, and module commands such as Get-FileHash may then be missing
function Sha256Hex([string]$path) { $s = [IO.File]::OpenRead($path); try { $h = [Security.Cryptography.SHA256]::Create(); try { return (($h.ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $h.Dispose() } } finally { $s.Dispose() } }
if ($PSVersionTable.PSEdition -ne 'Core') { $env:PSModulePath = (@([IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'WindowsPowerShell', 'Modules'), [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')) -join ';') } # same reason: back to 5.1's own module path
# Continue, not Stop: in Windows PowerShell 5.1 a native command writing to a redirected stderr becomes a terminating error under Stop.
# Cmdlets whose failure matters use -ErrorAction Stop inside try / catch; .NET exceptions throw either way.
$ErrorActionPreference = 'Continue'
$Root = $Root.TrimEnd('\')
$Home_ = Join-Path $Root 'home'
$LogFile = Join-Path $Root 'install.log'
$Utf8 = New-Object System.Text.UTF8Encoding $false
$MinNode = [version]'22.13.0'
$MachineSchema = 1

function Log([string]$msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " [$Action] " + $msg
  [Console]::Out.WriteLine($msg)   # not Write-Output: functions below return exit codes through the pipeline
  try { [IO.Directory]::CreateDirectory($Root) | Out-Null; [IO.File]::AppendAllText($LogFile, $line + "`r`n", $Utf8) } catch { }
}

function Read-Text([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
  return ([IO.File]::ReadAllText($path, $Utf8)).Trim()
}

# Write a small text file atomically (temp file + rename), UTF-8 without BOM.
function Write-Text([string]$path, [string]$text) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
  $tmp = "$path.$PID.tmp"
  [IO.File]::WriteAllText($tmp, $text, $Utf8)
  if (Test-Path -LiteralPath $path) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
}

# Quote one argument for a Windows command line (CommandLineToArgvW rules).
function Quote-Arg([string]$s) {
  if ($s -ne '' -and $s -notmatch '[\s"]') { return $s }
  $out = '"'; $bs = 0
  foreach ($ch in $s.ToCharArray()) {
    if ($ch -eq '\') { $bs++; continue }
    if ($ch -eq '"') { $out += ('\' * ($bs * 2 + 1)) + '"'; $bs = 0; continue }
    $out += ('\' * $bs) + $ch; $bs = 0
  }
  return $out + ('\' * ($bs * 2)) + '"'
}

function Valid-Version([string]$v) { return $v -match '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' }

# ---------------------------------------------------------------- processes
function Get-QuetzalProcesses {
  $rt = (Join-Path $Root 'runtime\').ToLowerInvariant()
  $cs = (Join-Path $Root 'console\').ToLowerInvariant()
  $launcher = (Join-Path $Root 'bin\quetzal-supervise.ps1').ToLowerInvariant()
  $found = @()
  foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
    if ($p.ProcessId -eq $PID) { continue }
    $exe = ([string]$p.ExecutablePath).ToLowerInvariant()
    $cmd = ([string]$p.CommandLine).ToLowerInvariant()
    if (($exe -and ($exe.StartsWith($rt) -or $exe.StartsWith($cs))) -or ($cmd -and ($cmd.Contains($rt) -or $cmd.Contains($launcher)))) { $found += $p }
  }
  return ,$found
}

function Invoke-Schtasks([string[]]$argv) {
  $out = & "$env:SystemRoot\System32\schtasks.exe" @argv 2>&1
  return @{ code = $LASTEXITCODE; out = ($out | Out-String).Trim() }
}

function Stop-Quetzal {
  $state = Join-Path $Home_ 'state'
  [IO.Directory]::CreateDirectory($state) | Out-Null
  $procs = Get-QuetzalProcesses
  if ($procs.Count -eq 0) { Log 'nothing running'; return $true }
  Log ("running: " + (($procs | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join ', '))
  # The console tray would restart the body helper: stop it first.
  foreach ($p in $procs) { if ($p.Name -ieq 'quetzal-console.exe') { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { Log "stop $($p.ProcessId): $($_.Exception.Message)" } } }
  [IO.File]::WriteAllText((Join-Path $state 'quit'), (Get-Date).ToString('o'), $Utf8)   # the supervisor exits together with the runtime
  foreach ($t in @('\Quetzal\Runtime-Boot', '\Quetzal\Runtime-Logon')) { $null = Invoke-Schtasks @('/End', '/TN', $t) }
  for ($i = 0; $i -lt 15; $i++) { if ((Get-QuetzalProcesses).Count -eq 0) { break }; Start-Sleep -Seconds 1 }
  foreach ($p in (Get-QuetzalProcesses)) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Log "force-stopped $($p.ProcessId) $($p.Name)" } catch { Log "cannot stop $($p.ProcessId): $($_.Exception.Message)" } }
  for ($i = 0; $i -lt 5; $i++) { if ((Get-QuetzalProcesses).Count -eq 0) { Log 'stopped'; return $true }; Start-Sleep -Seconds 1 }
  Log ("still running: " + ((Get-QuetzalProcesses | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join ', '))
  return $false
}

# ---------------------------------------------------------------- dependencies (detected as this user, never through WindowsApps stubs)
function Not-Stub([string]$p) { return $p -and ($p -notmatch '\\WindowsApps\\') -and (Test-Path -LiteralPath $p -PathType Leaf) }

function Candidates([string[]]$names, [string[]]$extra) {
  $list = New-Object System.Collections.Generic.List[string]
  foreach ($e in $extra) { if (Not-Stub $e) { $list.Add($e) } }
  foreach ($n in $names) { foreach ($c in @(Get-Command $n -All -CommandType Application -ErrorAction SilentlyContinue)) { if (Not-Stub $c.Source) { $list.Add($c.Source) } } }
  return ($list | Select-Object -Unique)
}

function Reg-Value([string]$key, [string]$name) {
  try { return [string](Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction Stop).$name } catch { return '' }
}

function Test-Node([string]$exe) {
  try {
    $out = (& $exe -p "process.versions.node+' '+process.arch" 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { return $null }
    $v, $a = $out -split ' '
    if ([version]$v -lt $MinNode) { return $null }
    if ($Arch -and $a -ne $Arch) { return $null }   # an x64 node on arm64 cannot load the arm64 mesh module
    return $v
  } catch { return $null }
}

function Find-Node {
  $nodeDir = Reg-Value 'HKLM:\SOFTWARE\Node.js' 'InstallPath'
  $extra = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
  if ($nodeDir) { $extra += (Join-Path $nodeDir 'node.exe') }
  foreach ($c in (Candidates @('node.exe') $extra)) { $v = Test-Node $c; if ($v) { return @{ path = $c; version = $v } } }
  return $null
}

function Find-Git {
  $gitDir = Reg-Value 'HKLM:\SOFTWARE\GitForWindows' 'InstallPath'
  $extra = @((Join-Path $env:ProgramFiles 'Git\cmd\git.exe'))
  if ($gitDir) { $extra = @((Join-Path $gitDir 'cmd\git.exe')) + $extra }
  foreach ($c in (Candidates @('git.exe') $extra)) {
    try { $out = (& $c --version 2>$null | Out-String).Trim(); if ($LASTEXITCODE -eq 0 -and $out -match '^git version') { return @{ path = $c; version = $out } } } catch { }
  }
  return $null
}

function Find-Python {
  $extra = @()
  foreach ($hive in @('HKLM:\SOFTWARE\Python\PythonCore', 'HKCU:\SOFTWARE\Python\PythonCore')) {
    foreach ($k in @(Get-ChildItem -LiteralPath $hive -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^3\.' })) {
      $ip = Join-Path $k.PSPath 'InstallPath'
      $exe = Reg-Value $ip 'ExecutablePath'
      if (-not $exe) { $d = Reg-Value $ip '(default)'; if ($d) { $exe = Join-Path $d 'python.exe' } }
      if ($exe) { $extra += $exe }
    }
  }
  $extra += @(Get-ChildItem -Path (Join-Path $env:ProgramFiles 'Python3*\python.exe') -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  foreach ($c in (Candidates @('python.exe', 'python3.exe') $extra)) {
    try { $out = (& $c -c "import sys;print(sys.version_info[0])" 2>$null | Out-String).Trim(); if ($LASTEXITCODE -eq 0 -and $out -eq '3') { return @{ path = $c } } } catch { }
  }
  return $null
}

function Srt-Path { if ($SrtWin) { return $SrtWin }; return (Join-Path $Root "runtime\$Version\srt-win\srt-win.exe") }

function Machine-Needed($found) {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $m = $null
  try { $m = (Read-Text (Join-Path $Root 'machine.json')) | ConvertFrom-Json } catch { }
  if ($Force) { return 'forced' }
  if (-not $m) { return 'first run' }
  if ($m.schema -ne $MachineSchema) { return 'schema changed' }
  if ($m.sid -ne $me.User.Value) { return 'different user' }
  if ($m.root -ne $Root) { return 'different root' }
  $srt = Srt-Path
  if (Test-Path -LiteralPath $srt) { if ($m.srtSha256 -ne (Sha256Hex $srt)) { return 'sandbox helper changed' } }
  if (-not $m.srtOk) { return 'sandbox not installed last time' }
  return ''
}

function Detect {
  $node = Find-Node; $git = Find-Git; $py = Find-Python
  $bits = 0
  if (-not $node) { $bits = $bits -bor 1 }
  if (-not $git) { $bits = $bits -bor 2 }
  if (-not $py) { $bits = $bits -bor 4 }
  $why = Machine-Needed $null
  if ($why) { $bits = $bits -bor 8 }
  $d = [ordered]@{ node = $(if ($node) { $node.path } else { $null }); nodeVersion = $(if ($node) { $node.version } else { $null });
    git = $(if ($git) { $git.path } else { $null }); python = $(if ($py) { $py.path } else { $null }); machineReason = $why }
  Write-Text (Join-Path $Root 'deps.json') ($d | ConvertTo-Json)
  Log ("node=" + $d.node + " (" + $d.nodeVersion + "), git=" + $d.git + ", python=" + $d.python + ", machine step: " + $(if ($why) { $why } else { 'not needed' }))
  return $bits
}

function Machine {
  $deps = (Read-Text (Join-Path $Root 'deps.json')) | ConvertFrom-Json
  $need = @()
  if (-not $deps.node) { $need += 'node' }
  if (-not $deps.git) { $need += 'git' }
  if (-not $deps.python) { $need += 'python' }
  $why = Machine-Needed $null
  $node = $deps.node
  if ($need.Count -gt 0 -or $why) {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    $result = Join-Path $Root 'machine-result.json'
    Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $script = Join-Path $PSScriptRoot 'quetzal-machine.ps1'
    $argv = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-Mode', 'Install', '-Root', $Root,
      '-UserSid', $me.User.Value, '-UserName', $me.Name, '-Arch', $Arch, '-Deps', $Deps, '-SrtWin', (Srt-Path), '-Result', $result)
    if ($need.Count -gt 0) { $argv += @('-Need', ($need -join ',')) }
    Log ("elevating once for: " + (@($need) + @($why) -join ', '))
    if ($Upgrade -and [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { Log 'upgrade from session 0 needs elevation: run the installer once on this computer'; return 14 }
    try {
      $p = Start-Process -FilePath $ps -ArgumentList (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    } catch {
      Log ("elevation declined or failed: " + $_.Exception.Message)
      if ($node) { Write-Text (Join-Path $Root 'node.txt') $node; return 10 }
      return 11
    }
    Log "machine step exit code $($p.ExitCode)"
    $r = $null
    try { $r = (Read-Text $result) | ConvertFrom-Json } catch { }
    if (-not $r) { Log 'machine step left no result'; if ($node) { Write-Text (Join-Path $Root 'node.txt') $node; return 12 }; return 13 }
    if ($r.node) { $node = $r.node }
    $git = $(if ($r.git) { $r.git } else { $deps.git }); $py = $(if ($r.python) { $r.python } else { $deps.python })
    Write-Text (Join-Path $Root 'deps.json') ([ordered]@{ node = $node; git = $git; python = $py } | ConvertTo-Json)
    $srt = Srt-Path
    $marker = [ordered]@{ schema = $MachineSchema; sid = $me.User.Value; user = $me.Name; root = $Root; date = (Get-Date).ToString('o');
      srtSha256 = $(if (Test-Path -LiteralPath $srt) { (Sha256Hex $srt) } else { '' });
      srtOk = [bool]$r.srt.ok; bootTask = [bool]$r.tasks.boot; logonTask = [bool]$r.tasks.logon; bootError = [string]$r.tasks.bootError }
    if ($r.tasks.logon) { Write-Text (Join-Path $Root 'machine.json') ($marker | ConvertTo-Json) }
    if (-not $r.tasks.boot) { Log ("start-at-boot task (S4U) not registered: " + $r.tasks.bootError + " -- Quetzal will start when you log on") }
    if (-not $r.srt.ok) { Log ("command sandbox not installed (srt-win exit " + $r.srt.code + "): " + $r.srt.out) }
    if (-not $node -or -not (Test-Node $node)) { Log 'no usable Node.js after the machine step'; return 13 }
    Write-Text (Join-Path $Root 'node.txt') $node
    if (-not $r.ok) { return 12 }
    return 0
  }
  if (-not $node) { return 13 }
  Write-Text (Join-Path $Root 'node.txt') $node
  Log "machine step not needed; node $node"
  return 0
}

# ---------------------------------------------------------------- activate
# Body name (contract with the runtime): the model name (Win32_ComputerSystem.Model, else the BIOS SystemProductName) without
# vendor placeholders, normalised to ^[a-z0-9][a-z0-9-]{0,39}$; else the computer name; Windows reserved names get "-pc".
function Normalize-Body([string]$raw) {
  $junk = '^(system product name|system version|to be filled by o\.e\.m\.|default string|not applicable|not specified|none|o\.e\.m\.|oem|unknown|)$'
  $t = ([string]$raw).Trim()
  if ($t.ToLowerInvariant() -match $junk) { return '' }
  $n = ($t.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
  if ($n.Length -gt 40) { $n = $n.Substring(0, 40).Trim('-') }
  if ($n -notmatch '^[a-z0-9][a-z0-9-]{0,39}$') { return '' }
  if ($n -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])$') { $n = "$n-pc" }
  return $n
}

function Body-Name {
  $cands = @()
  try { $cands += [string](Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).Model } catch { }
  $cands += Reg-Value 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS' 'SystemProductName'
  $cands += $env:COMPUTERNAME
  foreach ($c in $cands) { $n = Normalize-Body $c; if ($n) { return $n } }
  return 'windows'
}

function Add-UserPath([string]$dir, [bool]$add) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { return }
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($raw -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $dir.TrimEnd('\')) })
    if ($add) { $parts += $dir }
    $new = $parts -join ';'
    if ($new -ne $raw) {
      $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      [Environment]::SetEnvironmentVariable('QUETZAL_PATH_REFRESH', $null, 'User')   # broadcasts WM_SETTINGCHANGE
    }
  } finally { $key.Close() }
}

function Activate {
  if (-not (Valid-Version $Version)) { throw "bad version: $Version" }
  $rtDir = Join-Path $Root 'runtime'
  $cur = Read-Text (Join-Path $rtDir 'current.txt')
  if ($cur -and $cur -ne $Version -and (Test-Path -LiteralPath (Join-Path $rtDir $cur))) { Write-Text (Join-Path $rtDir 'previous.txt') $cur }
  Write-Text (Join-Path $rtDir 'current.txt') $Version
  if (Test-Path -LiteralPath (Join-Path $Root "console\$Version")) { Write-Text (Join-Path $Root 'console\current.txt') $Version }
  foreach ($d in @('config', 'state', 'logs', 'data', 'secrets')) { [IO.Directory]::CreateDirectory((Join-Path $Home_ $d)) | Out-Null }
  $node = Read-Text (Join-Path $Root 'node.txt')
  $cfg = Join-Path $Home_ 'config\quetzal.json'
  $body = Body-Name
  if ($node) {
    $js = "const fs=require('fs'),[f,b]=process.argv.slice(1);let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{}if(!c.body||c.body==='default'){c.body=b;fs.writeFileSync(f+'.tmp',JSON.stringify(c,null,2));fs.renameSync(f+'.tmp',f);console.log('body: '+b)}"
    $out = & $node -e $js $cfg $body 2>&1
    if ($out) { Log ([string]($out | Out-String).Trim()) }
  }
  Add-UserPath (Join-Path $Root 'bin') $true
  Log "current $Version (previous $(Read-Text (Join-Path $rtDir 'previous.txt')))"
  return 0
}

# ---------------------------------------------------------------- start, health, rollback
function Start-Quetzal {
  Remove-Item -LiteralPath (Join-Path $Home_ 'state\quit') -Force -ErrorAction SilentlyContinue
  $m = $null; try { $m = (Read-Text (Join-Path $Root 'machine.json')) | ConvertFrom-Json } catch { }
  $tasks = @()
  if ($m -and $m.bootTask) { $tasks += '\Quetzal\Runtime-Boot' }
  $tasks += '\Quetzal\Runtime-Logon'
  foreach ($t in $tasks) {
    $r = Invoke-Schtasks @('/Run', '/TN', $t)
    if ($r.code -eq 0) { Log "started $t"; return 0 }
    Log "cannot start ${t}: $($r.out)"
  }
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $launcher = Join-Path $Root 'bin\quetzal-supervise.ps1'
  Start-Process -FilePath $ps -ArgumentList ((@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $launcher) | ForEach-Object { Quote-Arg $_ }) -join ' ') -WindowStyle Hidden
  Log 'started the launcher directly (no scheduled task available)'
  return 0
}

function Gateway-Port {
  try { $c = (Read-Text (Join-Path $Home_ 'config\quetzal.json')) | ConvertFrom-Json; if ($c.gateway.port) { return [int]$c.gateway.port } } catch { }
  return 7788
}

function Get-Health([int]$port) {
  try {
    $req = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port/health")
    $req.Proxy = $null; $req.Timeout = 2000; $req.ReadWriteTimeout = 2000
    $res = $req.GetResponse()
    try { $body = (New-Object IO.StreamReader($res.GetResponseStream(), $Utf8)).ReadToEnd() } finally { $res.Close() }
    return $body | ConvertFrom-Json
  } catch { return $null }
}

function Wait-Healthy([string]$v, [int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    $h = Get-Health (Gateway-Port)
    if ($h -and $h.ok -and $h.version -eq $v) { return $h }
    Start-Sleep -Seconds 1
  }
  return $null
}

function Prune {
  $keep = @((Read-Text (Join-Path $Root 'runtime\current.txt')), (Read-Text (Join-Path $Root 'runtime\previous.txt')), (Read-Text (Join-Path $Root 'console\current.txt'))) | Where-Object { $_ }
  foreach ($sub in @('runtime', 'console')) {
    foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $Root $sub) -Directory -ErrorAction SilentlyContinue)) {
      if ((Valid-Version $d.Name) -and ($keep -notcontains $d.Name)) {
        try { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop; Log "removed old $sub $($d.Name)" } catch { Log "cannot remove $($d.FullName): $($_.Exception.Message)" }
      }
    }
  }
}

function Health {
  $h = Wait-Healthy $Version 40
  if ($h) { Log "runtime $($h.version) healthy$(if ($h.safeMode) { ' (safe mode)' })"; Prune; return 0 }
  Log "runtime $Version did not answer /health with its version within 40 s"
  $prev = Read-Text (Join-Path $Root 'runtime\previous.txt')
  if (-not $prev -or $prev -eq $Version -or -not (Test-Path -LiteralPath (Join-Path $Root "runtime\$prev"))) { return 21 }
  $null = Stop-Quetzal
  Write-Text (Join-Path $Root 'runtime\previous.txt') $Version
  Write-Text (Join-Path $Root 'runtime\current.txt') $prev
  if (Test-Path -LiteralPath (Join-Path $Root "console\$prev")) { Write-Text (Join-Path $Root 'console\current.txt') $prev }
  $null = Start-Quetzal
  Log "rolled back to $prev"
  return 20
}

function Machine-Uninstall {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $PSScriptRoot 'quetzal-machine.ps1'
  $result = Join-Path $env:TEMP "quetzal-uninstall-$PID.json"
  $argv = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-Mode', 'Uninstall', '-Root', $Root, '-Result', $result)
  if ($SrtWin -and (Test-Path -LiteralPath $SrtWin)) { $argv += @('-SrtWin', $SrtWin) }
  try { $p = Start-Process -FilePath $ps -ArgumentList (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ') -Verb RunAs -WindowStyle Hidden -Wait -PassThru }
  catch { Log ("elevation declined: " + $_.Exception.Message); return 10 }
  Log "machine uninstall exit code $($p.ExitCode): $(Read-Text $result)"
  Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
  return 0
}

if ($Action -eq 'Lib') { return }   # dot-sourced by the tests: functions only

try {
  switch ($Action) {
    'Processes' { $n = (Get-QuetzalProcesses).Count; Log "$n running"; exit ([Math]::Min($n, 99)) }
    'Stop' { if (Stop-Quetzal) { exit 0 } else { exit 1 } }
    'Detect' { exit (Detect) }
    'Machine' { exit (Machine) }
    'Activate' { exit (Activate) }
    'Start' { exit (Start-Quetzal) }
    'Health' { exit (Health) }
    'MachineUninstall' { exit (Machine-Uninstall) }
    'UninstallUser' { Add-UserPath (Join-Path $Root 'bin') $false; Log 'removed bin from the user PATH'; exit 0 }
    default { Log "unknown action $Action"; exit 64 }
  }
} catch {
  Log ("error: " + $_.Exception.Message + " at line " + $_.InvocationInfo.ScriptLineNumber)
  exit 70
}
