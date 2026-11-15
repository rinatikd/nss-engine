# Single-module ACK cutover staging. Never restarts the supervisor/tunnel.
# Requires the exact running process identities observed by the operator.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Apply')][string]$Mode='Inspect',
 [int]$ExpectedSupervisorPid=0,
 [int]$ExpectedTunnelPid=0,
 [switch]$AuthorizeStageUpdate
)
$ErrorActionPreference='Stop'
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$relative='tools\powershell-direct\service.mjs'
$source=Join-Path $repo $relative
$target=Join-Path $stage $relative
$supervisor=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$tests=Join-Path $repo 'tools\powershell-direct\tests\engineering.test.mjs'
function Listener([int]$port){
 $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($listeners.Count -ne 1){throw ('ACK_STAGE_LISTENER_UNVERIFIED_'+$port)}
 return [int]$listeners[0].OwningProcess
}
function Verify-Identity {
 $superPid=Listener 17486
 $tunnelPid=Listener 18086
 if($superPid -ne $ExpectedSupervisorPid -or $tunnelPid -ne $ExpectedTunnelPid){
  throw 'ACK_STAGE_EXPECTED_PID_MISMATCH'
 }
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$superPid" -ErrorAction Stop
 $t=Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelPid" -ErrorAction Stop
 if(!$p -or $p.Name -ine 'node.exe' -or $p.ExecutablePath -ine $node -or
    !$p.CommandLine -or !$p.CommandLine.Contains($supervisor)){
  throw 'ACK_STAGE_SUPERVISOR_UNVERIFIED'
 }
 if(!$t -or $t.Name -ine 'tunnel-client.exe' -or
    $t.ExecutablePath -ine $client -or $t.ParentProcessId -ne $superPid){
  throw 'ACK_STAGE_TUNNEL_UNVERIFIED'
 }
}
function Sha([string]$f){return (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash}
function Result([string]$state,[string]$old='',[string]$backup=''){
 [pscustomobject]@{
  Result=$state;SupervisorPid=$ExpectedSupervisorPid;TunnelPid=$ExpectedTunnelPid
  SourceSha256=(Sha $source);InstalledSha256=(Sha $target)
  PreviousSha256=$old;BackupFile=$backup
  ProcessRestarted=$false;ChromeBridgeTouched=$false
 }|ConvertTo-Json
}
if($ExpectedSupervisorPid -le 0 -or $ExpectedTunnelPid -le 0){
 throw 'ACK_STAGE_EXACT_PID_REQUIRED'
}
foreach($f in @($source,$target,$supervisor,$node,$client,$tests)){
 if(!(Test-Path -LiteralPath $f -PathType Leaf)){throw 'ACK_STAGE_FILE_MISSING'}
}
Verify-Identity
& $node --check $source | Out-Null
if($LASTEXITCODE -ne 0){throw 'ACK_STAGE_SOURCE_SYNTAX_FAILED'}
$sourceHash=Sha $source
$installedHash=Sha $target
if($sourceHash -eq $installedHash){Result 'ACK_STAGE_ALREADY_CURRENT';return}
if($Mode -eq 'Inspect'){Result 'ACK_STAGE_PRECHECK_PASS';return}
if(!$AuthorizeStageUpdate){throw 'ACK_STAGE_OPERATOR_APPROVAL_REQUIRED'}
# Re-validate the exact service and its installed hash before writing.
Verify-Identity
if((Sha $target) -ne $installedHash -or (Sha $source) -ne $sourceHash){
 throw 'ACK_STAGE_FILES_CHANGED'
}
# Put backup outside the live imported module tree; preserve the previous
# staged source for local manual rollback if next process startup fails.
$backupDir=Join-Path $stage 'local-recovery-backups'
if(!(Test-Path -LiteralPath $backupDir -PathType Container)){
 New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}
$backup=Join-Path $backupDir ('service-ack-'+[Guid]::NewGuid().ToString('N')+'.mjs')
Copy-Item -LiteralPath $target -Destination $backup -ErrorAction Stop
if((Sha $backup) -ne $installedHash){throw 'ACK_STAGE_BACKUP_VERIFY_FAILED'}
try{
 Verify-Identity
 Copy-Item -LiteralPath $source -Destination $target -Force -ErrorAction Stop
 if((Sha $target) -ne $sourceHash){throw 'ACK_STAGE_COPY_HASH_MISMATCH'}
 & $node --check $target | Out-Null
 if($LASTEXITCODE -ne 0){throw 'ACK_STAGE_INSTALLED_SYNTAX_FAILED'}
}catch{
 Copy-Item -LiteralPath $backup -Destination $target -Force -ErrorAction Stop
 if((Sha $target) -ne $installedHash){throw 'ACK_STAGE_ROLLBACK_VERIFY_FAILED'}
 throw 'ACK_STAGE_FAILED_ROLLED_BACK'
}
Result 'ACK_SERVICE_MODULE_STAGED_RESTART_REQUIRED' $installedHash $backup
