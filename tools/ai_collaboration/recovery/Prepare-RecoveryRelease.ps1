# Offline, create-only staging of a reviewed recovery bundle.
# Never overwrites an existing installed release, registry, service or tunnel.
# Run in a CLEAN checkout of platform/ai-windows-control-release-20261114.
[CmdletBinding()]
param(
  [string]$RepositoryRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path,
  [string]$Destination='C:\Engineering\ChromeBridge-Recovery-Release'
)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Destination){throw 'DESTINATION_ALREADY_EXISTS'}
$source=Join-Path $RepositoryRoot 'tools\ai_collaboration\recovery'
$files=@(
  'Restore-LocalStack.ps1',
  'Recover-LabTunnel.ps1',
  'Recover-PowerShellDirect.ps1',
  'Save-RecoveryCredential.ps1',
  'Recovery-Watchdog.ps1',
  'Register-StackRecovery.ps1',
  'Get-StackInventory.ps1',
  'Invoke-VerifiedRecovery.ps1'
)
if(!(Test-Path (Join-Path $RepositoryRoot '.git'))){throw 'REPOSITORY_ROOT_NOT_FOUND'}
$dirty=@(& git -C $RepositoryRoot status --porcelain -- tools/ai_collaboration/recovery)
if($LASTEXITCODE -ne 0){throw 'GIT_STATUS_FAILED'}
if($dirty.Count){throw 'RECOVERY_SOURCE_HAS_UNCOMMITTED_CHANGES'}
foreach($file in $files){
  $src=Join-Path $source $file
  if(!(Test-Path -LiteralPath $src -PathType Leaf)){throw ('MISSING_SOURCE_'+$file)}
  & git -C $RepositoryRoot ls-files --error-unmatch ('tools/ai_collaboration/recovery/'+$file) 2>$null | Out-Null
  if($LASTEXITCODE -ne 0){throw ('UNTRACKED_SOURCE_'+$file)}
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
foreach($file in $files){
  Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $Destination $file)
}
# A checksums file records exactly what is being installed. It is NOT
# a signature; do not treat it as proof of GitHub provenance or trust.
$manifest=@(foreach($file in $files){
  $hash=Get-FileHash -LiteralPath (Join-Path $Destination $file) -Algorithm SHA256
  [PSCustomObject]@{File=$file;Sha256=$hash.Hash}
})
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Destination 'files.sha256.json') -Encoding UTF8
[PSCustomObject]@{
  Result='STAGED_NOT_INSTALLED'
  Location=$Destination
  FileCount=$files.Count
  Note='No scheduled task created, no credentials imported, no process started'
} | ConvertTo-Json
