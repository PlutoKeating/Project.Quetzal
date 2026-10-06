# Pure-logic tests for cli/windows/setup/quetzal-setup.ps1 (run by test/windows-setup.test.ts with powershell.exe or pwsh).
# Prints "ok <name>" / "FAIL <name>: ..." and exits with the number of failures. ASCII only (Windows PowerShell 5.1).
$ErrorActionPreference = 'Stop'
$script:fail = 0
function Check([string]$name, $got, $want) {
  if ("$got" -ceq "$want") { "ok $name" } else { "FAIL ${name}: got [$got] want [$want]"; $script:fail++ }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("qz-setup-" + [guid]::NewGuid().ToString('N'))
. (Join-Path $PSScriptRoot '..\..\windows\setup\quetzal-setup.ps1') -Action Lib -Root $tmp

Check 'quote plain' (Quote-Arg 'abc') 'abc'
Check 'quote empty' (Quote-Arg '') '""'
Check 'quote spaces' (Quote-Arg 'C:\Program Files\x') '"C:\Program Files\x"'
Check 'quote trailing backslash' (Quote-Arg 'C:\a b\') '"C:\a b\\"'
Check 'quote embedded quote' (Quote-Arg 'say "hi"') '"say \"hi\""'
Check 'quote backslash before quote' (Quote-Arg 'a\"b') '"a\\\"b"'

Check 'body model' (Normalize-Body 'ThinkPad X1 Carbon Gen 9') 'thinkpad-x1-carbon-gen-9'
Check 'body placeholder' (Normalize-Body 'System Product Name') ''
Check 'body oem' (Normalize-Body 'To be filled by O.E.M.') ''
Check 'body reserved' (Normalize-Body 'CON') 'con-pc'
Check 'body com port' (Normalize-Body 'com3') 'com3-pc'
Check 'body symbols' (Normalize-Body '  --Surface Laptop 5!! ') 'surface-laptop-5'
Check 'body length' ((Normalize-Body ('a' * 60)).Length) 40
Check 'body non-ascii' (Normalize-Body ([string][char]0x7535 + [char]0x8111)) ''
Check 'body hostname' (Normalize-Body 'DESKTOP-7QK2ABC') 'desktop-7qk2abc'

Check 'version ok' (Valid-Version '1.4.0') 'True'
Check 'version rc' (Valid-Version '1.4.0-rc.1') 'True'
Check 'version bad' (Valid-Version '..\x') 'False'

# Pointer files: atomic write, BOM-less UTF-8, read back trimmed
$p = Join-Path (Join-Path $tmp 'runtime') 'current.txt'
Write-Text $p '1.4.0'
Write-Text $p '1.4.1'
Check 'pointer read' (Read-Text $p) '1.4.1'
Check 'pointer no BOM' ([IO.File]::ReadAllBytes($p)[0]) 49
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

exit $script:fail
