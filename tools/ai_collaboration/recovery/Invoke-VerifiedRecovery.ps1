# Entrypoint for an explicitly installed Windows recovery release.
# Checks SHA256 manifest before delegating to any recovery script.
[CmdletBinding()]
param([ValidateSet('Verify','Status','Restore','Watchdog')][string]$Mode='Verify')
$ErrorActionPreference='Stop'
$manifestFile=Join-Path $PSScriptRoot 'files.sha256.json'
if(!(Test-Path -LiteralPath $manifestFile -PathType Leaf)){throw 'RECOVERY_MANIFEST_MISSING'}
$parsed=Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$entries=@($parsed)
if($entries.Count -eq 1 -and $entries[0] -is [System.Array]){
  $entries=@($entries[0])
}
$expectedFiles=@(
  'Restore-LocalStack.ps1','Recover-LabTunnel.ps1',
  'Recover-PowerShellDirect.ps1','Save-RecoveryCredential.ps1',
  'Recovery-Watchdog.ps1','Register-StackRecovery.ps1',
  'Get-StackInventory.ps1','Invoke-VerifiedRecovery.ps1',
  'Restore-StackWithReport.ps1'
)
if($entries.Count -ne $expectedFiles.Count){
  throw ('RECOVERY_MANIFEST_COUNT_MISMATCH:'+ $entries.Count)
}
$seen=@{}
foreach($entry in $entries){
  $name=[string]$entry.File
  # Exact locally-reviewed allowlist avoids regex escaping differences
  # in generated manifests and blocks filename traversal.
  if($expectedFiles -cnotcontains $name -or $seen.ContainsKey($name)){
    $safe=if($name -match '^[A-Za-z0-9_.-]{1,100}$'){$name}else{'UNSAFE_NAME'}
    throw ('INVALID_MANIFEST_ENTRY:'+ $safe)
  }
  $seen[$name]=$true
  $file=Join-Path $PSScriptRoot $name
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw ('RECOVERY_FILE_MISSING:'+ $name)}
  $expectedHash=[string]$entry.Sha256
  if($expectedHash -notmatch '^[A-Fa-f0-9]{64}$'){
    throw ('INVALID_MANIFEST_HASH:'+ $name)
  }
  $hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  if($hash -cne $expectedHash.ToUpperInvariant()){
    throw ('RECOVERY_FILE_HASH_MISMATCH:'+ $name)
  }
}
foreach($required in $expectedFiles){
  if(!$seen.ContainsKey($required)){throw ('RECOVERY_REQUIRED_FILE_UNVERIFIED:'+ $required)}
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
