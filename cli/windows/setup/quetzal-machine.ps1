# Quetzal machine-level setup, run ONCE elevated (one UAC prompt) by quetzal-setup.ps1. ASCII only (Windows PowerShell 5.1).
#   -Mode Install:   silently install the missing Node.js / Git / Python machine-wide from the embedded official installers
#                    (SHA-256 checked again here against deps.json), install the command sandbox (srt-win install: the
#                    srt-sandbox account + WFP filters, loopback proxy ports 60080-60089), register the scheduled tasks
#                    \Quetzal\Runtime-Boot (boot, the installing user, S4U, restart every minute on failure) and
#                    \Quetzal\Runtime-Logon (logon, interactive). S4U failing only drops the boot task; that is recorded.
#   -Mode Uninstall: remove the two tasks and the \Quetzal folder, and the sandbox (srt-win uninstall).
# Writes a JSON result to -Result; the caller reads it. Logs to <Root>\install.log.
[CmdletBinding()]
param(
  [ValidateSet('Install', 'Uninstall')][string]$Mode = 'Install',
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$UserSid = '',
  [string]$UserName = '',
  [string]$Arch = '',
  [string]$Deps = '',
  [string]$Need = '',
  [string]$SrtWin = '',
  [Parameter(Mandatory = $true)][string]$Result
)

