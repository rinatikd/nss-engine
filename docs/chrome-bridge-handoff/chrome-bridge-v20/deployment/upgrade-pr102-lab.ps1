# Existing PR102 Lab extension upgrade. Dry-run by default.
# Preserves the installed extension directory (and therefore its unpacked extension identity).
# This script changes extension files only; it never starts/stops Bridge processes or touches server state.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$LabRoot,
  [string]$StateRoot,
  [string]$CandidateRoot = (Join-Path $PSScriptRoot '..'),
  [ValidateSet(17484)][int]$LabPort = 17484,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedSourceSha,
  [switch]$Apply,
  [string]$RollbackFrom,
  [switch]$TestFixture
)
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'verify-candidate-source.ps1')
$ErrorActionPreference = 'Stop'

$DeployFiles = @(
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
function FullPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path.Trim())
  $rootPath = [IO.Path]::GetPathRoot($full)
  while ($full.Length -gt $rootPath.Length -and ($full.EndsWith('\') -or $full.EndsWith('/'))) {
    $full = $full.Substring(0, $full.Length - 1)
  }
  return $full
}
function ReadManifest([string]$Path) {
  Require (Test-Path -LiteralPath $Path -PathType Leaf) 'Extension manifest.json missing'
  $m = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  Require ($m.manifest_version -eq 3) 'MV3 manifest required'
  Require ($m.background.service_worker -eq 'background.js') 'Unexpected service worker'
  Require ((@($m.permissions) -contains 'storage') -and (@($m.permissions) -contains 'scripting')) 'Baseline permissions missing'
  $hosts = @($m.host_permissions)
  Require (-not ($hosts -contains '<all_urls>' -or $hosts -contains 'https://*/*')) 'Broad permanent host permission denied'
  return $m
}
function WriteUtf8NoBom([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, (New-Object System.Text.UTF8Encoding($false)))
}
function ValidateLabExtension([string]$ExtensionPath) {
  $manifest = ReadManifest (Join-Path $ExtensionPath 'manifest.json')
  $expectedHost = 'http://127.0.0.1:{0}/*' -f $LabPort
  $hosts = @($manifest.host_permissions)
  Require ($hosts -contains $expectedHost) 'Exact PR102 Lab host permission missing'
  $loopbackPattern = '^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/\*$'
  foreach ($hostPattern in $hosts) {
    if ($hostPattern -match $loopbackPattern -and $hostPattern -ne $expectedHost) {
      throw ('Unexpected additional loopback host permission: ' + $hostPattern)
    }
  }
  $permissions = @($manifest.permissions)
  foreach ($permission in @('activeTab','offscreen','alarms')) {
    Require ($permissions -contains $permission) ('Required permission missing: ' + $permission)
  }
  Require ($manifest.background.type -eq 'module') 'MV3 module service worker required'
  $allJs = @(Get-ChildItem -LiteralPath $ExtensionPath -Recurse -File -Filter '*.js')
  foreach ($file in $allJs) {
    $source = [IO.File]::ReadAllText($file.FullName)
    foreach ($badPort in @('127.0.0.1:17381','127.0.0.1:17382')) {
      Require (-not $source.Contains($badPort)) ('Production endpoint retained in Lab JS: ' + $file.Name)
    }
  }
  foreach ($name in @('control.js','connection-check.js','transport-engine.js')) {
    $source = [IO.File]::ReadAllText((Join-Path $ExtensionPath $name))
    Require ($source.Contains(('127.0.0.1:{0}' -f $LabPort))) ('Lab endpoint missing from ' + $name)
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  Require ($null -ne $node) 'Node.js required for extension syntax checks'
  foreach ($file in $allJs) {
    & $node.Source --check $file.FullName
    Require ($LASTEXITCODE -eq 0) ('JavaScript syntax error: ' + $file.Name)
  }
  return $manifest
}

$root = FullPath $LabRoot
if ($TestFixture) {
  $runnerTemp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP')
  Require (-not [string]::IsNullOrWhiteSpace($runnerTemp)) 'TestFixture requires RUNNER_TEMP'
  $tempRoot = (FullPath $runnerTemp) + '\'
  Require ($root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) 'TestFixture path must remain below RUNNER_TEMP'
  Require ((Split-Path $root -Leaf) -eq 'ChromeBridge-PR102-17484-Lab-TestFixture') 'Unexpected synthetic Lab fixture name'
  if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $state = $root
    $installed = Join-Path $root 'extension'
  } else {
    $state = FullPath $StateRoot
    Require ($state.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) 'TestFixture state must remain below RUNNER_TEMP'
    $installed = $root
  }
} else {
  Require ($root -ieq 'C:\Engineering\ChromeBridge-PR102-17484-Lab') 'Only the exact PR102 unpacked extension root is permitted'
  if ([string]::IsNullOrWhiteSpace($StateRoot)) { throw 'PR102 Lab StateRoot is required' }
  $state = FullPath $StateRoot
  Require ($state -ieq 'C:\Engineering\ChromeBridge-PR102-17484-State') 'Only the exact PR102 Lab state root is permitted'
  Require (-not ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'PR102 Lab extension root must not be a reparse point'
  Require (-not ((Get-Item -LiteralPath $state -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'PR102 Lab state root must not be a reparse point'
  Require ([IO.Path]::GetPathRoot($root) -ieq [IO.Path]::GetPathRoot($state)) 'Extension and state roots must share a volume for atomic directory replacement'
  $installed = $root
}
$script:StateRoot = $state
Require (Test-Path -LiteralPath $state -PathType Container) 'Existing PR102 Lab state root missing; refusing to create a new state directory'
Require (Test-Path -LiteralPath $installed -PathType Container) 'Existing Lab extension directory missing'
Require (Test-Path -LiteralPath (Join-Path $installed 'manifest.json') -PathType Leaf) 'Existing Lab extension manifest missing'

if (-not [string]::IsNullOrWhiteSpace($RollbackFrom)) {
  $backupRoot = FullPath $RollbackFrom
  $backupPrefix = (FullPath (Join-Path $state 'backups')) + '\'
  Require ($backupRoot.StartsWith($backupPrefix,[StringComparison]::OrdinalIgnoreCase)) 'Rollback backup must be inside this Lab backup directory'
  $markerPath = Join-Path $backupRoot 'lab-backup.json'
  Require (Test-Path -LiteralPath $markerPath -PathType Leaf) 'Lab backup marker missing'
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Require ($marker.schema -eq 'chrome-bridge-pr102-lab-backup-v1') 'Unknown Lab backup schema'
  Require ($marker.target -eq 'PR102_LAB' -and $marker.port -eq 17484) 'Lab backup target/port mismatch'
  Require ((FullPath ([string]$marker.labRoot)) -ieq $root) 'Backup belongs to a different Lab extension root'
  if ($marker.PSObject.Properties['stateRoot']) { Require ((FullPath ([string]$marker.stateRoot)) -ieq $state) 'Backup belongs to a different Lab state root' }
  $backupExtension = Join-Path $backupRoot 'extension'
  Require (Test-Path -LiteralPath $backupExtension -PathType Container) 'Backup extension tree missing'
  $backupManifestPath = Join-Path $backupExtension 'manifest.json'
  Require ((Get-FileHash -LiteralPath $backupManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq [string]$marker.manifestSha256) 'Lab backup manifest hash mismatch'
  ReadManifest $backupManifestPath | Out-Null
  if (-not $Apply) {
    Write-Output '[RESTORE_DRY_RUN] Lab backup identity verified; no files changed.'
    return
  }
  $restoreStage = Join-Path $state ('.extension-restore-' + [guid]::NewGuid().ToString('N'))
  $displaced = Join-Path $state ('.extension-displaced-' + [guid]::NewGuid().ToString('N'))
  try {
    Copy-Item -LiteralPath $backupExtension -Destination $restoreStage -Recurse -Force
    Move-Item -LiteralPath $installed -Destination $displaced -ErrorAction Stop
    Move-Item -LiteralPath $restoreStage -Destination $installed -ErrorAction Stop
    Remove-Item -LiteralPath $displaced -Recurse -Force
    Write-Output '[RESTORED] Previous PR102 Lab extension restored; server, credentials and Production untouched.'
  } catch {
    if (-not (Test-Path -LiteralPath $installed) -and (Test-Path -LiteralPath $displaced)) {
      Move-Item -LiteralPath $displaced -Destination $installed
    }
    throw
  } finally {
    if (Test-Path -LiteralPath $restoreStage) { Remove-Item -LiteralPath $restoreStage -Recurse -Force }
  }
  return
}

$sourceRoot = FullPath (Join-Path $CandidateRoot 'extension')
Require (Test-Path -LiteralPath $sourceRoot -PathType Container) 'Candidate extension source missing'
$existingManifest = ReadManifest (Join-Path $installed 'manifest.json')
foreach ($name in $DeployFiles) {
  Require (Test-Path -LiteralPath (Join-Path $sourceRoot $name) -PathType Leaf) ('Candidate file missing: ' + $name)
}

$sourceInputs = @('extension','deployment/verify-candidate-source.ps1','deployment/upgrade-pr102-lab.ps1')
$null = Assert-BridgeCandidateSource -CandidateRoot (FullPath $CandidateRoot) -ExpectedSourceSha $ExpectedSourceSha -InputPaths $sourceInputs

$stage = Join-Path $state ('.extension-candidate-' + [guid]::NewGuid().ToString('N'))
try {
  Copy-Item -LiteralPath $installed -Destination $stage -Recurse -Force
  foreach ($name in $DeployFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $stage $name) -Force
  }

  foreach ($name in @('control.js','connection-check.js','transport-engine.js')) {
    $target = Join-Path $stage $name
    $original = [IO.File]::ReadAllText($target)
    if ($original.Contains('127.0.0.1:17382')) { throw ('Production tunnel endpoint retained in ' + $name) }
    if ($original.Contains('127.0.0.1:17381')) {
      $converted = $original.Replace('http://127.0.0.1:17381','http://127.0.0.1:17484')
      $converted = $converted.Replace('127.0.0.1:17381','127.0.0.1:17484')
      WriteUtf8NoBom $target $converted
    } elseif (-not $original.Contains('127.0.0.1:17484')) {
      throw ('No approved Lab or legacy endpoint found in ' + $name)
    }
  }

  $manifestPath = Join-Path $stage 'manifest.json'
  $m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $permissions = @($m.permissions)
  foreach ($permission in @('activeTab','offscreen','alarms')) {
    if ($permissions -notcontains $permission) { $permissions += $permission }
  }
  $m.permissions = $permissions
  $m.background | Add-Member -MemberType NoteProperty -Name type -Value 'module' -Force

  # Keep all non-loopback remote origins; remove every loopback wildcard/port grant,
  # then add only the exact PR102 Lab endpoint.
  $loopbackPattern = '^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/\*$'
  $labHost = 'http://127.0.0.1:17484/*'
  $hosts = @($m.host_permissions | Where-Object { $_ -notmatch $loopbackPattern })
  if ($hosts -notcontains $labHost) { $hosts += $labHost }
  $m.host_permissions = @($hosts | Select-Object -Unique)
  WriteUtf8NoBom $manifestPath (($m | ConvertTo-Json -Depth 50) + [Environment]::NewLine)

  $validated = ValidateLabExtension $stage
  $keyBefore = if ($existingManifest.PSObject.Properties['key']) { [string]$existingManifest.key } else { $null }
  $keyAfter = if ($validated.PSObject.Properties['key']) { [string]$validated.key } else { $null }
  Require ($keyBefore -ceq $keyAfter) 'Extension identity key changed during staging'
  Write-Output '[READY] Candidate prepared and validated for PR102 Lab port 17484.'
  Write-Output '[INFO] Existing extension directory, manifest key and extension storage identity are preserved.'
  Write-Output '[INFO] Only extension files/manifest are in scope; no Bridge process, server state, credentials, tunnel or Production paths are touched.'

  if (-not $Apply) {
    Write-Output '[DRY_RUN] No installed files changed.'
    return
  }

  $backupParent = Join-Path $state 'backups'
  New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
  $backupRoot = Join-Path $backupParent ('extension-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  Copy-Item -LiteralPath $installed -Destination (Join-Path $backupRoot 'extension') -Recurse -Force
  $marker = [ordered]@{
    schema = 'chrome-bridge-pr102-lab-backup-v1'
    target = 'PR102_LAB'
    port = 17484
    labRoot = $root
    stateRoot = $state
    createdUtc = [DateTime]::UtcNow.ToString('o')
    manifestSha256 = (Get-FileHash -LiteralPath (Join-Path $backupRoot 'extension/manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  WriteUtf8NoBom (Join-Path $backupRoot 'lab-backup.json') (($marker | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

  $displaced = Join-Path $state ('.extension-displaced-' + [guid]::NewGuid().ToString('N'))
  try {
    Move-Item -LiteralPath $installed -Destination $displaced -ErrorAction Stop
    Move-Item -LiteralPath $stage -Destination $installed -ErrorAction Stop
    Remove-Item -LiteralPath $displaced -Recurse -Force
    Write-Output ('[INSTALLED] PR102 Lab extension updated at existing path. Chrome reload required. Backup: ' + $backupRoot)
    Write-Output ('[ROLLBACK] -LabRoot "' + $root + '" -StateRoot "' + $state + '" -LabPort 17484 -RollbackFrom "' + $backupRoot + '" -Apply')
  } catch {
    if (-not (Test-Path -LiteralPath $installed) -and (Test-Path -LiteralPath $displaced)) {
      Move-Item -LiteralPath $displaced -Destination $installed
    }
    throw
  }
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
