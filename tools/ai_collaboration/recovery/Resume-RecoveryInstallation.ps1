# Resume exactly the interrupted first installation after INVALID_MANIFEST_ENTRY.
# The stage already exists; do not clone repositories, delete the release,
# or overwrite production/PR102 servers. Explicit local operator invocation only.
[CmdletBinding()]
param([ValidateSet('Check','Resume')][string]$Mode='Check')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$release='C:\Engineering\ChromeBridge-Recovery-Release'
$pr113='C:\Engineering\ChromeBridge-PR113-Recovery-Checkout'
$entry=Join-Path $release 'Invoke-VerifiedRecovery.ps1'
$sourceEntry=Join-Path $PSScriptRoot 'Invoke-VerifiedRecovery.ps1'
$manifest=Join-Path $release 'files.sha256.json'
$labStage=Join-Path $pr113 'docs\chrome-bridge-handoff\chrome-bridge-v20\deployment\Stage-OneClick-RecoveryUpdate.ps1'
$node='C:\Program Files\nodejs\node.exe'
function Get-Manifest {
  if(!(Test-Path -LiteralPath $manifest -PathType Leaf)){throw 'STAGED_MANIFEST_MISSING'}
  $parsed=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $items=@($parsed)
  if($items.Count -eq 1 -and $items[0] -is [System.Array]){$items=@($items[0])}
  if($items.Count -ne 9){throw ('UNEXPECTED_MANIFEST_ENTRY_COUNT_'+$items.Count)}
  return ,$items
}
if(!(Test-Path -LiteralPath $entry -PathType Leaf) -or
   !(Test-Path -LiteralPath $sourceEntry -PathType Leaf) -or
   !(Test-Path -LiteralPath $labStage -PathType Leaf)){
  throw 'EXPECTED_PARTIAL_INSTALLATION_NOT_FOUND'
}
if(!(((& git -C $repo branch --show-current) -join '').Trim() -eq 'platform/ai-windows-control-release-20261114')){
  throw 'WRONG_PLATFORM_BRANCH'
}
$dirty=@(& git -C $repo status --porcelain -- tools/ai_collaboration/recovery)
if($LASTEXITCODE -ne 0 -or $dirty.Count){throw 'RECOVERY_SOURCE_DIRTY_NO_REPAIR'}
$manifestEntries=Get-Manifest
$filenames=@(
  'Restore-LocalStack.ps1','Recover-LabTunnel.ps1',
  'Recover-PowerShellDirect.ps1','Save-RecoveryCredential.ps1',
  'Recovery-Watchdog.ps1','Register-StackRecovery.ps1',
  'Get-StackInventory.ps1','Invoke-VerifiedRecovery.ps1',
  'Restore-StackWithReport.ps1'
)
$names=@($manifestEntries | ForEach-Object {[string]$_.File})
if(@($names|Select-Object -Unique).Count -ne 9 -or
   @($names | Where-Object {$filenames -cnotcontains $_}).Count -gt 0){
  throw 'STAGED_MANIFEST_NOT_APPROVED'
}
$oldHash=(Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
foreach($item in $manifestEntries){
  $name=[string]$item.File
  $file=Join-Path $release $name
  $expected=[string]$item.Sha256
  if($expected -notmatch '^[0-9A-Fa-f]{64}$' -or
     !(Test-Path -LiteralPath $file -PathType Leaf) -or
     (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $expected.ToUpperInvariant()){
    throw ('STAGED_FILE_NOT_VERIFIED_'+$name)
  }
  if($name -ne 'Invoke-VerifiedRecovery.ps1'){
    $source=Join-Path $PSScriptRoot $name
    if(!(Test-Path -LiteralPath $source -PathType Leaf) -or
       (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -cne $expected.ToUpperInvariant()){
      throw ('STAGE_DIFFERS_FROM_REVIEWED_SOURCE_'+$name)
    }
  }
}
if($Mode -eq 'Check'){
  [PSCustomObject]@{
    Result='PARTIAL_INSTALLATION_SAFE_TO_RESUME'
    Release=$release
    ExistingVerifierSha256=$oldHash
    ReviewedVerifierSha256=(Get-FileHash -LiteralPath $sourceEntry -Algorithm SHA256).Hash
    StageFilesVerified=$manifestEntries.Count
    WouldStartProcesses=$false
  }|ConvertTo-Json
  return
}
# Only the verifier changed. Make a backup, copy the reviewed replacement,
# update only its checksum, then immediately verify the whole release.
$backup=Join-Path $release ('Invoke-VerifiedRecovery.ps1.before-fix-'+(Get-Date -Format 'yyyyMMddHHmmss'))
Copy-Item -LiteralPath $entry -Destination $backup -ErrorAction Stop
Copy-Item -LiteralPath $sourceEntry -Destination $entry -Force -ErrorAction Stop
foreach($item in $manifestEntries){
  if($item.File -eq 'Invoke-VerifiedRecovery.ps1'){
    $item.Sha256=(Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
  }
}
$utf8=New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($manifest,($manifestEntries|ConvertTo-Json -Depth 5),$utf8)
& $entry -Mode Verify
& $entry -Mode Status
# Never run an installer against a non-clean checkout; rerun only the tests
# relevant to the source previously used to create this release.
$tests=@(
  'tools/ai_collaboration/recovery/recovery-plan.test.mjs',
  'tools/ai_collaboration/recovery/recovery-runtime.test.mjs',
  'tools/ai_collaboration/recovery/recovery-journal.test.mjs',
  'tools/ai_collaboration/recovery/windows-recovery-contract.test.mjs',
  'tools/ai_collaboration/recovery/native-host-contract.test.mjs'
)
Push-Location $repo
try {
  & $node --test @tests
  if($LASTEXITCODE -ne 0){throw 'RECOVERY_TESTS_NOT_PASSING'}
} finally {Pop-Location}
$cred=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
if(!(Test-Path -LiteralPath $cred -PathType Leaf)){
  $decision=Read-Host 'Store the existing Control Plane API key via local user DPAPI? [yes/no]'
  if($decision -eq 'yes'){& (Join-Path $release 'Save-RecoveryCredential.ps1')}
}
$native=Join-Path $PSScriptRoot 'Install-RecoveryNativeHost.ps1'
$nativeState=& $native -Mode Check | ConvertFrom-Json
if(!$nativeState.Installed){& $native -Mode Install}
$register=Join-Path $release 'Register-StackRecovery.ps1'
$task=& $register -Mode Check | ConvertFrom-Json
if(!$task.Installed){& $register -Mode Register -DesktopShortcut}
# This source script existed in the separately cloned PR113 checkout before
# the interrupted install. Do not overwrite any dirty checkout or lab backup.
$prDirty=@(& git -C $pr113 status --porcelain -- 'docs/chrome-bridge-handoff/chrome-bridge-v20/extension' 'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/Build-OneClick-Lab.ps1' 'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/Stage-OneClick-RecoveryUpdate.ps1')
if($LASTEXITCODE -ne 0 -or $prDirty.Count){throw 'PR113_REQUIRED_SOURCE_DIRTY_NO_UPDATE'}
& $labStage -Apply
Write-Host 'RECOVERY_RESUME_COMPLETED_RELOAD_EXTENSION_REQUIRED'
Write-Host 'Reload the existing PR113 LAB extension and verify ID ehmllfabjbfcinaigionjggbgonkokfg.'
Write-Host 'No production services were stopped or restarted.'
