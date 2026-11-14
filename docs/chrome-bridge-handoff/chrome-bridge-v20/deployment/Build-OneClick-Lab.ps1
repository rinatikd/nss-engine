# Build PR113 isolated Chrome extension for a selected loopback laboratory server.
# NO tokens or credentials are copied or embedded. Production sources stay unchanged.
[CmdletBinding()]
param(
  [ValidateSet(17481,17484)]
  [int]$LabPort = 17484,
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$OutputRoot = 'C:\Engineering\ChromeBridge-PR113-E2E-Build'
)
$ErrorActionPreference='Stop'
$source=Join-Path $SourceRoot 'extension'
if (!(Test-Path (Join-Path $source 'manifest.json'))) {
  throw "Extension manifest missing at $source"
}
if ($OutputRoot -match '(?i)chrome-bridge\\extension|chrome-bridge-pr102-release-test|chrome-bridge-rc-final-clean') {
  throw 'OutputRoot overlaps a protected installation. Choose isolated output.'
}
$destination=Join-Path $OutputRoot "extension-$LabPort"
if (Test-Path -LiteralPath $destination) {
  throw "Destination exists: $destination. Use a new OutputRoot; do not overwrite an installed extension."
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $source '*') -Destination $destination -Recurse -Force -ErrorAction Stop
} catch {
  # LiteralPath wildcards are not expanded in Windows PowerShell; copy children instead.
  Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destination -Recurse -Force
}
$manifestFile=Join-Path $destination 'manifest.json'
$manifest=Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.name="Chrome Bridge PR113 LAB ($LabPort)"
$manifest.description="ISOLATED LAB ONLY - localhost port $LabPort"
$manifest.host_permissions=@("http://127.0.0.1:$LabPort/*")
$manifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $manifestFile -Encoding UTF8
$engineFile=Join-Path $destination 'transport-engine.js'
$engine=Get-Content -LiteralPath $engineFile -Raw -Encoding UTF8
if ($engine -notmatch [regex]::Escape("const DEFAULT_ENDPOINT = 'http://127.0.0.1:17381';")) {
  throw 'Unexpected transport endpoint format; cannot safely patch lab endpoint'
}
$engine=$engine.Replace("const DEFAULT_ENDPOINT = 'http://127.0.0.1:17381';",
  "const DEFAULT_ENDPOINT = 'http://127.0.0.1:$LabPort';")
Set-Content -LiteralPath $engineFile -Value $engine -Encoding UTF8
# Fail if any runtime code or host permission still refers to production 17381.
$unsafe=@(Get-ChildItem -LiteralPath $destination -Recurse -File |
  Where-Object {$_.Extension -in '.js','.json','.html'} |
  Select-String -SimpleMatch '127.0.0.1:17381' |
  Select-Object -ExpandProperty Path -Unique)
if($unsafe.Count) {throw ("Production endpoint still present in: "+($unsafe -join ', '))}
$files=@(Get-ChildItem -LiteralPath $destination -Recurse -File |
  Where-Object {$_.Name -ne 'manifest.json'} |
  Select-Object Name,Length,FullName)
Write-Host "LAB BUILD OUTPUT: $destination"
Write-Host "LAB ENDPOINT: http://127.0.0.1:$LabPort"
Write-Host "FILES: $($files.Count)"
Write-Host 'RESULT: BUILT (NOT INSTALLED; NOT E2E-VERIFIED)'
