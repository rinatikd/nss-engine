# Entrypoint for an explicitly installed Windows recovery release.
# Checks SHA256 manifest before delegating to any recovery script.
[CmdletBinding()]
param([ValidateSet('Verify','Status','Restore','Watchdog')][string]$Mode='Verify')
$ErrorActionPreference='Stop'
$manifestFile=Join-Path $PSScriptRoot 'files.sha256.json'
if(!(Test-Path -LiteralPath $manifestFile -PathType Leaf)){throw 'RECOVERY_MANIFEST_MISSING'}
$entries=@(Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json)
if(!$entries.Count){throw 'RECOVERY_MANIFEST_EMPTY'}
$seen=@{}
foreach($entry in $entries){
  $name=[string]$entry.File
  if($name -notmatch '^[A-Za-z][A-Za-z0-9-]+\.ps1$' -or $seen.ContainsKey($name)){
    throw 'INVALID_MANIFEST_ENTRY'
  }
  $seen[$name]=$true
  $file=Join-Path $PSScriptRoot $name
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw 'RECOVERY_FILE_MISSING'}
  $hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  if($hash -cne [string]$entry.Sha256){throw 'RECOVERY_FILE_HASH_MISMATCH'}
}
foreach($required in @(
  'Restore-LocalStack.ps1','Recover-LabTunnel.ps1',
  'Recover-PowerShellDirect.ps1','Recovery-Watchdog.ps1',
  'Register-StackRecovery.ps1',
  'Restore-StackWithReport.ps1'
)){
  if(!$seen.ContainsKey($required)){throw 'RECOVERY_REQUIRED_FILE_UNVERIFIED'}
}
if($Mode -eq 'Verify'){
  Write-Host 'RECOVERY_BUNDLE_CHECKSUMS_PASS_NOT_A_SIGNATURE'
  return
}
if($Mode -eq 'Watchdog'){
  & (Join-Path $PSScriptRoot 'Recovery-Watchdog.ps1') -Attempts 4 -IntervalSeconds 20
} else {
  & (Join-Path $PSScriptRoot 'Restore-LocalStack.ps1') -Mode $Mode
}
