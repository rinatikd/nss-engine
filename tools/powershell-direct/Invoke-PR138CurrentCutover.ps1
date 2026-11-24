# Operator-only, fail-closed PR138 current-head PowerShell Direct cutover.
# Rehearse is read-only. Cutover requires explicit switches AND local host approval.
# Never prints secrets or invokes any other live tunnel than the VERIFIED child.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Rehearse','Cutover')][string]$Mode='Inspect',
 [switch]$RemoteAuthenticationVerified,
 [switch]$EnableProductionCutover,
 [switch]$ConfirmExactCutover,
 [string]$TransactionId=''
)
$ErrorActionPreference='Stop'
$rollbackModule=Join-Path $PSScriptRoot 'Cutover-Rollback.ps1'
if(!(Test-Path -LiteralPath $rollbackModule -PathType Leaf)){throw 'ROLLBACK_MODULE_MISSING'}
. $rollbackModule
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R2-PR138-35e69e7'
$old='C:\Engineering\PowerShellDirect-Engineering-Lab-R1\tools\powershell-direct\stack-supervisor.mjs'
$new=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$recover=Join-Path $repo 'tools\powershell-direct\Recover-EngineeringDirect.ps1'
$prepared=Join-Path $repo 'tools\powershell-direct\Prepare-PR138CurrentCutover.ps1'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$audit='C:\Engineering\PowerShellDirect-Engineering-Audit-R2-PR138-35e69e7'
$transactionAudit='C:\Engineering\PowerShellDirect-Cutover-Audit-PR138-35e69e7'
$script:journalSequence=0
$testPaths=@(
 'tools/powershell-direct/tests/engineering.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/workspace-policy.test.mjs',
 'tools/ai_collaboration/local_mcp_dispatch.test.mjs',
 'tools/powershell-direct/tests/service.test.mjs',
 'tools/ai_collaboration/local_test_runner.test.mjs'
)
function Write-TransactionJournal([string]$State,[int]$SupervisorPid=0,[int]$TunnelPid=0,[string]$FailureCode=''){
 if($TransactionId -notmatch '^[a-zA-Z0-9_-]{8,80}
 $connections=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
 # A missing listener may be expected during transition. Two or more
 # listeners are NEVER a free port: abort before starting any replacement.
 if($connections.Count -gt 1){throw ('AMBIGUOUS_LISTENER_'+$Port)}
 if($connections.Count -eq 0){return $null}
 return [int]$connections[0].OwningProcess
}
function Get-Identity([int]$Id,[string]$Script){
 if($Id -le 0){return $null}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
 if($null -eq $p -or $p.Name -ine 'node.exe' -or
    $p.ExecutablePath -ine $node -or
    [string]::IsNullOrEmpty($p.CommandLine) -or
    !$p.CommandLine.Contains($Script)){return $null}
 return $p
}
function Get-ChildTunnel([int]$Parent){
 $all=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop)
 $found=@($all | Where-Object {
  $_.ParentProcessId -eq $Parent -and $_.ExecutablePath -ieq $client
 })
 if($found.Count -ne 1){return $null}
 return $found[0]
}
function Get-Stack([string]$Script){
 $superPid=Get-Listener 17486
 if($null -eq $superPid){return $null}
 $supervisor=Get-Identity $superPid $Script
 if($null -eq $supervisor){return $null}
 $child=Get-ChildTunnel $superPid
 if($null -eq $child -or (Get-Listener 18086) -ne [int]$child.ProcessId){return $null}
 return [pscustomobject]@{SupervisorPid=$superPid;TunnelPid=[int]$child.ProcessId;Script=$Script}
}
function Stop-ExactStack($stack){
 if($null -eq $stack){throw 'STACK_IDENTIFICATION_MISSING'}
 $current=Get-Stack $stack.Script
 if($null -eq $current -or $current.SupervisorPid -ne $stack.SupervisorPid -or
     $current.TunnelPid -ne $stack.TunnelPid){throw 'STACK_IDENTITY_CHANGED'}
 # Stop only the VERIFIED parent and its VERIFIED direct tunnel.
 Stop-Process -Id $stack.SupervisorPid -Force -ErrorAction Stop
 Start-Sleep -Milliseconds 700
 $remaining=Get-CimInstance Win32_Process -Filter "ProcessId=$($stack.TunnelPid)" -ErrorAction SilentlyContinue
 if($null -ne $remaining -and $remaining.Name -ieq 'tunnel-client.exe' -and
    $remaining.ExecutablePath -ieq $client -and
    $remaining.ParentProcessId -eq $stack.SupervisorPid){
  Stop-Process -Id $stack.TunnelPid -Force -ErrorAction Stop
 }
 $freed=$false
 for($i=0;$i -lt 30;$i++){
  if($null -eq (Get-Listener 17486) -and $null -eq (Get-Listener 18086)){
   $freed=$true;break
  }
  Start-Sleep -Milliseconds 400
 }
 if(!$freed){throw 'STACK_PORTS_NOT_RELEASED'}
}
function Assert-Preflight {
 if(!(Test-Path -LiteralPath $prepared -PathType Leaf)){throw 'PREFLIGHT_MISSING'}
 $result=(& powershell.exe -NoProfile -NonInteractive -File $prepared -Mode Inspect | Out-String)
 if($LASTEXITCODE -ne 0){throw 'PREFLIGHT_FAILED'}
 $object=ConvertFrom-Json -InputObject $result -ErrorAction Stop
 if($object.ReadyToDraftOperatorTransaction -ne $true){throw 'PREFLIGHT_NOT_READY'}
 if(!(Test-Path -LiteralPath $recover -PathType Leaf) -or
    !(Test-Path -LiteralPath $credential -PathType Leaf)){throw 'RECOVERY_PREREQUISITE_MISSING'}
 return $object
}
function Test-Health([int]$TunnelPid){
 # ProcessStartInfo avoids native pipeline issues in Windows PowerShell 5.1.
 # This command probes only the verified existing tunnel daemon.
 $psi=New-Object Diagnostics.ProcessStartInfo
 $psi.FileName=$client
 $psi.Arguments='health --port 18086 --pid '+$TunnelPid+' --require-control-plane-poll --json'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $child=$null
 try{
  $child=[Diagnostics.Process]::Start($psi)
  if(!$child){return $false}
  $outTask=$child.StandardOutput.ReadToEndAsync()
  $errTask=$child.StandardError.ReadToEndAsync()
  if(!$child.WaitForExit(10000)){try{$child.Kill()}catch{};return $false}
  $raw=$outTask.GetAwaiter().GetResult()
  $null=$errTask.GetAwaiter().GetResult()
  if($child.ExitCode -ne 0 -or $raw.Length -gt 32768){return $false}
  $j=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  return ($j.result -eq 'ok' -and $j.healthz.ok -eq $true -and
    $j.readyz.ok -eq $true -and $j.control_plane_poll.ok -eq $true)
 }catch{return $false}
 finally{if($child){$child.Dispose()}}
}
function Start-Engineering {
 New-Item -ItemType Directory -Path $audit -Force | Out-Null
 $sec=$null;$ptr=[IntPtr]::Zero;$plain=$null;$psi=$null
 try{
  $sec=ConvertTo-SecureString -String ((Get-Content -LiteralPath $credential -Raw -Encoding UTF8).Trim()) -ErrorAction Stop
  if($sec.Length -lt 8){throw 'KEY_EMPTY'}
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if([string]::IsNullOrWhiteSpace($plain)){throw 'KEY_EMPTY'}
  if((Get-Listener 17486) -or (Get-Listener 18086)){throw 'PORTS_NOT_FREE'}
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$node
  $psi.Arguments='"'+$new+'"'
  $psi.WorkingDirectory=Split-Path $new -Parent
  $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
  $psi.EnvironmentVariables['PS_DIRECT_TUNNEL_CLIENT']=$client
  $psi.EnvironmentVariables['CONTROL_PLANE_API_KEY']=$plain
  $psi.EnvironmentVariables['PS_DIRECT_ENGINEERING_AUDIT_DIR']=$audit
  $process=[Diagnostics.Process]::Start($psi)
  if($null -eq $process){throw 'SUPERVISOR_START_FAILED'}
  return [int]$process.Id
 }finally{
  if($psi){$psi.EnvironmentVariables.Remove('CONTROL_PLANE_API_KEY') | Out-Null}
  $plain=$null
  if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  if($sec){$sec.Dispose()}
 }
}
function Restore-Original {
 # Restore the exact live R1 stack via its own recovery script.
 # Called only after cleanup proved both replacement ports are free.
 if((Get-Listener 17486) -or (Get-Listener 18086)){throw 'ROLLBACK_PORTS_OCCUPIED'}
 $psi=New-Object Diagnostics.ProcessStartInfo
 $psi.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
 $psi.Arguments='-NoProfile -NonInteractive -File "'+$recover+'" -Mode Start -AuthorizeLocalRecovery'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $child=$null
 try{
  $child=[Diagnostics.Process]::Start($psi)
  if(!$child){throw 'R1_RECOVERY_START_FAILED'}
  $outTask=$child.StandardOutput.ReadToEndAsync()
  $errTask=$child.StandardError.ReadToEndAsync()
  if(!$child.WaitForExit(20000)){try{$child.Kill()}catch{};throw 'R1_RECOVERY_TIMEOUT'}
  $null=$outTask.GetAwaiter().GetResult()
  $null=$errTask.GetAwaiter().GetResult()
  if($child.ExitCode -ne 0){throw 'R1_RECOVERY_SCRIPT_FAILED'}
  for($i=0;$i -lt 50;$i++){
   $originalStack=Get-Stack $old
   if($null -ne $originalStack -and (Test-Health $originalStack.TunnelPid)){return $originalStack}
   Start-Sleep -Milliseconds 600
  }
  throw 'R1_RECOVERY_HEALTH_NOT_CONFIRMED'
 }finally{if($child){$child.Dispose()}}
}
if($Mode -eq 'Inspect'){
 $ready=$false
 try{$null=Assert-Preflight;$ready=$true}catch{}
 [pscustomobject]@{
  Result='ENGINEERING_CUTOVER_TRANSACTION_INSPECT'
  PreflightReady=$ready
  ExistingStackVerified=($null -ne (Get-Stack $old))
  CurrentTunnelHealthy=if($null -ne ($stack=Get-Stack $old)){Test-Health $stack.TunnelPid}else{$false}
  RequireExplicitOperatorApproval=$true
  CutoverExecuted=$false
  ProductionChanged=$false
 }|ConvertTo-Json
 return
}
if($Mode -eq 'Rehearse'){
 $null=Assert-Preflight
 $existing=Get-Stack $old
 if($null -eq $existing -or !(Test-Health $existing.TunnelPid)){throw 'PRODUCTION_STACK_NOT_HEALTHY'}
 Push-Location $stage
 try{
  & $node --test @testPaths
  if($LASTEXITCODE -ne 0){throw 'STAGE_TESTS_FAILED'}
  & $node 'tools/powershell-direct/tests/engineering-smoke.mjs'
  if($LASTEXITCODE -ne 0){throw 'STAGE_SMOKE_FAILED'}
 }finally{Pop-Location}
 $again=Get-Stack $old
 if($null -eq $again -or $again.SupervisorPid -ne $existing.SupervisorPid -or
    $again.TunnelPid -ne $existing.TunnelPid){throw 'PRODUCTION_CHANGED_DURING_REHEARSAL'}
 [pscustomobject]@{
  Result='ENGINEERING_CUTOVER_REHEARSAL_PASS'
  StageTestsPassed=$true
  StageMcpSmokePassed=$true
  ProductionUnchanged=$true
  ProductionCutoverExecuted=$false
  Note='Rehearsal tests staging, NOT a real production shutdown or rollback'
 }|ConvertTo-Json
 return
}
# Production mutation requires three explicit switches AND the immutable
# operation plan to be approved by the genuine local PowerShell Direct UI.
if(!$EnableProductionCutover -or !$RemoteAuthenticationVerified -or !$ConfirmExactCutover){
 throw 'PRODUCTION_CUTOVER_REQUIRES_EXPLICIT_SWITCHES_AND_HOST_APPROVAL'
}
if($TransactionId -notmatch '^[a-zA-Z0-9_-]{8,80}$'){throw 'CUTOVER_TRANSACTION_ID_REQUIRED'}
$null=Assert-Preflight
$oldStack=Get-Stack $old
if($null -eq $oldStack -or !(Test-Health $oldStack.TunnelPid)){throw 'ORIGINAL_NOT_HEALTHY'}
$startedNew=$false;$newPid=$null;$rollbackVerified=$false
try{
 Write-TransactionJournal -State 'APPROVED_READY_TO_STOP' -SupervisorPid $oldStack.SupervisorPid -TunnelPid $oldStack.TunnelPid
 Stop-ExactStack $oldStack
 Write-TransactionJournal -State 'R1_STOPPED' -SupervisorPid $oldStack.SupervisorPid -TunnelPid $oldStack.TunnelPid
 $newPid=Start-Engineering
 Write-TransactionJournal -State 'R2_SUPERVISOR_STARTED' -SupervisorPid $newPid
 $newStack=$null
 for($i=0;$i -lt 50;$i++){
  $newStack=Get-Stack $new
  if($null -ne $newStack -and (Test-Health $newStack.TunnelPid)){break}
  Start-Sleep -Milliseconds 600
 }
 if($null -eq $newStack -or !(Test-Health $newStack.TunnelPid)){throw 'ENGINEERING_STACK_UNHEALTHY'}
 $startedNew=$true
 Write-TransactionJournal -State 'R2_STACK_HEALTHY' -SupervisorPid $newStack.SupervisorPid -TunnelPid $newStack.TunnelPid
 Write-TransactionJournal -State 'CUTOVER_COMPLETED_LOCAL_HEALTH' -SupervisorPid $newStack.SupervisorPid -TunnelPid $newStack.TunnelPid
 [pscustomobject]@{
  Result='ENGINEERING_CUTOVER_LOCAL_HEALTH_PASS'
  NewSupervisorPid=$newStack.SupervisorPid
  NewTunnelPid=$newStack.TunnelPid
  NewMcpToolsRemotelyDiscovered=$false
  ProductionChanged=$true
  Note='Must verify MCP tool discovery and a real approved engineering job in ChatGPT'
 }|ConvertTo-Json
}catch{
 $reason=$_.Exception.Message
 # If Stop-ExactStack refused before shutdown and the exact original pair
 # is STILL healthy, never kill/restart it. No replacement may have started.
 $untouchedOriginal=Test-OriginalStackStillHealthy `
   -OriginalSupervisorPid $oldStack.SupervisorPid `
   -OriginalTunnelPid $oldStack.TunnelPid `
   -StartedNewSupervisorPid $newPid `
   -InspectOriginal { Get-Stack $old } `
   -VerifyHealth { param($candidate) Test-Health $candidate.TunnelPid }
 if($untouchedOriginal){
   Write-TransactionJournal -State 'CUTOVER_ABORTED_R1_UNCHANGED' -SupervisorPid $oldStack.SupervisorPid -TunnelPid $oldStack.TunnelPid -FailureCode $reason
  [pscustomobject]@{
   Result='ENGINEERING_CUTOVER_ABORTED_ORIGINAL_STILL_HEALTHY'
   FailureReason=$reason
   OriginalSupervisorPid=$oldStack.SupervisorPid
   OriginalTunnelPid=$oldStack.TunnelPid
   NoCleanupAttempted=$true
   NoRestoreAttempted=$true
   OriginalHealthVerified=$true
   ProductionChanged=$false
  }|ConvertTo-Json
  throw 'ENGINEERING_CUTOVER_ABORTED_ORIGINAL_UNCHANGED'
 }
 Write-TransactionJournal -State 'ROLLBACK_IN_PROGRESS' -SupervisorPid $oldStack.SupervisorPid -TunnelPid $oldStack.TunnelPid -FailureCode $reason
  $script:rollbackRestoredStack=$null
 $script:rollbackNewSupervisorPid=$newPid
 $script:rollbackOldStack=$oldStack
 $cleanup={
    $candidate=Get-Stack $new
    if($null -ne $candidate){
      Stop-ExactStack $candidate
    }elseif($script:rollbackNewSupervisorPid -and
      $null -ne (Get-Identity $script:rollbackNewSupervisorPid $new)){
      # A half-started new supervisor may have zero, one or several children.
      # Never guess which process is ours when parent/child relation ambiguous.
      $allChildren=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop |
        Where-Object {$_.ParentProcessId -eq $script:rollbackNewSupervisorPid -and
          $_.ExecutablePath -ieq $client})
      if($allChildren.Count -gt 1){throw 'PARTIAL_NEW_CHILD_AMBIGUOUS'}
      if($allChildren.Count -eq 1){
        $partialChild=$allChildren[0]
        $partialPid=[int]$partialChild.ProcessId
        $healthOwner=Get-Listener 18086
        if($null -ne $healthOwner -and $healthOwner -ne $partialPid){
          throw 'PARTIAL_NEW_HEALTH_PORT_OWNED_BY_OTHER_PROCESS'
        }
        Stop-Process -Id $partialPid -Force -ErrorAction Stop
      }
      $parentStill=Get-Identity $script:rollbackNewSupervisorPid $new
      if($null -ne $parentStill){
        Stop-Process -Id $script:rollbackNewSupervisorPid -Force -ErrorAction Stop
      }
    }
    $oldChild=Get-CimInstance Win32_Process -Filter "ProcessId=$($script:rollbackOldStack.TunnelPid)" -ErrorAction SilentlyContinue
    if($null -ne $oldChild -and $oldChild.Name -ieq 'tunnel-client.exe' -and
       $oldChild.ExecutablePath -ieq $client -and
       $oldChild.ParentProcessId -eq $script:rollbackOldStack.SupervisorPid){
      Stop-Process -Id $script:rollbackOldStack.TunnelPid -Force -ErrorAction Stop
    }
    for($i=0;$i -lt 30;$i++){
      if($null -eq (Get-Listener 17486) -and
         $null -eq (Get-Listener 18086)){return}
      Start-Sleep -Milliseconds 400
    }
    throw 'ROLLBACK_PORTS_STILL_OCCUPIED'
 }
 $restore={ $script:rollbackRestoredStack=Restore-Original }
 $verify={
    $stackNow=Get-Stack $old
    return ($null -ne $stackNow -and
      $null -ne $script:rollbackRestoredStack -and
      $stackNow.SupervisorPid -eq $script:rollbackRestoredStack.SupervisorPid -and
      $stackNow.TunnelPid -eq $script:rollbackRestoredStack.TunnelPid -and
      (Test-Health $stackNow.TunnelPid))
 }
 $outcome=Invoke-VerifiedCutoverRollback -FailureCode $reason -CleanupReplacement $cleanup -RestoreOriginal $restore -VerifyOriginal $verify
  Write-TransactionJournal -State $(if($outcome.OriginalHealthVerified){'ROLLBACK_VERIFIED'}else{'ROLLBACK_UNCONFIRMED'}) -SupervisorPid $oldStack.SupervisorPid -TunnelPid $oldStack.TunnelPid -FailureCode $reason
 [pscustomobject]@{
   Result=if($outcome.OriginalHealthVerified){
     'ENGINEERING_CUTOVER_FAILED_ROLLBACK_VERIFIED'
   }else{'ENGINEERING_CUTOVER_FAILED_ROLLBACK_UNCONFIRMED'}
   FailureReason=$reason
   Rollback=$outcome
   ManualLocalRecoveryRequired=(-not $outcome.OriginalHealthVerified)
   DoNotStopOtherTunnels=$true
 }|ConvertTo-Json -Depth 5
 throw 'ENGINEERING_CUTOVER_NOT_COMPLETED'
}
){throw 'CUTOVER_TRANSACTION_ID_REQUIRED'}
 if(!(Test-Path -LiteralPath $transactionAudit -PathType Container)){
  if(!(Test-Path -LiteralPath 'C:\Engineering' -PathType Container)){throw 'CUTOVER_AUDIT_PARENT_MISSING'}
  $null=New-Item -ItemType Directory -Path $transactionAudit -ErrorAction Stop
 }
 $item=Get-Item -LiteralPath $transactionAudit -Force
 if(!$item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){
  throw 'CUTOVER_AUDIT_DIRECTORY_UNSAFE'
 }
 $script:journalSequence++
 $record=[ordered]@{
  TransactionId=$TransactionId;State=$State;Sequence=$script:journalSequence
  TimestampUtc=[DateTime]::UtcNow.ToString('o')
  CandidateCommit='35e69e7e58c7e1b054a0771cabce07cc0c4108df'
  SupervisorPid=if($SupervisorPid -gt 0){$SupervisorPid}else{$null}
  TunnelPid=if($TunnelPid -gt 0){$TunnelPid}else{$null}
  FailureCode=if([string]::IsNullOrWhiteSpace($FailureCode)){$null}else{$FailureCode}
  SecretsEmitted=$false;Production17381And17382Touched=$false
 }
 $file=Join-Path $transactionAudit ($TransactionId+'.'+$script:journalSequence.ToString('00')+'.json')
 [IO.File]::WriteAllText($file,($record|ConvertTo-Json -Depth 4),(New-Object System.Text.UTF8Encoding($false)))
}
function Get-Listener([int]$Port){
 $connections=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
 # A missing listener may be expected during transition. Two or more
 # listeners are NEVER a free port: abort before starting any replacement.
 if($connections.Count -gt 1){throw ('AMBIGUOUS_LISTENER_'+$Port)}
 if($connections.Count -eq 0){return $null}
 return [int]$connections[0].OwningProcess
}
function Get-Identity([int]$Id,[string]$Script){
 if($Id -le 0){return $null}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
 if($null -eq $p -or $p.Name -ine 'node.exe' -or
    $p.ExecutablePath -ine $node -or
    [string]::IsNullOrEmpty($p.CommandLine) -or
    !$p.CommandLine.Contains($Script)){return $null}
 return $p
}
function Get-ChildTunnel([int]$Parent){
 $all=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop)
 $found=@($all | Where-Object {
  $_.ParentProcessId -eq $Parent -and $_.ExecutablePath -ieq $client
 })
 if($found.Count -ne 1){return $null}
 return $found[0]
}
function Get-Stack([string]$Script){
 $superPid=Get-Listener 17486
 if($null -eq $superPid){return $null}
 $supervisor=Get-Identity $superPid $Script
 if($null -eq $supervisor){return $null}
 $child=Get-ChildTunnel $superPid
 if($null -eq $child -or (Get-Listener 18086) -ne [int]$child.ProcessId){return $null}
 return [pscustomobject]@{SupervisorPid=$superPid;TunnelPid=[int]$child.ProcessId;Script=$Script}
}
function Stop-ExactStack($stack){
 if($null -eq $stack){throw 'STACK_IDENTIFICATION_MISSING'}
 $current=Get-Stack $stack.Script
 if($null -eq $current -or $current.SupervisorPid -ne $stack.SupervisorPid -or
     $current.TunnelPid -ne $stack.TunnelPid){throw 'STACK_IDENTITY_CHANGED'}
 # Stop only the VERIFIED parent and its VERIFIED direct tunnel.
 Stop-Process -Id $stack.SupervisorPid -Force -ErrorAction Stop
 Start-Sleep -Milliseconds 700
 $remaining=Get-CimInstance Win32_Process -Filter "ProcessId=$($stack.TunnelPid)" -ErrorAction SilentlyContinue
 if($null -ne $remaining -and $remaining.Name -ieq 'tunnel-client.exe' -and
    $remaining.ExecutablePath -ieq $client -and
    $remaining.ParentProcessId -eq $stack.SupervisorPid){
  Stop-Process -Id $stack.TunnelPid -Force -ErrorAction Stop
 }
 $freed=$false
 for($i=0;$i -lt 30;$i++){
  if($null -eq (Get-Listener 17486) -and $null -eq (Get-Listener 18086)){
   $freed=$true;break
  }
  Start-Sleep -Milliseconds 400
 }
 if(!$freed){throw 'STACK_PORTS_NOT_RELEASED'}
}
function Assert-Preflight {
 if(!(Test-Path -LiteralPath $prepared -PathType Leaf)){throw 'PREFLIGHT_MISSING'}
 $result=(& powershell.exe -NoProfile -NonInteractive -File $prepared -Mode Inspect | Out-String)
 if($LASTEXITCODE -ne 0){throw 'PREFLIGHT_FAILED'}
 $object=ConvertFrom-Json -InputObject $result -ErrorAction Stop
 if($object.ReadyToDraftOperatorTransaction -ne $true){throw 'PREFLIGHT_NOT_READY'}
 if(!(Test-Path -LiteralPath $recover -PathType Leaf) -or
    !(Test-Path -LiteralPath $credential -PathType Leaf)){throw 'RECOVERY_PREREQUISITE_MISSING'}
 return $object
}
function Test-Health([int]$TunnelPid){
 # ProcessStartInfo avoids native pipeline issues in Windows PowerShell 5.1.
 # This command probes only the verified existing tunnel daemon.
 $psi=New-Object Diagnostics.ProcessStartInfo
 $psi.FileName=$client
 $psi.Arguments='health --port 18086 --pid '+$TunnelPid+' --require-control-plane-poll --json'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $child=$null
 try{
  $child=[Diagnostics.Process]::Start($psi)
  if(!$child){return $false}
  $outTask=$child.StandardOutput.ReadToEndAsync()
  $errTask=$child.StandardError.ReadToEndAsync()
  if(!$child.WaitForExit(10000)){try{$child.Kill()}catch{};return $false}
  $raw=$outTask.GetAwaiter().GetResult()
  $null=$errTask.GetAwaiter().GetResult()
  if($child.ExitCode -ne 0 -or $raw.Length -gt 32768){return $false}
  $j=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  return ($j.result -eq 'ok' -and $j.healthz.ok -eq $true -and
    $j.readyz.ok -eq $true -and $j.control_plane_poll.ok -eq $true)
 }catch{return $false}
 finally{if($child){$child.Dispose()}}
}
function Start-Engineering {
 New-Item -ItemType Directory -Path $audit -Force | Out-Null
 $sec=$null;$ptr=[IntPtr]::Zero;$plain=$null;$psi=$null
 try{
  $sec=ConvertTo-SecureString -String ((Get-Content -LiteralPath $credential -Raw -Encoding UTF8).Trim()) -ErrorAction Stop
  if($sec.Length -lt 8){throw 'KEY_EMPTY'}
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if([string]::IsNullOrWhiteSpace($plain)){throw 'KEY_EMPTY'}
  if((Get-Listener 17486) -or (Get-Listener 18086)){throw 'PORTS_NOT_FREE'}
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$node
  $psi.Arguments='"'+$new+'"'
  $psi.WorkingDirectory=Split-Path $new -Parent
  $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
  $psi.EnvironmentVariables['PS_DIRECT_TUNNEL_CLIENT']=$client
  $psi.EnvironmentVariables['CONTROL_PLANE_API_KEY']=$plain
  $psi.EnvironmentVariables['PS_DIRECT_ENGINEERING_AUDIT_DIR']=$audit
  $process=[Diagnostics.Process]::Start($psi)
  if($null -eq $process){throw 'SUPERVISOR_START_FAILED'}
  return [int]$process.Id
 }finally{
  if($psi){$psi.EnvironmentVariables.Remove('CONTROL_PLANE_API_KEY') | Out-Null}
  $plain=$null
  if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  if($sec){$sec.Dispose()}
 }
}
function Restore-Original {
 # Restore the exact live R1 stack via its own recovery script.
 # Called only after cleanup proved both replacement ports are free.
 if((Get-Listener 17486) -or (Get-Listener 18086)){throw 'ROLLBACK_PORTS_OCCUPIED'}
 $psi=New-Object Diagnostics.ProcessStartInfo
 $psi.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
 $psi.Arguments='-NoProfile -NonInteractive -File "'+$recover+'" -Mode Start -AuthorizeLocalRecovery'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $child=$null
 try{
  $child=[Diagnostics.Process]::Start($psi)
  if(!$child){throw 'R1_RECOVERY_START_FAILED'}
  $outTask=$child.StandardOutput.ReadToEndAsync()
  $errTask=$child.StandardError.ReadToEndAsync()
  if(!$child.WaitForExit(20000)){try{$child.Kill()}catch{};throw 'R1_RECOVERY_TIMEOUT'}
  $null=$outTask.GetAwaiter().GetResult()
  $null=$errTask.GetAwaiter().GetResult()
  if($child.ExitCode -ne 0){throw 'R1_RECOVERY_SCRIPT_FAILED'}
  for($i=0;$i -lt 50;$i++){
   $originalStack=Get-Stack $old
   if($null -ne $originalStack -and (Test-Health $originalStack.TunnelPid)){return $originalStack}
   Start-Sleep -Milliseconds 600
  }
  throw 'R1_RECOVERY_HEALTH_NOT_CONFIRMED'
 }finally{if($child){$child.Dispose()}}
}
if($Mode -eq 'Inspect'){
 $ready=$false
 try{$null=Assert-Preflight;$ready=$true}catch{}
 [pscustomobject]@{
  Result='ENGINEERING_CUTOVER_TRANSACTION_INSPECT'
  PreflightReady=$ready
  ExistingStackVerified=($null -ne (Get-Stack $old))
  CurrentTunnelHealthy=if($null -ne ($stack=Get-Stack $old)){Test-Health $stack.TunnelPid}else{$false}
  RequireExplicitOperatorApproval=$true
  CutoverExecuted=$false
  ProductionChanged=$false
 }|ConvertTo-Json
 return
}
if($Mode -eq 'Rehearse'){
 $null=Assert-Preflight
 $existing=Get-Stack $old
 if($null -eq $existing -or !(Test-Health $existing.TunnelPid)){throw 'PRODUCTION_STACK_NOT_HEALTHY'}
 Push-Location $stage
 try{
  & $node --test @testPaths
  if($LASTEXITCODE -ne 0){throw 'STAGE_TESTS_FAILED'}
  & $node 'tools/powershell-direct/tests/engineering-smoke.mjs'
  if($LASTEXITCODE -ne 0){throw 'STAGE_SMOKE_FAILED'}
 }finally{Pop-Location}
 $again=Get-Stack $old
 if($null -eq $again -or $again.SupervisorPid -ne $existing.SupervisorPid -or
    $again.TunnelPid -ne $existing.TunnelPid){throw 'PRODUCTION_CHANGED_DURING_REHEARSAL'}
 [pscustomobject]@{
  Result='ENGINEERING_CUTOVER_REHEARSAL_PASS'
  StageTestsPassed=$true
  StageMcpSmokePassed=$true
  ProductionUnchanged=$true
  ProductionCutoverExecuted=$false
  Note='Rehearsal tests staging, NOT a real production shutdown or rollback'
 }|ConvertTo-Json
 return
}
# Production mutation requires three explicit switches AND the immutable
# operation plan to be approved by the genuine local PowerShell Direct UI.
if(!$EnableProductionCutover -or !$RemoteAuthenticationVerified -or !$ConfirmExactCutover){
 throw 'PRODUCTION_CUTOVER_REQUIRES_EXPLICIT_SWITCHES_AND_HOST_APPROVAL'
}
$null=Assert-Preflight
$oldStack=Get-Stack $old
if($null -eq $oldStack -or !(Test-Health $oldStack.TunnelPid)){throw 'ORIGINAL_NOT_HEALTHY'}
$startedNew=$false;$newPid=$null;$rollbackVerified=$false
try{
 Stop-ExactStack $oldStack
 $newPid=Start-Engineering
 $newStack=$null
 for($i=0;$i -lt 50;$i++){
  $newStack=Get-Stack $new
  if($null -ne $newStack -and (Test-Health $newStack.TunnelPid)){break}
  Start-Sleep -Milliseconds 600
 }
 if($null -eq $newStack -or !(Test-Health $newStack.TunnelPid)){throw 'ENGINEERING_STACK_UNHEALTHY'}
 $startedNew=$true
 [pscustomobject]@{
  Result='ENGINEERING_CUTOVER_LOCAL_HEALTH_PASS'
  NewSupervisorPid=$newStack.SupervisorPid
  NewTunnelPid=$newStack.TunnelPid
  NewMcpToolsRemotelyDiscovered=$false
  ProductionChanged=$true
  Note='Must verify MCP tool discovery and a real approved engineering job in ChatGPT'
 }|ConvertTo-Json
}catch{
 $reason=$_.Exception.Message
 # If Stop-ExactStack refused before shutdown and the exact original pair
 # is STILL healthy, never kill/restart it. No replacement may have started.
 $untouchedOriginal=Test-OriginalStackStillHealthy `
   -OriginalSupervisorPid $oldStack.SupervisorPid `
   -OriginalTunnelPid $oldStack.TunnelPid `
   -StartedNewSupervisorPid $newPid `
   -InspectOriginal { Get-Stack $old } `
   -VerifyHealth { param($candidate) Test-Health $candidate.TunnelPid }
 if($untouchedOriginal){
  [pscustomobject]@{
   Result='ENGINEERING_CUTOVER_ABORTED_ORIGINAL_STILL_HEALTHY'
   FailureReason=$reason
   OriginalSupervisorPid=$oldStack.SupervisorPid
   OriginalTunnelPid=$oldStack.TunnelPid
   NoCleanupAttempted=$true
   NoRestoreAttempted=$true
   OriginalHealthVerified=$true
   ProductionChanged=$false
  }|ConvertTo-Json
  throw 'ENGINEERING_CUTOVER_ABORTED_ORIGINAL_UNCHANGED'
 }
 $script:rollbackRestoredStack=$null
 $script:rollbackNewSupervisorPid=$newPid
 $script:rollbackOldStack=$oldStack
 $cleanup={
    $candidate=Get-Stack $new
    if($null -ne $candidate){
      Stop-ExactStack $candidate
    }elseif($script:rollbackNewSupervisorPid -and
      $null -ne (Get-Identity $script:rollbackNewSupervisorPid $new)){
      # A half-started new supervisor may have zero, one or several children.
      # Never guess which process is ours when parent/child relation ambiguous.
      $allChildren=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop |
        Where-Object {$_.ParentProcessId -eq $script:rollbackNewSupervisorPid -and
          $_.ExecutablePath -ieq $client})
      if($allChildren.Count -gt 1){throw 'PARTIAL_NEW_CHILD_AMBIGUOUS'}
      if($allChildren.Count -eq 1){
        $partialChild=$allChildren[0]
        $partialPid=[int]$partialChild.ProcessId
        $healthOwner=Get-Listener 18086
        if($null -ne $healthOwner -and $healthOwner -ne $partialPid){
          throw 'PARTIAL_NEW_HEALTH_PORT_OWNED_BY_OTHER_PROCESS'
        }
        Stop-Process -Id $partialPid -Force -ErrorAction Stop
      }
      $parentStill=Get-Identity $script:rollbackNewSupervisorPid $new
      if($null -ne $parentStill){
        Stop-Process -Id $script:rollbackNewSupervisorPid -Force -ErrorAction Stop
      }
    }
    $oldChild=Get-CimInstance Win32_Process -Filter "ProcessId=$($script:rollbackOldStack.TunnelPid)" -ErrorAction SilentlyContinue
    if($null -ne $oldChild -and $oldChild.Name -ieq 'tunnel-client.exe' -and
       $oldChild.ExecutablePath -ieq $client -and
       $oldChild.ParentProcessId -eq $script:rollbackOldStack.SupervisorPid){
      Stop-Process -Id $script:rollbackOldStack.TunnelPid -Force -ErrorAction Stop
    }
    for($i=0;$i -lt 30;$i++){
      if($null -eq (Get-Listener 17486) -and
         $null -eq (Get-Listener 18086)){return}
      Start-Sleep -Milliseconds 400
    }
    throw 'ROLLBACK_PORTS_STILL_OCCUPIED'
 }
 $restore={ $script:rollbackRestoredStack=Restore-Original }
 $verify={
    $stackNow=Get-Stack $old
    return ($null -ne $stackNow -and
      $null -ne $script:rollbackRestoredStack -and
      $stackNow.SupervisorPid -eq $script:rollbackRestoredStack.SupervisorPid -and
      $stackNow.TunnelPid -eq $script:rollbackRestoredStack.TunnelPid -and
      (Test-Health $stackNow.TunnelPid))
 }
 $outcome=Invoke-VerifiedCutoverRollback -FailureCode $reason -CleanupReplacement $cleanup -RestoreOriginal $restore -VerifyOriginal $verify
 [pscustomobject]@{
   Result=if($outcome.OriginalHealthVerified){
     'ENGINEERING_CUTOVER_FAILED_ROLLBACK_VERIFIED'
   }else{'ENGINEERING_CUTOVER_FAILED_ROLLBACK_UNCONFIRMED'}
   FailureReason=$reason
   Rollback=$outcome
   ManualLocalRecoveryRequired=(-not $outcome.OriginalHealthVerified)
   DoNotStopOtherTunnels=$true
 }|ConvertTo-Json -Depth 5
 throw 'ENGINEERING_CUTOVER_NOT_COMPLETED'
}