# SHA-256 (lowercase hex) via .NET: Windows PowerShell 5.1 started from PowerShell 7 inherits 7's PSModulePath, and module commands such as Get-FileHash may then be missing
function Sha256Hex([string]$path) { $s = [IO.File]::OpenRead($path); try { $h = [Security.Cryptography.SHA256]::Create(); try { return (($h.ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $h.Dispose() } } finally { $s.Dispose() } }
if ($PSVersionTable.PSEdition -ne 'Core') { $env:PSModulePath = (@([IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'WindowsPowerShell', 'Modules'), [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')) -join ';') } # same reason: back to 5.1's own module path
$ErrorActionPreference = 'Continue'
$Root = $Root.TrimEnd('\')
$Utf8 = New-Object System.Text.UTF8Encoding $false
$LogFile = Join-Path $Root 'install.log'
$ProxyPorts = '60080-60089'   # sandbox-runtime's default WFP loopback-permit range; the runtime's proxy listens inside it

function Log([string]$msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " [machine] " + $msg
  try { [IO.File]::AppendAllText($LogFile, $line + "`r`n", $Utf8) } catch { }
}

function Save($obj) { [IO.File]::WriteAllText($Result, ($obj | ConvertTo-Json -Depth 6), $Utf8) }

function Is-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Run([string]$exe, [string]$argLine) {
  Log "run $exe $argLine"
  $p = Start-Process -FilePath $exe -ArgumentList $argLine -Wait -PassThru -WindowStyle Hidden
  Log "exit $($p.ExitCode)"
  return $p.ExitCode
}

function Install-Dep([string]$key, $lock) {
  $e = $lock.$key
  if (-not $e) { return @{ ok = $false; error = "no $key entry in deps.json" } }
  $file = Join-Path $Deps $e.file
  if (-not (Test-Path -LiteralPath $file)) { return @{ ok = $false; error = "missing $file" } }
  $got = (Sha256Hex $file)
  if ($got -ne $e.sha256) { return @{ ok = $false; error = "sha256 mismatch for $($e.file): $got" } }
  $logs = Join-Path $Root 'logs-setup'
  [IO.Directory]::CreateDirectory($logs) | Out-Null
  switch ($key) {
    'node' {
      $code = Run "$env:SystemRoot\System32\msiexec.exe" ("/i `"$file`" /qn /norestart ALLUSERS=1 /l*v `"" + (Join-Path $logs 'node-msi.log') + "`"")
      $path = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    }
    'git' {
      $code = Run $file ("/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES /ALLUSERS /LOG=`"" + (Join-Path $logs 'git-setup.log') + "`"")
      $path = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
    }
    'python' {
      $target = Join-Path $env:ProgramFiles 'Python314'
      $code = Run $file ("/quiet InstallAllUsers=1 PrependPath=1 Include_test=0 TargetDir=`"$target`" /log `"" + (Join-Path $logs 'python-setup.log') + "`"")
      $path = Join-Path $target 'python.exe'
    }
  }
  $ok = (($code -eq 0) -or ($code -eq 3010)) -and (Test-Path -LiteralPath $path)
  return @{ ok = $ok; code = $code; path = $(if ($ok) { $path } else { $null }); version = $e.version }
}

function Esc([string]$s) { return [Security.SecurityElement]::Escape($s) }

function Task-Xml([string]$kind, [string]$sid) {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $launcher = Join-Path $Root 'bin\quetzal-supervise.ps1'
  $args_ = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
  if ($kind -eq 'Boot') {
    # every 5 minutes as well: after the user logs off, the logon-session supervisor is gone and this brings the runtime back in the background
    $trigger = '<BootTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger>'
    $logon = 'S4U'
    $desc = 'Quetzal runtime: starts at boot as this user, without a logon (S4U, no stored password).'
  } else {
    $trigger = "<LogonTrigger><Enabled>true</Enabled><UserId>$(Esc $sid)</UserId><Delay>PT5S</Delay></LogonTrigger>"
    $logon = 'InteractiveToken'
    $desc = 'Quetzal runtime: starts when this user logs on (when the boot task already runs it, this one exits at once).'
  }
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>Quetzal</Author><Description>$(Esc $desc)</Description></RegistrationInfo>
  <Triggers>$trigger</Triggers>
  <Principals><Principal id="Author"><UserId>$(Esc $sid)</UserId><LogonType>$logon</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>6</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>$(Esc $ps)</Command><Arguments>$(Esc $args_)</Arguments><WorkingDirectory>$(Esc $Root)</WorkingDirectory></Exec></Actions>
</Task>
"@
}

function Register-Tasks([string]$sid) {
  $r = @{ boot = $false; logon = $false; bootError = ''; logonError = '' }
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  # The installing user may read, run and end its own tasks (quetzal start / stop); it runs as that user anyway.
  $sddl = "D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;$sid)"
  try { $folder = $svc.GetFolder('\Quetzal') } catch { $folder = $svc.GetFolder('\').CreateFolder('Quetzal', "D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;$sid)") }
  # 6 = TASK_CREATE_OR_UPDATE; logon types: 2 = S4U, 3 = interactive token
  try { $null = $folder.RegisterTask('Runtime-Logon', (Task-Xml 'Logon' $sid), 6, $sid, $null, 3, $sddl); $r.logon = $true; Log 'registered \Quetzal\Runtime-Logon' }
  catch { $r.logonError = $_.Exception.Message; Log "Runtime-Logon failed: $($r.logonError)" }
  try { $null = $folder.RegisterTask('Runtime-Boot', (Task-Xml 'Boot' $sid), 6, $sid, $null, 2, $sddl); $r.boot = $true; Log 'registered \Quetzal\Runtime-Boot (S4U)' }
  catch {
    $r.bootError = $_.Exception.Message; Log "Runtime-Boot (S4U) failed: $($r.bootError)"
    try { $folder.DeleteTask('Runtime-Boot', 0) } catch { }
  }
  return $r
}

function Remove-Tasks {
  try {
    $svc = New-Object -ComObject Schedule.Service; $svc.Connect()
    $folder = $svc.GetFolder('\Quetzal')
    foreach ($t in @($folder.GetTasks(1))) { try { $t.Stop(0) } catch { }; $folder.DeleteTask($t.Name, 0); Log "deleted task $($t.Name)" }
    $svc.GetFolder('\').DeleteFolder('Quetzal', 0)
    return $true
  } catch { Log "remove tasks: $($_.Exception.Message)"; return $false }
}

function Srt([string[]]$argv) {
  $out = & $SrtWin @argv 2>&1
  return @{ code = $LASTEXITCODE; out = (($out | Out-String).Trim()) }
}

try {
  if (-not (Is-Admin)) { Save @{ ok = $false; error = 'not elevated' }; exit 2 }
  Log "mode $Mode, root $Root, user $UserName ($UserSid), need [$Need]"

  if ($Mode -eq 'Uninstall') {
    $tasks = Remove-Tasks
    $srt = @{ code = $null; out = 'skipped (no srt-win.exe)' }
    if ($SrtWin -and (Test-Path -LiteralPath $SrtWin)) { $srt = Srt @('uninstall'); Log "srt-win uninstall exit $($srt.code): $($srt.out)" }
    Save @{ ok = ($tasks -and ($null -eq $srt.code -or $srt.code -eq 0)); tasks = $tasks; srt = $srt }
    exit 0
  }

  $res = [ordered]@{ ok = $true; installed = @{}; node = $null; git = $null; python = $null; srt = @{ ok = $false }; tasks = @{} }
  $lock = $null
  if ($Need) { $lock = ([IO.File]::ReadAllText((Join-Path $Deps 'deps.json'), $Utf8)) | ConvertFrom-Json }
  foreach ($key in @($Need -split ',' | Where-Object { $_ })) {
    $d = Install-Dep $key $lock
    $res.installed[$key] = $d
    if ($d.ok) { $res[$key] = $d.path } else { $res.ok = $false; Log "$key not installed: $($d.error) $($d.code)" }
  }

  if ($SrtWin -and (Test-Path -LiteralPath $SrtWin)) {
    $s = Srt @('install', '--proxy-port-range', $ProxyPorts)
    if ($s.code -eq 13) { Log 'srt-win: existing install with a different config, replacing'; $s = Srt @('install', '--proxy-port-range', $ProxyPorts, '--force') }
    Log "srt-win install exit $($s.code): $($s.out)"
    $st = Srt @('status')
    Log "srt-win status: $($st.out)"
    $res.srt = @{ ok = ($s.code -eq 0); code = $s.code; out = $s.out; status = $st.out }
    if ($s.code -ne 0) { $res.ok = $false }
  } else { $res.srt = @{ ok = $false; code = $null; out = "srt-win.exe not found: $SrtWin" }; $res.ok = $false }

  $res.tasks = Register-Tasks $UserSid
  if (-not $res.tasks.logon) { $res.ok = $false }
  Save $res
  exit 0
} catch {
  Log ("error: " + $_.Exception.Message + " at line " + $_.InvocationInfo.ScriptLineNumber)
  try { Save @{ ok = $false; error = $_.Exception.Message } } catch { }
  exit 70
}
