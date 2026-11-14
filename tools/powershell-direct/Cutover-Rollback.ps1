# Shared rollback orchestrator used by BOTH the production cutover catch branch
# and the isolated Windows fault-injection test. Functions alone: NO side effects
# until invoked with explicit operator-controlled scriptblock callbacks.
Set-StrictMode -Version Latest
function Invoke-VerifiedCutoverRollback {
 [CmdletBinding()]
 param(
  [Parameter(Mandatory=$true)][scriptblock]$CleanupReplacement,
  [Parameter(Mandatory=$true)][scriptblock]$RestoreOriginal,
  [Parameter(Mandatory=$true)][scriptblock]$VerifyOriginal,
  [Parameter(Mandatory=$true)][string]$FailureCode
 )
 # Never skip restoration when cleanup fails. But refuse to run Restore when
 # cleanup did not prove ports are free (caller must assert inside callback).
 $cleanupDone=$false
 $restoreDone=$false
 $verified=$false
 $cleanupError=$null;$restoreError=$null;$verifyError=$null
 try{
  & $CleanupReplacement
  $cleanupDone=$true
 }catch{
  $cleanupError=$_.Exception.Message
 }
 if($cleanupDone){
  try{
   & $RestoreOriginal
   $restoreDone=$true
  }catch{
   $restoreError=$_.Exception.Message
  }
 }
 if($restoreDone){
  try{
   $verification=& $VerifyOriginal
   # Explicit true, never trust successful exit alone.
   $verified=($verification -ceq $true)
   if(!$verified){$verifyError='VERIFY_RETURNED_NOT_TRUE'}
  }catch{
   $verifyError=$_.Exception.Message
  }
 }
 [pscustomobject]@{
  Result=if($verified){'ENGINEERING_ROLLBACK_VERIFIED'}else{'ENGINEERING_ROLLBACK_UNCONFIRMED'}
  FailureCode=$FailureCode
  ReplacementCleanupCompleted=$cleanupDone
  OriginalRestoreAttempted=$cleanupDone
  OriginalRestoreCompleted=$restoreDone
  OriginalHealthVerified=$verified
  CleanupFailureCode=$cleanupError
  RestoreFailureCode=$restoreError
  VerifyFailureCode=$verifyError
  ManualRecoveryRequired=(-not $verified)
 }
}

# Called before attempting any cleanup after a failed cutover. If the exact
# original supervisor AND its original child tunnel are still healthy, abort
# recovery without stopping or restarting them. A new process already launched
# must never be ignored.
function Test-OriginalStackStillHealthy {
 [CmdletBinding()]
 param(
  [Parameter(Mandatory=$true)][scriptblock]$InspectOriginal,
  [Parameter(Mandatory=$true)][scriptblock]$VerifyHealth,
  [Parameter(Mandatory=$true)][int]$OriginalSupervisorPid,
  [Parameter(Mandatory=$true)][int]$OriginalTunnelPid,
  [AllowNull()][Nullable[int]]$StartedNewSupervisorPid
 )
 if($null -ne $StartedNewSupervisorPid){return $false}
 $stack=& $InspectOriginal
 if($null -eq $stack){return $false}
 if($stack.SupervisorPid -ne $OriginalSupervisorPid -or
    $stack.TunnelPid -ne $OriginalTunnelPid){return $false}
 return ((& $VerifyHealth $stack) -ceq $true)
}
