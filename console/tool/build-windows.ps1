# 构建 Windows 桌面版控制台：flutter build windows -> build/windows/<arch>/runner/Release/，再打成
#   build/quetzal-<版本>-windows-<x64|arm64>-console.zip（顶层目录 quetzal-console/，可执行文件 quetzal-console.exe）。
# 安装器把它解到 %LOCALAPPDATA%\Quetzal\console\<版本>\，再把 console\current.txt 改成这个版本（见 docs/WINDOWS_DECISIONS.md 4.1）。
# 需要：Windows 10 1809+ / 11、Flutter（-Flutter <路径> 或环境变量 FLUTTER 可指定）、Visual Studio 2022 的「使用 C++ 的桌面开发」
#   （含 CMake；arm64 要在 arm64 机器上用 ARM64 工具集原生编译）；webview_windows 插件构建时会用 nuget 下载 WebView2 SDK 与 WIL（核对 SHA-256）。
# 包里同时放进 Visual C++ 运行库（vcruntime140*.dll、msvcp140.dll，微软允许随程序分发）：干净的 Windows 上可能没装 VC++ 运行库。
# 本脚本的字符串只用 ASCII：Windows PowerShell 5.1 按系统代码页读没有 BOM 的脚本。
param([string]$Flutter = $(if ($env:FLUTTER) { $env:FLUTTER } else { 'flutter' }))
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$m = Select-String -Path pubspec.yaml -Pattern '^version:\s*([0-9][0-9.]*)' | Select-Object -First 1
if (-not $m) { throw 'version not found in pubspec.yaml' }
$v = $m.Matches[0].Groups[1].Value
$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($osArch) {
  'X64' { $arch = 'x64' }
  'Arm64' { $arch = 'arm64' }
  default { throw "unsupported architecture: $osArch" }
}

# assets/runtime/ 是安卓安装器内置的运行基座（几 MB），桌面版用不着：构建期间挪开，结束后放回（与 build-linux.sh 相同）
$moved = $false
if ((Test-Path assets/runtime) -and (Get-ChildItem assets/runtime -Force | Select-Object -First 1)) {
  Rename-Item assets/runtime runtime.apk-only
  $moved = $true
}
New-Item -ItemType Directory -Force assets/runtime | Out-Null
try {
  & $Flutter pub get | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'flutter pub get failed' }
  & $Flutter build windows --release @args
  if ($LASTEXITCODE -ne 0) { throw 'flutter build windows failed' }
  $bundle = "build/windows/$arch/runner/Release"
  if (-not (Test-Path "$bundle/quetzal-console.exe")) { throw "$bundle/quetzal-console.exe not found" }

  $stage = 'build/quetzal-console'
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  Copy-Item -Recurse $bundle $stage

  # Visual C++ 运行库（app-local）：从这台构建机的 Visual Studio 里取同架构的 Microsoft.VC14x.CRT
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $crt = $null
  if (Test-Path $vswhere) {
    $vs = & $vswhere -latest -products * -property installationPath
    if ($vs) {
      $crt = Get-ChildItem (Join-Path $vs "VC\Redist\MSVC\*\$arch\Microsoft.VC14*.CRT") -Directory -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    }
  }
  if ($crt) {
    Copy-Item (Join-Path $crt.FullName '*.dll') $stage
    Write-Host "bundled VC++ runtime from $($crt.FullName)"
  } else {
    Write-Warning 'VC++ runtime (Microsoft.VC14x.CRT) not found; the package relies on the system-wide VC++ redistributable'
  }

  $out = "build/quetzal-$v-windows-$arch-console.zip"
  if (Test-Path $out) { Remove-Item -Force $out }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory((Resolve-Path $stage).Path, (Join-Path (Resolve-Path build).Path (Split-Path $out -Leaf)),
    [System.IO.Compression.CompressionLevel]::Optimal, $true)
  Remove-Item -Recurse -Force $stage
  $size = [math]::Round((Get-Item $out).Length / 1MB, 1)
  Write-Host "Windows console built: $out ($size MB)"
} finally {
  if ($moved) {
    Remove-Item -Recurse -Force assets/runtime
    Rename-Item assets/runtime.apk-only runtime
  }
}
