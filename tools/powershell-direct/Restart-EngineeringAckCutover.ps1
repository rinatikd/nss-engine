# One-file Engineering ACK cutover with exact-PID stop, health verification,
# and conditional rollback. Requires explicit local operator authorization.
# Never touches Chrome Bridge 17381/17382 or production credentials.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Rehearse','Restart')][string]$Mode='Inspect',
 [int]$ExpectedSupervisorPid=0,
 [int]$ExpectedTunnelPid=0,
 [switch]$AuthorizeRestart
)
$ErrorActionPreference='Stop'
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$source=Join-Path $repo 'tools\powershell-direct\service.mjs'
$installed=Join-Path $stage 'tools\powershell-direct\service.mjs'
$supervisor=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$backup='C:\Engineering\PowerShellDirect-Engineering-Lab-R1\local-recovery-backups\service-ack-eacfa28d0a094319b36748a0e36909bd.mjs'
$recovery=Join-Path $repo 'tools\powershell-direct\Recover-EngineeringDirect.ps1'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$expectedCurrentHash='4F9DAE6A95B877D1180F45ABAE5A3EE5AE220B7D2CF992814055AFE339D5BBA7'
$expectedPreviousHash='CE2B22E7E77C82FF69685A5AF9441DBC822006F1B21AC74ACD1ED3AA3405D637'
function Sha([string]$f){return (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash}
function Owner([int]$port){
 $l=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($l.Count -gt 1){throw ('ACK_RESTART_AMBIGUOUS_LISTENER_'+$port)}
 if($l.Count -eq 0){return 0}
 return [int]$l[0].OwningProcess
}
function Pair([int]$sid,[int]$tid){
 if($sid -le 0 -or $tid -le 0 -or (Owner 17486) -ne $sid -or (Owner 18086) -ne $tid){
  throw 'ACK_RESTART_PORT_PID_MISMATCH'
 }
 $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$sid) -ErrorAction Stop
 $t=Get-CimInstance Win32_Process -Filter ("ProcessId="+$tid) -ErrorAction Stop
 if(!$p -or $p.Name -ine 'node.exe' -or $p.ExecutablePath -ine $node -or
    !$p.CommandLine -or !$p.CommandLine.Contains($supervisor)){
  throw 'ACK_RESTART_SUPERVISOR_IDENTITY_MISMATCH'
 }
 if(!$t -or $t.Name -ine 'tunnel-client.exe' -or
    $t.ExecutablePath -ine $client -or $t.ParentProcessId -ne $sid){
  throw 'ACK_RESTART_TUNNEL_IDENTITY_MISMATCH'
 }
}
function Healthy([int]$tunnelPid){
 $psi=New-Object Diagnostics.ProcessStartInfo
 $psi.FileName=$client
 $psi.Arguments='health --port 18086 --pid '+$tunnelPid+' --require-control-plane-poll --json'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $process=$null
 try{
  $process=[Diagnostics.Process]::Start($psi)
  if(!$process){return $false}
  if(!$process.WaitForExit(8000)){try{$process.Kill()}catch{};return $false}
  if($process.ExitCode -ne 0){return $false}
  $raw=$process.StandardOutput.ReadToEnd()
  if($raw.Length -gt 16384){return $false}
  $o=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  return ($o.result -eq 'ok' -and $o.healthz.ok -eq $true -and
    $o.readyz.ok -eq $true -and $o.control_plane_poll.ok -eq $true)
 }catch{return $false}finally{if($process){$process.Dispose()}}
}
function StopVerified([int]$sid,[int]$tid){
 Pair $sid $tid
 # Stop exactly the verified child. Supervisor notices the tunnel exit and
 # shuts its own HTTP server down. No unrelated process or port is touched.
 Stop-Process -Id $tid -Force -ErrorAction Stop
 for($i=0;$i -lt 40;$i++){
  if((Owner 17486) -eq 0 -and (Owner 18086) -eq 0){return}
  Start-Sleep -Milliseconds 250
 }
 # Only if the original supervisor still exists with verified identity:
 $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$sid) -ErrorAction SilentlyContinue
 if($p -and $p.Name -ieq 'node.exe' -and $p.ExecutablePath -ieq $node -and
    $p.CommandLine -and $p.CommandLine.Contains($supervisor)){
  Stop-Process -Id $sid -Force -ErrorAction Stop
 }
 for($i=0;$i -lt 30;$i++){
  if((Owner 17486) -eq 0 -and (Owner 18086) -eq 0){return}
  Start-Sleep -Milliseconds 250
 }
 throw 'ACK_RESTART_PORTS_NOT_RELEASED'
}
function WaitHealthy([int]$sid,[int]$tid) {
 # Allow bounded control-plane poll stabilization before deciding failure.
 for($i=0;$i -lt 30;$i++){
  Pair $sid $tid
  if(Healthy $tid){return $true}
  Start-Sleep -Milliseconds 1000
 }
 return $false
}
function CurrentStack {
 $sid=Owner 17486;$tid=Owner 18086
 if($sid -le 0 -or $tid -le 0){return $null}
 try{Pair $sid $tid}catch{return $null}
 return [pscustomobject]@{SupervisorPid=$sid;TunnelPid=$tid}
}
function StartAndVerify {
 if((Owner 17486) -ne 0 -or (Owner 18086) -ne 0){
  throw 'ACK_RESTART_START_PORTS_OCCUPIED'
 }
 $out=& $recovery -Mode Start -AuthorizeLocalRecovery
 $json=($out | Out-String).Trim()
 $result=ConvertFrom-Json -InputObject $json -ErrorAction Stop
 if($result.Result -ne 'LOCAL_LISTENERS_CONFIRMED'){
  throw ('ACK_RESTART_LOCAL_LAUNCH_'+[string]$result.Result)
 }
 $sid=[int]$result.SupervisorPid;$tid=[int]$result.TunnelPid
 Pair $sid $tid
 if(!(WaitHealthy $sid $tid)){throw 'ACK_RESTART_REMOTE_HEALTH_NOT_CONFIRMED_AFTER_30S'}
 return [pscustomobject]@{SupervisorPid=$sid;TunnelPid=$tid}
}
function Result([string]$state,[int]$sid=0,[int]$tid=0,[string]$detail=''){
 [pscustomobject]@{
  Result=$state;SupervisorPid=if($sid){$sid}else{$null}
  TunnelPid=if($tid){$tid}else{$null}
  Detail=$detail
  InstalledSha256=Sha $installed
  SourceSha256=Sha $source
  ProductionChromeBridgeTouched=$false
  ChatGptMcpRoundTripConfirmedByThisScript=$false
 }|ConvertTo-Json
}
if($ExpectedSupervisorPid -le 0 -or $ExpectedTunnelPid -le 0){
 throw 'ACK_RESTART_EXACT_PIDS_REQUIRED'
}
foreach($f in @($source,$installed,$backup,$supervisor,$recovery,$node,$client)){
 if(!(Test-Path -LiteralPath $f -PathType Leaf)){throw 'ACK_RESTART_PREREQUISITE_MISSING'}
}
$installedHash=Sha $installed
if((Sha $source) -ne $expectedCurrentHash -or
   (Sha $backup) -ne $expectedPreviousHash -or
   ($installedHash -ne $expectedCurrentHash -and $installedHash -ne $expectedPreviousHash)){
 throw 'ACK_RESTART_HASH_GUARD_FAILED'
}
# Read-only modes can inspect a verified recovered old stack. Restart can
# only activate the exact new, already-staged module after a fresh check.
if($Mode -eq 'Restart' -and $installedHash -ne $expectedCurrentHash){
 throw 'ACK_RESTART_NEW_MODULE_NOT_STAGED'
}
Pair $ExpectedSupervisorPid $ExpectedTunnelPid
if(!(Healthy $ExpectedTunnelPid)){throw 'ACK_RESTART_OLD_TUNNEL_UNHEALTHY'}
if($Mode -eq 'Inspect' -or $Mode -eq 'Rehearse'){
 # Rehearse is deliberately non-mutating; it also exercises the status
 # classification helpers without stopping or starting any process.
 $stack=CurrentStack
 if(!$stack -or $stack.SupervisorPid -ne $ExpectedSupervisorPid -or
    $stack.TunnelPid -ne $ExpectedTunnelPid){throw 'ACK_REHEARSE_IDENTITY_CHANGED'}
 Result $(if($Mode -eq 'Rehearse'){'ACK_RESTART_REHEARSAL_PASS'}else{'ACK_RESTART_INSPECT_PASS'}) $ExpectedSupervisorPid $ExpectedTunnelPid
 return
}
if(!$AuthorizeRestart){throw 'ACK_RESTART_EXPLICIT_LOCAL_APPROVAL_REQUIRED'}
$phrase=Read-Host 'Type exactly RESTART ENGINEERING ACK 17486'
if($phrase -cne 'RESTART ENGINEERING ACK 17486'){throw 'ACK_RESTART_OPERATOR_DECLINED'}
# Never call the old full Upgrade. This operation changes only the supervisor/tunnel
# process pair and restores the known backup if the new healthy pair cannot start.
StopVerified $ExpectedSupervisorPid $ExpectedTunnelPid
$started=$null
try{
 $started=StartAndVerify
 Result 'ACK_RESTART_HEALTH_VERIFIED_PENDING_CHATGPT_MCP' $started.SupervisorPid $started.TunnelPid
}catch{
 $failure=$_.Exception.Message
 $rollbackFailure=''
 $rollbackStep='INSPECT_NEW_STACK'
 $rollbackComplete=$false
 try{
  $sid=Owner 17486;$tid=Owner 18086
  if($sid -ne 0 -and $tid -ne 0){
   $rollbackStep='VERIFY_NEW_STACK'
   Pair $sid $tid
   $rollbackStep='STOP_NEW_STACK'
   StopVerified $sid $tid
  }elseif($sid -ne 0 -or $tid -ne 0){
   throw 'PARTIAL_STACK_REQUIRES_MANUAL_RECOVERY'
  }
  $rollbackStep='CHECK_FREE_PORTS'
  if((Owner 17486) -ne 0 -or (Owner 18086) -ne 0){
   throw 'ROLLBACK_PORT_CONFLICT'
  }
  $rollbackStep='RESTORE_PREVIOUS_MODULE'
  Copy-Item -LiteralPath $backup -Destination $installed -Force -ErrorAction Stop
  if((Sha $installed) -ne $expectedPreviousHash){throw 'ROLLBACK_HASH_MISMATCH'}
  $rollbackStep='START_PREVIOUS_STACK'
  $restored=StartAndVerify
  $rollbackComplete=$true
  Result 'ACK_RESTART_NEW_FAILED_OLD_RESTORED' $restored.SupervisorPid $restored.TunnelPid $failure
 }catch{
  $rollbackFailure=$_.Exception.Message
  $failedAt=$rollbackStep
  # A delayed health poll can be responsible for a false failure. If the
  # old module is now on disk and a verified stack is currently healthy,
  # classify the rollback as recovered; never terminate it again.
  $rollbackStep='POST_FAILURE_HEALTH_RECHECK'
  $observed=CurrentStack
  if((Sha $installed) -eq $expectedPreviousHash -and $null -ne $observed -and
     (WaitHealthy $observed.SupervisorPid $observed.TunnelPid)){
   Result 'ACK_RESTART_OLD_STACK_RECOVERED_AFTER_DELAY' $observed.SupervisorPid $observed.TunnelPid $failure
  }else{
   # Only fixed/safe diagnostic codes are emitted; avoid raw exception
   # details that might contain paths, process arguments or secrets.
   $codes=@('ACK_RESTART_START_PORTS_OCCUPIED','ACK_RESTART_PORT_PID_MISMATCH',
     'ACK_RESTART_SUPERVISOR_IDENTITY_MISMATCH','ACK_RESTART_TUNNEL_IDENTITY_MISMATCH',
     'ACK_RESTART_REMOTE_HEALTH_NOT_CONFIRMED_AFTER_30S','PARTIAL_STACK_REQUIRES_MANUAL_RECOVERY',
     'ROLLBACK_PORT_CONFLICT','ROLLBACK_HASH_MISMATCH','ACK_RESTART_PORTS_NOT_RELEASED')
   $category=if($codes -contains $rollbackFailure){$rollbackFailure}else{'UNCLASSIFIED_ROLLBACK_ERROR'}
   Result 'ACK_RESTART_FAILED_MANUAL_RECOVERY_REQUIRED' 0 0 ('Stage='+$failedAt+';Failure='+$category)
  }
 }
}
