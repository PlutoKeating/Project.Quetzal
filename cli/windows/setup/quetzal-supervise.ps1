# Quetzal launcher (installed as <Root>\bin\quetzal-supervise.ps1). Both scheduled tasks run it:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File <Root>\bin\quetzal-supervise.ps1
# It stays the same across versions, so upgrades never re-register the tasks (no UAC prompt). It reads node.txt and
# runtime\current.txt and runs, in the foreground, "<node>" <Root>\runtime\<current>\windows-supervise.mjs with
# QUETZAL_ROOT=<Root> and QUETZAL_HOME=<Root>\home, then exits with the supervisor's exit code (non-zero lets the
# boot task restart it after a minute). ASCII only (Windows PowerShell 5.1).
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Log = Join-Path $Root 'home\logs\launcher.log'

function Fail([string]$msg) {
  try {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Log)) | Out-Null
    [IO.File]::AppendAllText($Log, (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " $msg`r`n", $Utf8)
  } catch { }
  exit 1
}

function Read-Text([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { return ([IO.File]::ReadAllText($p, $Utf8)).Trim() }; return '' }

$node = Read-Text (Join-Path $Root 'node.txt')
$cur = Read-Text (Join-Path $Root 'runtime\current.txt')
if (-not $node -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { Fail "node.txt does not point to node.exe: '$node' (rerun the installer)" }
if ($cur -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$') { Fail "runtime\current.txt is not a version: '$cur'" }
$dir = Join-Path $Root "runtime\$cur"
$script = Join-Path $dir 'windows-supervise.mjs'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { Fail "missing $script" }

# A task started by the Task Scheduler gets a fresh environment, but the installer's fallback start inherits a stale one:
# rebuild PATH from the registry so newly installed Git / Python are found.
$m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $u = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
$env:QUETZAL_ROOT = $Root
$env:QUETZAL_HOME = Join-Path $Root 'home'
# "quit" asks a running supervisor to exit (installer, quetzal stop); a fresh start clears it. "supervise.off" is left alone.
Remove-Item -LiteralPath (Join-Path $Root 'home\state\quit') -Force -ErrorAction SilentlyContinue

Set-Location -LiteralPath $dir
& $node $script
exit $LASTEXITCODE
