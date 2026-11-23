# Native Windows PowerShell 5.1 integration test for the existing PR102 Lab updater.
# Includes fail-closed source-integrity tests using disposable untracked/ignored files.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$packageRoot = Split-Path $PSScriptRoot -Parent
$updater = Join-Path $packageRoot 'deployment\upgrade-pr102-lab.ps1'
$sourceExtension = Join-Path $packageRoot 'extension'
$root = Join-Path $env:RUNNER_TEMP 'ChromeBridge-PR102-17484-Lab-TestFixture'
$installed = Join-Path $root 'extension'
$manifestPath = Join-Path $installed 'manifest.json'
$gitExe = 'C:\Program Files\Git\cmd\git.exe'

. (Join-Path $packageRoot 'deployment\verify-candidate-source.ps1')
if (-not (Test-Path -LiteralPath $gitExe -PathType Leaf)) { throw 'Trusted Git not found' }
$global:LASTEXITCODE = 0
$sourceSha = (& $gitExe -C $packageRoot rev-parse HEAD | Out-String).Trim()
if ($global:LASTEXITCODE -ne 0 -or $sourceSha -notmatch '^[0-9a-f]{40}$') {
  throw 'Could not resolve exact candidate source SHA'
}
$sourceInputs = @('extension','deployment/verify-candidate-source.ps1','deployment/upgrade-pr102-lab.ps1')

# A non-ignored untracked file inside a copied input directory must fail closed.
$dirtyFile = Join-Path $sourceExtension '.pr102-candidate-dirty-test.mjs'
[IO.File]::WriteAllText($dirtyFile,'synthetic untracked candidate source')
$dirtyRejected = $false
try {
  try {
    $null = Assert-BridgeCandidateSource -CandidateRoot $packageRoot -ExpectedSourceSha $sourceSha -InputPaths $sourceInputs
  } catch {
    if ($_.Exception.Message -like 'CANDIDATE_WORKTREE_NOT_CLEAN*') { $dirtyRejected = $true } else { throw }
  }
} finally {
  if (Test-Path -LiteralPath $dirtyFile) { Remove-Item -LiteralPath $dirtyFile -Force }
}
if (-not $dirtyRejected) { throw 'Untracked extension candidate file was not rejected' }

# Ignored files are not reported by ordinary git status; the dedicated ignored-file
# scan must nevertheless reject one before Copy-Item can include it.
$ignoredFile = Join-Path $sourceExtension 'pr102-candidate-ignored-test.json'
[IO.File]::WriteAllText($ignoredFile,'synthetic ignored candidate data')
$ignoredRejected = $false
try {
  try {
    $null = Assert-BridgeCandidateSource -CandidateRoot $packageRoot -ExpectedSourceSha $sourceSha -InputPaths $sourceInputs
  } catch {
    if ($_.Exception.Message -eq 'CANDIDATE_IGNORED_FILES_PRESENT') { $ignoredRejected = $true } else { throw }
  }
} finally {
  if (Test-Path -LiteralPath $ignoredFile) { Remove-Item -LiteralPath $ignoredFile -Force }
}
if (-not $ignoredRejected) { throw 'Ignored extension candidate file was not rejected' }

if (Test-Path -LiteralPath $root) {
  Remove-Item -LiteralPath $root -Recurse -Force
}
New-Item -ItemType Directory -Path $installed -Force | Out-Null
Copy-Item -Path (Join-Path $sourceExtension '*') -Destination $installed -Recurse -Force

$manifest = @{
  manifest_version = 3
  version = '0.2.0'
  key = 'ZmFrZS1wcm9kdWN0aW9uLWlkZW50aXR5LWtleQ=='
  permissions = @('storage','scripting','activeTab')
  host_permissions = @('http://127.0.0.1:17381/*','http://127.0.0.1/*','http://localhost/*','https://claude.ai/*')
  background = @{service_worker='background.js'}
}
[IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 20),(New-Object System.Text.UTF8Encoding($false)))
$beforeManifest = (Get-FileHash $manifestPath -Algorithm SHA256).Hash
$beforeControl = [IO.File]::ReadAllText((Join-Path $installed 'control.js'))

$dry = & $updater -LabRoot $root -CandidateRoot $packageRoot -LabPort 17484 -TestFixture -ExpectedSourceSha $sourceSha
if (($dry -join ' ') -notmatch '\[DRY_RUN\]') { throw 'PR102 Lab dry-run failed' }
if ((Get-FileHash $manifestPath -Algorithm SHA256).Hash -ne $beforeManifest) { throw 'Dry-run changed installed manifest' }
if ([IO.File]::ReadAllText((Join-Path $installed 'control.js')) -ne $beforeControl) { throw 'Dry-run changed installed source' }
if (Test-Path (Join-Path $root 'backups')) { throw 'Dry-run created a persistent backup' }

& $updater -LabRoot $root -CandidateRoot $packageRoot -LabPort 17484 -TestFixture -ExpectedSourceSha $sourceSha -Apply
$updated = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($updated.key -ne $manifest.key) { throw 'Unpacked extension identity key changed' }
if (@($updated.host_permissions) -notcontains 'http://127.0.0.1:17484/*') { throw 'Exact PR102 Lab host permission missing' }
foreach ($hostPattern in @($updated.host_permissions)) {
  if ($hostPattern -match '^(http://127[.]0[.]0[.]1|http://localhost|http://\[::1\])(:[0-9]+)?/[*]$' -and $hostPattern -ne 'http://127.0.0.1:17484/*') {
    throw ('Unexpected additional loopback permission: ' + $hostPattern)
  }
}
foreach ($permission in @('activeTab','offscreen','alarms')) {
  if (@($updated.permissions) -notcontains $permission) { throw ('Required permission missing: ' + $permission) }
}
foreach ($name in @('control.js','connection-check.js','transport-engine.js')) {
  $source = [IO.File]::ReadAllText((Join-Path $installed $name))
  if (-not $source.Contains('127.0.0.1:17484')) { throw ('Lab endpoint missing in ' + $name) }
}
foreach ($file in Get-ChildItem -LiteralPath $installed -Recurse -File -Filter '*.js') {
  $source = [IO.File]::ReadAllText($file.FullName)
  if ($source.Contains('127.0.0.1:17381') -or $source.Contains('127.0.0.1:17382')) {
    throw ('Production endpoint retained in ' + $file.Name)
  }
}
$backups = @(Get-ChildItem -LiteralPath (Join-Path $root 'backups') -Directory)
if ($backups.Count -ne 1) { throw 'Exactly one Lab rollback backup expected' }
if (-not (Test-Path (Join-Path $backups[0].FullName 'lab-backup.json'))) { throw 'Lab rollback marker missing' }

& $updater -LabRoot $root -CandidateRoot $packageRoot -LabPort 17484 -TestFixture -ExpectedSourceSha $sourceSha -RollbackFrom $backups[0].FullName -Apply
if ((Get-FileHash $manifestPath -Algorithm SHA256).Hash -ne $beforeManifest) { throw 'Rollback did not restore manifest exactly' }
if ([IO.File]::ReadAllText((Join-Path $installed 'control.js')) -ne $beforeControl) { throw 'Rollback did not restore original extension source' }
Write-Output '[PASS] PR102 Lab dry-run/apply/rollback; identity/endpoint/permissions; dirty and ignored source rejection'
Remove-Item -LiteralPath $root -Recurse -Force
