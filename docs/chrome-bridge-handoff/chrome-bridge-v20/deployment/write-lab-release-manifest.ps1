# Deterministic evidence for the disposable Chrome Bridge RC1 lab artifact.
# This script never reads tokens, production server state, or installed Chrome profiles.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$LabRoot,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$CommitSha = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($LabRoot).TrimEnd('\')
$output=[IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'LabRoot missing' }
if ($output.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'Evidence must be outside staged extension directory'
}
$manifestPath=Join-Path $root 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'manifest.json missing' }
$m=Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
if ($m.manifest_version -ne 3 -or $m.background.service_worker -ne 'background.js' -or $m.background.type -ne 'module') {
  throw 'MV3 module background manifest required'
}
$hosts=@($m.host_permissions)
if ($hosts -notcontains 'http://127.0.0.1:17481/*') { throw 'Missing lab endpoint permission' }
foreach($bad in @('http://127.0.0.1:17381/*','http://127.0.0.1/*','https://*/*','<all_urls>')) {
  if ($hosts -contains $bad) { throw ('Forbidden host permission: '+$bad) }
}
$files=@(Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName)
if ($files.Count -lt 18) { throw 'Incomplete lab extension artifact' }
$entries=@(foreach($file in $files) {
  $rel=$file.FullName.Substring($root.Length+1).Replace('\','/')
  if ($rel -match '(^|/)(config|token|secrets?)\.(json|txt)$') { throw ('Unexpected credential-shaped file: '+$rel) }
  if ($file.Extension -eq '.js') {
    $src=[IO.File]::ReadAllText($file.FullName)
    if ($src.Contains('http://127.0.0.1:17381')) { throw ('Production endpoint in '+$rel) }
  }
  [ordered]@{
    path=$rel
    bytes=[int64]$file.Length
    sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
})
$report=[ordered]@{
  schema='chrome-bridge-rc1-lab-evidence-v1'
  commit=$CommitSha
  target='DISPOSABLE_LAB_ONLY'
  endpoint='http://127.0.0.1:17481'
  mv3Background='background.js'
  sourceFileCount=$entries.Count
  files=$entries
  limits=@('No live Claude/Gemini/DeepSeek send or reply tested','No user Windows profile tested','No production changes authorized')
}
$parent=Split-Path $output -Parent
if (-not (Test-Path -LiteralPath $parent)) { New-Item -Path $parent -ItemType Directory -Force | Out-Null }
$json=$report | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($output,$json+[Environment]::NewLine,(New-Object System.Text.UTF8Encoding($false)))
Write-Output ('[PASS] lab release manifest created: fileCount='+$entries.Count)
Write-Output ('[SHA256] '+(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant())
Write-Output '[LIMIT] This is packaging integrity, not live-site E2E approval'
