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
  'mutation-dispatch.js', 'background-control-grants.js',
  'adapters.js', 'visual-snapshot.js', 'page.js', 'secrets.js',
  'control-targets.js', 'coordinator-ack.js', 'background-mode-reconnect.js',
  'control-ui-guard.js', 'background-control-ui-state.js'
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
# Prevent a partial lab package silently inheriting stale JS modules from
# the installed extension. All relative imports used by the candidate must
# resolve to candidate files, not the production installation.
foreach ($name in $names) {
  if ($name -notlike '*.js') { continue }
  $file = Join-Path $source $name
  $js = [IO.File]::ReadAllText($file)
  $imports = [regex]::Matches($js, '(?m)\b(?:import|export)\s+(?:[^''";]*?\s+from\s+)?["''](\.[^"'']+)["'']|\bimport\s*\(\s*["''](\.[^"'']+)["'']\s*\)')
  foreach ($match in $imports) {
    $relative = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    $dependency = [IO.Path]::GetFullPath((Join-Path (Split-Path $file -Parent) $relative))
    if (-not $dependency.StartsWith($source.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) {
      throw ('Candidate import escapes extension directory: ' + $name)
    }
    if (-not (Test-Path -LiteralPath $dependency -PathType Leaf)) {
      throw ('Missing candidate import: ' + $name + ' -> ' + $relative)
    }
    $dependencyName = $dependency.Substring($source.TrimEnd('\').Length + 1)
    if ($names -notcontains $dependencyName) {
      throw ('Unpackaged candidate import: ' + $name + ' -> ' + $dependencyName)
    }
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
  # Construct from an empty directory, not an installed-tree clone.
  # The installed tree might contain token-bearing config, logs or stale code.
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  foreach ($name in $names) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $temp $name) -Force
  }
  # Only copy icon images explicitly referenced by the trusted local manifest.
  # Never copy config.json, browserToken, logs, or arbitrary installed files.
  $iconRefs = @()
  if ($m.PSObject.Properties['icons']) {
    if ($m.icons -is [string]) { $iconRefs += $m.icons }
    else { $iconRefs += @($m.icons.PSObject.Properties | ForEach-Object { $_.Value }) }
  }
  if ($m.PSObject.Properties['action'] -and $m.action -and $m.action.PSObject.Properties['default_icon']) {
    $ico = $m.action.default_icon
    if ($ico -is [string]) { $iconRefs += $ico }
    else { $iconRefs += @($ico.PSObject.Properties | ForEach-Object { $_.Value }) }
  }
  foreach ($asset in ($iconRefs | Select-Object -Unique)) {
    if ($asset -isnot [string] -or $asset -notmatch '^[a-zA-Z0-9_./-]+\\.(png|jpg|jpeg|webp)
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
 -or $asset.Contains('..')) {
      throw 'Unsafe manifest icon asset path'
    }
    $assetSource = Join-Path $installed $asset
    if (-not (Test-Path -LiteralPath $assetSource -PathType Leaf)) { throw ('Missing manifest icon asset: ' + $asset) }
    $destination = Join-Path $temp $asset
    $parent = Split-Path $destination -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $assetSource -Destination $destination
  }
  if ($m.PSObject.Properties['content_scripts'] -and @($m.content_scripts).Count -gt 0) {
    throw 'Content scripts require explicit audited packaging; refusing installed tree import'
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
