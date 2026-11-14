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
Get-ChildItem -LiteralPath $source -Force |
  Copy-Item -Destination $destination -Recurse -Force
$manifestFile=Join-Path $destination 'manifest.json'
$manifest=Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.name="Chrome Bridge PR113 LAB ($LabPort)"
$manifest.description="ISOLATED LAB ONLY - localhost port $LabPort"
$manifest.host_permissions=@("http://127.0.0.1:$LabPort/*")
$utf8NoBom=New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json -Depth 16), $utf8NoBom)
# Patch all copied runtime and legacy modules, not original sources.
# Unused legacy files must also not contain production endpoints.
Get-ChildItem -LiteralPath $destination -Recurse -File |
  Where-Object {$_.Extension -in '.js','.json','.html'} |
  ForEach-Object {
    $raw=[System.IO.File]::ReadAllText($_.FullName)
    $patched=$raw.Replace('127.0.0.1:17381',"127.0.0.1:$LabPort")
    if($patched -cne $raw) {
      [System.IO.File]::WriteAllText($_.FullName,$patched,$utf8NoBom)
    }
  }
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
