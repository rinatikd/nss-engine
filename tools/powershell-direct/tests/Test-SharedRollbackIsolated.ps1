# Windows-only isolated real-process fault injection executing the SAME
# Invoke-VerifiedCutoverRollback function as production cutover catch block.
# No tunnel-client, no credentials, no production mutation, no shared Tunnel ID.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$module=Join-Path $PSScriptRoot '..\Cutover-Rollback.ps1'
$fixture=Join-Path $PSScriptRoot 'isolated-rollback-fault.mjs'
$node='C:\Program Files\nodejs\node.exe'
foreach($item in @($module,$fixture,$node)){
 if(!(Test-Path -LiteralPath $item -PathType Leaf)){throw 'ISOLATED_FIXTURE_MISSING'}
}
. $module
$productionPorts=@(17381,17382,17486,18086,18791)
function Get-Owners {
 $results=@()
 foreach($port in $productionPorts){
  $l=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  $results+=[pscustomobject]@{
   Port=$port
   Count=$l.Count
   Owner=if($l.Count -eq 1){[int]$l[0].OwningProcess}else{$null}
  }
 }
 return ,$results
}
function Test-Open([int]$Port){
 $clientObj=New-Object System.Net.Sockets.TcpClient
 try{
  $async=$clientObj.BeginConnect('127.0.0.1',$Port,$null,$null)
  if(!$async.AsyncWaitHandle.WaitOne(180)){return $false}
  try{$clientObj.EndConnect($async);return $true}catch{return $false}
 }finally{$clientObj.Close()}
}
function Wait-Port([int]$Port,[bool]$Open){
 for($n=0;$n -lt 75;$n++){
  if((Test-Open $Port) -eq $Open){return $true}
  Start-Sleep -Milliseconds 40
 }
 return $false
}
function Start-Fixture([string]$Kind,[int]$Port){
 $psi=New-Object System.Diagnostics.ProcessStartInfo
 $psi.FileName=$node
 $psi.Arguments='"'+$fixture+'" child '+$Kind+' '+$Port
 $psi.WorkingDirectory=Split-Path $fixture -Parent
 $psi.UseShellExecute=$false
 $psi.CreateNoWindow=$true
 # Dedicated test fixture only: collect child stderr for diagnosis after exit.
 $psi.RedirectStandardError=$true
 $p=[Diagnostics.Process]::Start($psi)
 if(!$p){throw ('FIXTURE_PROCESS_START_FAILED_'+$Kind)}
 return $p
}
function Stop-Fixture($Process){
 if($null -eq $Process){return}
 try{
  if(!$Process.HasExited){
   $Process.Kill()
   if(!$Process.WaitForExit(4000)){throw 'FIXTURE_TERMINATION_TIMEOUT'}
  }
 }finally{$Process.Dispose()}
}
$initial=Get-Owners
$original=$null;$failed=$null;$restored=$null
$script:cutoverTestRestored=$null
$script:cutoverUnexpectedRestore=$false
$socket=[System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$socket.Start()
$testPort=[int]$socket.LocalEndpoint.Port
$socket.Stop()
if($productionPorts -contains $testPort){throw 'ISOLATED_PORT_COLLISION'}
try{
 $original=Start-Fixture 'original' $testPort
 if(!(Wait-Port $testPort $true)){throw 'ORIGINAL_FIXTURE_NOT_LISTENING'}
 $originalProcessId=[int]$original.Id
 Stop-Fixture $original
 $original=$null
 if(!(Wait-Port $testPort $false)){throw 'ORIGINAL_FIXTURE_NOT_STOPPED'}
 $failed=Start-Fixture 'fail' $testPort
 if(!$failed.WaitForExit(4000) -or $failed.ExitCode -ne 73){
  throw 'REPLACEMENT_FAULT_NOT_OBSERVED'
 }
 if(Test-Open $testPort){throw 'FAILED_REPLACEMENT_OWNS_PORT'}
 $script:cutoverTestRestored=$null
 $cleanup={
  if(Test-Open $testPort){throw 'ISOLATED_PORT_NOT_FREE'}
 }
 $restore={
  $script:cutoverTestRestored=Start-Fixture 'original' $testPort
  if(!(Wait-Port $testPort $true)){throw 'ISOLATED_RESTORE_NOT_LISTENING'}
 }
 $verify={
  return ($null -ne $script:cutoverTestRestored -and
    !$script:cutoverTestRestored.HasExited -and
    $script:cutoverTestRestored.Id -ne $originalProcessId -and
    (Test-Open $testPort))
 }
 $outcome=Invoke-VerifiedCutoverRollback -FailureCode 'INJECTED_EXIT_73' -CleanupReplacement $cleanup -RestoreOriginal $restore -VerifyOriginal $verify
 $restored=$script:cutoverTestRestored
 if(!$outcome.OriginalHealthVerified -or !$outcome.ReplacementCleanupCompleted -or
    !$outcome.OriginalRestoreCompleted){throw 'SHARED_ROLLBACK_NOT_VERIFIED'}
 $restoredAliveAfterRollback=(!$script:cutoverTestRestored.HasExited)
 $portOpenAfterRollback=Test-Open $testPort
 $restoredExitAtRollback=if($script:cutoverTestRestored.HasExited){$script:cutoverTestRestored.ExitCode}else{$null}
 $restoreCalls=0
 $deny=Invoke-VerifiedCutoverRollback -FailureCode 'SIMULATED_CLEANUP_FAILURE' -CleanupReplacement {throw 'INJECTED_CLEANUP_DENIAL'} -RestoreOriginal {$script:cutoverUnexpectedRestore=$true} -VerifyOriginal {$true}
 if($deny.OriginalHealthVerified -or $deny.OriginalRestoreAttempted -or $deny.ManualRecoveryRequired -ne $true -or $script:cutoverUnexpectedRestore){
  throw 'CLEANUP_FAILURE_GATE_FAILED'
 }
 $restoredAliveAfterDeniedCase=(!$script:cutoverTestRestored.HasExited)
 $portOpenAfterDeniedCase=Test-Open $testPort
 # Exercise the exact healthy-original guard shared with production.
 $restoredPid=[int]$script:cutoverTestRestored.Id
 $script:guardExpectedPid=$restoredPid
 $script:guardTestPort=$testPort
 $healthyOriginal=Test-OriginalStackStillHealthy -OriginalSupervisorPid $restoredPid -OriginalTunnelPid 43210 -StartedNewSupervisorPid $null -InspectOriginal {
   [pscustomobject]@{SupervisorPid=$script:guardExpectedPid;TunnelPid=43210}
 } -VerifyHealth {param($candidate) return ($candidate.SupervisorPid -eq $script:guardExpectedPid -and (Test-Open $script:guardTestPort))}
 if(!$healthyOriginal){
  $processPresent=(!$script:cutoverTestRestored.HasExited)
  $portIsOpen=Test-Open $script:guardTestPort
  $exitCode=if($script:cutoverTestRestored.HasExited){$script:cutoverTestRestored.ExitCode}else{$null}
  $fixtureStderrCategory='NO_CHILD_STDERR'
  if($script:cutoverTestRestored.HasExited){
   $fixtureErrorText=$script:cutoverTestRestored.StandardError.ReadToEnd()
   if($fixtureErrorText -match 'EADDRINUSE'){$fixtureStderrCategory='EADDRINUSE'}
   elseif($fixtureErrorText -match 'ERR_INVALID_ARG'){$fixtureStderrCategory='INVALID_ARGUMENT'}
   elseif($fixtureErrorText -match 'AssertionError'){$fixtureStderrCategory='ASSERTION_ERROR'}
   elseif($fixtureErrorText -match 'MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND'){$fixtureStderrCategory='MODULE_NOT_FOUND'}
   elseif($fixtureErrorText -match 'TypeError'){$fixtureStderrCategory='TYPE_ERROR'}
   elseif($fixtureErrorText -match 'SyntaxError'){$fixtureStderrCategory='SYNTAX_ERROR'}
   elseif(![string]::IsNullOrWhiteSpace($fixtureErrorText)){$fixtureStderrCategory='OTHER_NODE_ERROR'}
  }
  throw ('HEALTHY_ORIGINAL_GUARD_FAILED processPresent='+$processPresent+' portOpen='+$portIsOpen+' childExit='+$exitCode+' fixtureStderrCategory='+$fixtureStderrCategory+' exitAfterRollback='+$restoredExitAtRollback+' aliveAfterRollback='+$restoredAliveAfterRollback+' portAfterRollback='+$portOpenAfterRollback+' aliveAfterDeny='+$restoredAliveAfterDeniedCase+' portAfterDeny='+$portOpenAfterDeniedCase)
 }
 $wrongPid=Test-OriginalStackStillHealthy -OriginalSupervisorPid ($restoredPid+1) -OriginalTunnelPid 43210 -StartedNewSupervisorPid $null -InspectOriginal {
   [pscustomobject]@{SupervisorPid=$restoredPid;TunnelPid=43210}
 } -VerifyHealth {$true}
 if($wrongPid){throw 'WRONG_ORIGINAL_PID_ACCEPTED'}
 $newStarted=Test-OriginalStackStillHealthy -OriginalSupervisorPid $restoredPid -OriginalTunnelPid 43210 -StartedNewSupervisorPid 98765 -InspectOriginal {
   [pscustomobject]@{SupervisorPid=$restoredPid;TunnelPid=43210}
 } -VerifyHealth {$true}
 if($newStarted){throw 'PARTIAL_REPLACEMENT_WRONGLY_IGNORED'}
 $after=Get-Owners
 foreach($item in $initial){
  $now=@($after|Where-Object {$_.Port -eq $item.Port})
  if($now.Count -ne 1 -or $now[0].Count -ne $item.Count -or $now[0].Owner -ne $item.Owner){
   throw ('PRODUCTION_PORT_CHANGED_'+$item.Port)
  }
 }
 [pscustomobject]@{
  Result='SHARED_POWERSHELL_ROLLBACK_ISOLATED_PASS'
  ActualSharedRollbackFunctionExecuted=$true
  OriginalProcessStoppedAndRestarted=$true
  ReplacementCrashExitCode=73
  RestoredOriginalHealthy=$true
  VerifiedFailClosedWhenCleanupFails=$true
  HealthyOriginalPreservedByExactPidGuard=$true
  PartialReplacementRequiresCleanup=$true
  ProductionPortOwnershipUnchanged=$true
  ProductionCutoverExecuted=$false
  ProductionRollbackVerified=$false
  TunnelClientStarted=$false
  CredentialsRead=$false
 }|ConvertTo-Json -Depth 4
}finally{
 if($null -ne $script:cutoverTestRestored){Stop-Fixture $script:cutoverTestRestored}
 if($null -ne $failed){Stop-Fixture $failed}
 if($null -ne $original){Stop-Fixture $original}
}
