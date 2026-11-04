# Prepare a SEPARATE unpacked extension test fixture for MV3 background mode.
# Never overwrites the installed Chrome extension, tokens or server state.
[CmdletBinding()]
param(
  [string]$BridgeRoot = 'C:\Engineering\chrome-bridge',
  [string]$CandidateRoot = (Join-Path $PSScriptRoot '..'),
  [string]$OutputRoot = 'C:\Engineering\ChromeBridge-Background-Lab',
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$names = @(
  'background.js', 'background-coordinator.js', 'read-only-dispatch.js',
  'transport-engine.js', 'transport-worker.js', 'transport-host.js',
  'transport-host.html', 'control.html', 'control.js', 'style.css',
  'connection-check.js', 'browser-key-store.js', 'permissions.js',
  'approval-broker.js', 'approval-session.js',
  'adapters.js', 'visual-snapshot.js', 'page.js', 'secrets.js'
)
$installed = Join-Path ([IO.Path]::GetFullPath($BridgeRoot)) 'extension'
$source = Join-Path ([IO.Path]::GetFullPath($CandidateRoot)) 'extension'
$out = [IO.Path]::GetFullPath($OutputRoot)
if (-not (Test-Path -LiteralPath $installed -PathType Container)) { throw 'Installed extension not found' }
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Candidate source missing' }
foreach ($name in $names) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) {
    throw ('Missing candidate file: ' + $name)
  }
}
$existingManifest = Join-Path $installed 'manifest.json'
if (-not (Test-Path -LiteralPath $existingManifest -PathType Leaf)) { throw 'Installed manifest missing' }
$m = Get-Content -LiteralPath $existingManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($m.manifest_version -ne 3 -or $m.background.service_worker -ne 'background.js') {
  throw 'Unsupported installed manifest'
}
if ((@($m.host_permissions) -contains '<all_urls>') -or (@($m.host_permissions) -contains 'https://*/*')) {
  throw 'Unexpected broad host permission'
}
$existingRoot = [IO.Path]::GetFullPath($BridgeRoot).TrimEnd('\')
if ($out.TrimEnd('\') -eq $existingRoot -or $out.StartsWith($existingRoot + '\',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputRoot must not be inside the installed BridgeRoot'
}
if (Test-Path -LiteralPath $out) { throw 'OutputRoot already exists: refusing overwrite' }
$perms = @($m.permissions)
foreach ($permission in @('activeTab','offscreen','alarms')) {
  if ($perms -notcontains $permission) { $perms += $permission }
}
$m.permissions = $perms
$m.background | Add-Member -MemberType NoteProperty -Name type -Value 'module' -Force
Write-Output '[PLAN] Separate background lab candidate only; no installed files changed'
Write-Output ('[PLAN] Output: ' + $out)
Write-Output '[PLAN] Manifest adds offscreen + alarms and module background type'
Write-Output '[PLAN] No credentials or server configuration are copied'
if (-not $Apply) { Write-Output '[DRY-RUN] No output was created'; exit 0 }
$temp = $out + '-tmp-' + [guid]::NewGuid().ToString('N')
try {
  Copy-Item -LiteralPath $installed -Destination $temp -Recurse -Force
  foreach ($name in $names) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $temp $name) -Force
  }
  [IO.File]::WriteAllText((Join-Path $temp 'manifest.json'),
    ($m | ConvertTo-Json -Depth 50) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false)))
  $node = Get-Command node -ErrorAction Stop
  foreach ($name in $names) {
    if ($name -like '*.js') {
      & $node.Source --check (Join-Path $temp $name)
      if ($LASTEXITCODE -ne 0) { throw ('Node syntax check failed: ' + $name) }
    }
  }
  Move-Item -LiteralPath $temp -Destination $out
  Write-Output ('[STAGED] ' + $out)
  Write-Output '[NOTE] New unpacked extension may have a different Chrome ID. Do not change pinned server configuration for testing without a separate plan.'
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
