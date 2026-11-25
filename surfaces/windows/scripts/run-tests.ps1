<#
.SYNOPSIS
    Quetzalcoatl Windows 桌面端一键验证：还原、编译、单测、自检、UI Automation 冒烟。

.DESCRIPTION
    供开发机与 CI 使用。无交互式桌面时 UI 冒烟会以 77（SKIP）退出，脚本如实记录，
    绝不把 SKIP 当作通过。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\run-tests.ps1 -Dotnet C:\dotnet\dotnet.exe
#>
[CmdletBinding()]
param(
    [string]$Dotnet = 'dotnet',
    [string]$Configuration = 'Debug',
    [string]$Artifacts = '',
    [switch]$SkipUiSmoke
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Artifacts)) {
    $Artifacts = Join-Path $root 'artifacts'
}
New-Item -ItemType Directory -Force -Path $Artifacts | Out-Null

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "==> $Name"
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name 失败（exit=$LASTEXITCODE）"
    }
}

Invoke-Step 'dotnet --info' { & $Dotnet --info | Out-Host }

Invoke-Step 'restore' {
    & $Dotnet restore (Join-Path $root 'Quetzalcoatl.Windows.sln') -p:Platform=x64
}

Invoke-Step 'build (warnings are errors)' {
    & $Dotnet build (Join-Path $root 'Quetzalcoatl.Windows.sln') `
        -c $Configuration -p:Platform=x64 --no-restore `
        -warnaserror
}

Invoke-Step 'dotnet test' {
    & $Dotnet test (Join-Path $root 'Quetzalcoatl.Windows.sln') `
        -c $Configuration -p:Platform=x64 --no-build `
        --logger "trx;LogFileName=windows-tests.trx" `
        --results-directory $Artifacts
}

$appExe = Join-Path $root "src\Quetzalcoatl.App\bin\x64\$Configuration\net9.0-windows10.0.19041.0\win-x64\Quetzalcoatl.App.exe"
if (-not (Test-Path $appExe)) {
    # WindowsAppSDK 自包含输出在不同 SDK 版本下可能省略 RID 子目录。
    $appExe = (Get-ChildItem -Path (Join-Path $root "src\Quetzalcoatl.App\bin\x64\$Configuration") -Filter Quetzalcoatl.App.exe -Recurse | Select-Object -First 1).FullName
}

$selfTestReport = Join-Path $Artifacts 'self-test.txt'
Remove-Item -Force -ErrorAction SilentlyContinue $selfTestReport
& $appExe --self-test --demo-rows --report $selfTestReport | Out-Host
$selfTestExit = $LASTEXITCODE
if ($selfTestExit -ne 0) {
    Write-Host "SKIP: 自检需要交互式桌面（app exit=$selfTestExit）；崩溃取证见 %TEMP%\quetzalcoatl-win-startup-error.txt"
} elseif (Test-Path $selfTestReport) {
    Get-Content $selfTestReport | Out-Host
}

if ($SkipUiSmoke) {
    Write-Host 'SKIP: 已按参数跳过 UI Automation 冒烟'
    exit 0
}

$smokeExe = Join-Path $root "tests\Quetzalcoatl.UiSmoke\bin\$Configuration\net9.0-windows10.0.19041.0\Quetzalcoatl.UiSmoke.exe"
if (-not (Test-Path $smokeExe)) {
    $smokeExe = (Get-ChildItem -Path (Join-Path $root "tests\Quetzalcoatl.UiSmoke\bin\$Configuration") -Filter Quetzalcoatl.UiSmoke.exe -Recurse | Select-Object -First 1).FullName
}

$smokeReport = Join-Path $Artifacts 'ui-smoke.txt'
$observedDump = Join-Path $Artifacts 'ui-observed.json'
& $smokeExe --app $appExe --report $smokeReport --observed-dump $observedDump --timeout 60 |
    Out-Host
$code = $LASTEXITCODE
if ($code -eq 77) {
    Write-Host 'SKIP: UI Automation 冒烟需要交互式桌面（本次会话不可用），已记录原因。'
    exit 0
}

if ($code -ne 0) {
    throw "UI Automation 冒烟失败（exit=$code），详见 $smokeReport"
}

Write-Host 'WINDOWS_DESKTOP_OK'
exit 0
