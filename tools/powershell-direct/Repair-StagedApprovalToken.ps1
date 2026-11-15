# Operator-controlled, single-file staging repair after isolated DPAPI test PASS.
# Does not execute supervisor, tunnel, or modify production Chrome Bridge.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Apply')][string]$Mode='Inspect',
 [switch]$AuthorizeStagedRepair
)
$ErrorActionPreference='Stop'
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$relative='tools\powershell-direct\Save-ApprovalToken.ps1'
$source=Join-Path $repo $relative
$target=Join-Path $stage $relative
$tests=Join-Path $repo 'tools\powershell-direct\tests\Test-ApprovalBootstrap.ps1'
function Report([string]$status,[string]$before=''){
 [pscustomobject]@{
  Result=$status
  SourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
  StagedSha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  PreviousStagedSha256=$before
  SupervisorStarted=$false
  TunnelStarted=$false
  ChromeBridgeTouched=$false
 }|ConvertTo-Json
}
foreach($f in @($source,$target,$tests)){if(!(Test-Path -LiteralPath $f -PathType Leaf)){throw 'REPAIR_FILE_MISSING'}}
$errors=$null;$tokens=$null
[void][System.Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'REPAIR_SOURCE_PARSE_FAILED'}
$sourceHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$targetHash=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if($sourceHash -eq $targetHash){Report 'STAGED_REPAIR_ALREADY_CURRENT';return}
# Refuse changes if either local component is listening or a matching stack is starting.
foreach($port in @(17486,18086)){
 $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($listeners.Count -gt 0){Report 'STAGED_REPAIR_REFUSED_ACTIVE_LISTENER';return}
}
$supervisor=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$running=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
 Where-Object {$_.CommandLine -and $_.CommandLine.Contains($supervisor)})
if($running.Count -gt 0){Report 'STAGED_REPAIR_REFUSED_ACTIVE_SUPERVISOR';return}
$tunnels=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop |
 Where-Object {$_.CommandLine -and $_.CommandLine.Contains('powershell-direct-work')})
if($tunnels.Count -gt 0){Report 'STAGED_REPAIR_REFUSED_ACTIVE_TUNNEL';return}
if($Mode -eq 'Inspect'){Report 'STAGED_REPAIR_PRECHECK_PASS';return}
if(!$AuthorizeStagedRepair){throw 'REPAIR_LOCAL_APPROVAL_REQUIRED'}
# Re-run the actual isolated test in this same transaction.
& powershell.exe -NoProfile -NonInteractive -File $tests | Out-Null
if($LASTEXITCODE -ne 0){throw 'REPAIR_ISOLATED_DPAPI_TEST_FAILED'}
# Guard rechecks before changing any file.
foreach($port in @(17486,18086)){
 if(@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0){
  throw 'REPAIR_PORT_BECAME_OCCUPIED'
 }
}
if(@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
 Where-Object {$_.CommandLine -and $_.CommandLine.Contains($supervisor)}).Count -gt 0){
 throw 'REPAIR_SUPERVISOR_APPEARED'
}
if(@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop |
 Where-Object {$_.CommandLine -and $_.CommandLine.Contains('powershell-direct-work')}).Count -gt 0){
 throw 'REPAIR_TUNNEL_APPEARED'
}
if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $targetHash){throw 'REPAIR_TARGET_CHANGED'}
$backupDirectory=Join-Path $stage 'local-recovery-backups'
if(!(Test-Path -LiteralPath $backupDirectory -PathType Container)){
 New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
}
$backup=Join-Path $backupDirectory ('Save-ApprovalToken-'+([Guid]::NewGuid().ToString('N'))+'.ps1')
Copy-Item -LiteralPath $target -Destination $backup -ErrorAction Stop
if((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $targetHash){throw 'REPAIR_BACKUP_HASH_FAILED'}
try{
 Copy-Item -LiteralPath $source -Destination $target -Force -ErrorAction Stop
 if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $sourceHash){throw 'REPAIR_TARGET_HASH_FAILED'}
}catch{
 Copy-Item -LiteralPath $backup -Destination $target -Force -ErrorAction Stop
 if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $targetHash){throw 'REPAIR_ROLLBACK_HASH_FAILED'}
 throw
}
Report 'STAGED_TOKEN_WRITER_REPAIRED' $targetHash
