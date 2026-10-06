# Tests for cli/install.ps1 (the generated, shipped file), run by test/install-ps1.test.ts with powershell.exe (5.1) or pwsh.
#   args[0]: fixture JSON written by the Node test: RFC 8032 vectors, a release list signed with a test key, expected values.
# Prints "ok <name>" / "FAIL <name>" and exits with the number of failures. ASCII only.
$ErrorActionPreference = 'Stop'
$script:fail = 0
function Check([string]$name, $got, $want) {
  if ("$got" -ceq "$want") { "ok $name" } else { "FAIL ${name}: got [$got] want [$want]"; $script:fail++ }
}
function Hex([string]$h) { if ($h.Length -eq 0) { return ,([byte[]]@()) }; return ,([byte[]]($h -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) })) }

$env:QUETZAL_PS1_LIB = '1'
. (Join-Path $PSScriptRoot '..\..\install.ps1')
$fx = Get-Content -LiteralPath $args[0] -Raw | ConvertFrom-Json

$sw = [Diagnostics.Stopwatch]::StartNew()
foreach ($v in $fx.vectors) {
  Check "ed25519 $($v.name)" (Test-Ed25519 (Hex $v.pub) (Hex $v.msg) (Hex $v.sig)) $v.ok
}
"ed25519: $($fx.vectors.Count) checks in $([int]$sw.Elapsed.TotalMilliseconds) ms"

$r = $fx.release
$sums = [Convert]::FromBase64String($r.sums)
Check 'release sum' (Get-ReleaseSum $sums $r.sig $r.name $r.tag $r.pub) $r.hash
function Throws([string]$name, [scriptblock]$b) { try { & $b; "FAIL ${name}: did not throw"; $script:fail++ } catch { "ok $name" } }
Throws 'release wrong tag' { Get-ReleaseSum $sums $r.sig $r.name 'v9.9.9' $r.pub }
Throws 'release missing asset' { Get-ReleaseSum $sums $r.sig 'quetzal-1.2.3-windows-x86-setup.exe' $r.tag $r.pub }
Throws 'release official key rejects test signature' { Get-ReleaseSum $sums $r.sig $r.name $r.tag $QuetzalReleasePubKey }
$tampered = [byte[]]$sums.Clone(); $tampered[0] = [byte](($tampered[0] -bxor 1))
Throws 'release tampered list' { Get-ReleaseSum $tampered $r.sig $r.name $r.tag $r.pub }

Check 'base64url' ([BitConverter]::ToString((From-Base64Url 'AQID_-8')).Replace('-', '')) '010203FFEF'

$script:QzZh = $true
Check 'zh text decodes' ((Explain-Setup 14).Contains([string][char]0x7BA1)) 'True'
$script:QzZh = $false
Check 'en text' (Explain-Setup 14) 'Run the installer once on this computer (this step needs administrator permission).'
[IO.File]::WriteAllText($args[1], (Upgrade-StartLine '1700000000000' '1.4.0' '2026-10-07 12:00:00 +08:00') + "`n" + (Upgrade-StartLine '1700000000001' '' 'x') + "`n" + (Upgrade-EndLine '1700000000001' 14) + "`n", (New-Object Text.UTF8Encoding $false))

if ([Environment]::OSVersion.Platform -eq 'Win32NT') {
  Check 'native arch' ((Get-NativeArch) -in @('x64', 'arm64')) 'True'
  Check 'sac state readable' ((Get-SacState) -in @(-1, 0, 1, 2)) 'True'
}
exit $script:fail
