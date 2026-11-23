# Chrome Bridge staged extension upgrade. Dry-run by default; NO secrets are read.
# Actual install requires -Apply and should be done with control tab closed.
[CmdletBinding(DefaultParameterSetName='Upgrade')]
param(
  [string]$BridgeRoot = 'C:\Engineering\chrome-bridge',
  [string]$CandidateRoot = (Join-Path $PSScriptRoot '..'),
  [Parameter(ParameterSetName='Upgrade')][switch]$Apply,
  [Parameter(ParameterSetName='Restore', Mandatory=$true)][string]$RollbackFrom
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$files = @(
  'control.html', 'control.js', 'background.js', 'permissions.js',
  'adapters.js', 'visual-snapshot.js', 'browser-key-store.js',
  'connection-check.js', 'style.css',
  'background-coordinator.js', 'read-only-dispatch.js', 'transport-engine.js',
  'transport-worker.js', 'transport-host.js', 'transport-host.html',
  'approval-broker.js', 'approval-session.js',
  'mutation-dispatch.js', 'background-control-grants.js', 'session-authorization.js'
)
function Require([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
function ConfirmManifest([string]$Path) {
  Require (Test-Path -LiteralPath $Path -PathType Leaf) 'Installed extension manifest.json not found'
  $m = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  Require ($m.manifest_version -eq 3) 'Requires existing Chrome MV3 extension'
  Require ($m.background.service_worker -eq 'background.js') 'Unexpected background service worker'
  Require ((@($m.permissions) -contains 'storage') -and (@($m.permissions) -contains 'scripting')) 'Missing required baseline permissions'
  $hostPermissions = @($m.host_permissions)
  Require (-not ($hostPermissions -contains '<all_urls>' -or $hostPermissions -contains 'https://*/*')) 'Unexpected broad permanent host permissions'
  return $m
}
function ValidateStaging([string]$Stage) {
  $manifest = ConfirmManifest (Join-Path $Stage 'manifest.json')
  $perms = @($manifest.permissions)
  Require ($perms -contains 'activeTab') 'Staged manifest lacks activeTab'
  Require (($perms -contains 'offscreen') -and ($perms -contains 'alarms')) 'Background integration requires offscreen and alarms'
  Require ($manifest.background.type -eq 'module') 'Background integration requires MV3 module service worker'
  foreach ($name in $files) {
    Require (Test-Path -LiteralPath (Join-Path $Stage $name) -PathType Leaf) ("Missing staged " + $name)
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  Require ($null -ne $node) 'Node.js is required to syntax check candidate'
  foreach ($name in $files) {
    if ($name -like '*.js') {
      & $node.Source --check (Join-Path $Stage $name)
      Require ($LASTEXITCODE -eq 0) ("JavaScript syntax check failed: " + $name)
    }
  }
}
$root = [IO.Path]::GetFullPath($BridgeRoot)
$installed = Join-Path $root 'extension'
Require (Test-Path -LiteralPath $installed -PathType Container) 'Installed extension directory missing'
if ($PSCmdlet.ParameterSetName -eq 'Restore') {
  $backup = [IO.Path]::GetFullPath($RollbackFrom)
  $backupExtension = Join-Path $backup 'extension'
  Require (Test-Path -LiteralPath $backupExtension -PathType Container) 'Rollback snapshot does not contain extension folder'
  ConfirmManifest (Join-Path $backupExtension 'manifest.json') | Out-Null
  if (-not $Apply) {
    # Restore has its own deliberate confirm gate (script cannot be accidentally
    # invoked from the ordinary dry-run path).
    Write-Output '[RESTORE] Request accepted: copy of backup will replace installed extension only.'
  }
  $restoreStage = Join-Path $root ('.extension-restore-' + [guid]::NewGuid().ToString('N'))
  Copy-Item -LiteralPath $backupExtension -Destination $restoreStage -Recurse -Force
  $displaced = Join-Path $root ('.extension-displaced-' + [guid]::NewGuid().ToString('N'))
  try {
    Move-Item -LiteralPath $installed -Destination $displaced -ErrorAction Stop
    Move-Item -LiteralPath $restoreStage -Destination $installed -ErrorAction Stop
    Remove-Item -LiteralPath $displaced -Recurse -Force
    Write-Output '[RESTORED] Previous extension files restored; local server files and secrets unchanged.'
  } catch {
    if (-not (Test-Path -LiteralPath $installed) -and (Test-Path -LiteralPath $displaced)) {
      Move-Item -LiteralPath $displaced -Destination $installed
    }
    throw
  } finally {
    if (Test-Path -LiteralPath $restoreStage) { Remove-Item -LiteralPath $restoreStage -Recurse -Force }
  }
  exit 0
}
$source = Join-Path ([IO.Path]::GetFullPath($CandidateRoot)) 'extension'
Require (Test-Path -LiteralPath $source -PathType Container) 'Candidate extension source directory missing'
$existingManifest = ConfirmManifest (Join-Path $installed 'manifest.json')
foreach ($name in $files) {
  Require (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf) ("Candidate lacks " + $name)
}
$stage = Join-Path $root ('.extension-candidate-' + [guid]::NewGuid().ToString('N'))
try {
  Copy-Item -LiteralPath $installed -Destination $stage -Recurse -Force
  foreach ($name in $files) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $stage $name) -Force
  }
  $manifestPath = Join-Path $stage 'manifest.json'
  $m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $permissions = @($m.permissions)
  foreach ($permission in @('activeTab','offscreen','alarms')) {
    if ($permissions -notcontains $permission) { $permissions += $permission }
  }
  $m.permissions = $permissions
  $m.background | Add-Member -MemberType NoteProperty -Name type -Value 'module' -Force
  # Existing action, host permissions, extension ID/key and service_worker
  # stay unchanged; background.type=module and offscreen/alarms are needed
  # for this opt-in gated experiment. This candidate must remain draft.
  # Windows PowerShell 5.1 writes a UTF-8 BOM with Set-Content -Encoding UTF8.
  # Chrome JSON manifests must not acquire an unexpected BOM during upgrades.
  $json = $m | ConvertTo-Json -Depth 50
  [IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false)))
  ValidateStaging $stage
  Write-Output ('[READY] Candidate validated: ' + $files.Count + ' source files and activeTab in staged manifest')
  Write-Output ('[INFO] Existing manifest version: ' + $existingManifest.version)
  Write-Output '[INFO] No changes to Codex CLI hooks or backend configuration.'
  Write-Output '[INFO] Existing server, credentials, and tunnel are untouched.'
  if (-not $Apply) {
    Write-Output '[DRY-RUN] No installed files were changed. Use -Apply after closing the Chrome Bridge control window.'
    exit 0
  }
  $backupRoot = Join-Path (Split-Path $root -Parent) ('chrome-bridge-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6))
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  Copy-Item -LiteralPath $installed -Destination (Join-Path $backupRoot 'extension') -Recurse -Force
  ConfirmManifest (Join-Path $backupRoot 'extension/manifest.json') | Out-Null
  Write-Output ('[BACKUP] ' + $backupRoot)
  $displaced = Join-Path $root ('.extension-displaced-' + [guid]::NewGuid().ToString('N'))
  try {
    Move-Item -LiteralPath $installed -Destination $displaced -ErrorAction Stop
    Move-Item -LiteralPath $stage -Destination $installed -ErrorAction Stop
    Write-Output '[INSTALLED] Candidate extension files are in place. Reload unpacked extension in chrome://extensions.'
    Write-Output ('[ROLLBACK] .\\deployment\\upgrade-windows.ps1 -BridgeRoot "' + $root + '" -RollbackFrom "' + $backupRoot + '"')
    Remove-Item -LiteralPath $displaced -Recurse -Force
  } catch {
    if (-not (Test-Path -LiteralPath $installed) -and (Test-Path -LiteralPath $displaced)) {
      Move-Item -LiteralPath $displaced -Destination $installed
    }
    throw
  }
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
