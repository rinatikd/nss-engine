# Operator-only guarded in-place Engineering MCP UI bootstrap upgrade.
# Inspect and Rehearse NEVER interrupt production.
# Upgrade requires explicit local authorization and independently verified exact PIDs.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Rehearse','Upgrade')][string]$Mode='Inspect',
 [switch]$AuthorizeServiceRestart
)
$ErrorActionPreference='Stop'
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$script=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$audit='C:\Engineering\PowerShellDirect-Engineering-Audit-R1'
$roots=$repo+';'+$stage
$relative=@(
 'tools\powershell-direct\stack-supervisor.mjs',
 'tools\powershell-direct\approval-bootstrap.mjs',
 'tools\powershell-direct\Save-ApprovalToken.ps1',
 'tools\powershell-direct\Open-Approval.ps1'
)
function Get-Listener([int]$port){
 $s=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($s.Count -gt 1){throw ('AMBIGUOUS_LISTENER_'+$port)}
 if($s.Count -eq 0){return $null}
 return [int]$s[0].OwningProcess
}
function Get-Stack {
 $id=Get-Listener 17486
 if($null -eq $id){return $null}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
 if(!$p -or $p.Name -ine 'node.exe' -or $p.ExecutablePath -ine $node -or
    !$p.CommandLine -or !$p.CommandLine.Contains($script)){return $null}
 $children=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop |
  Where-Object {$_.ParentProcessId -eq $id -and $_.ExecutablePath -ieq $client})
 if($children.Count -ne 1){return $null}
 $childId=[int]$children[0].ProcessId
 if((Get-Listener 18086) -ne $childId){return $null}
 return [pscustomobject]@{SupervisorPid=$id;TunnelPid=$childId}
}
function Test-Health([int]$pidValue){
 $json=(& $client health --port 18086 --pid $pidValue --require-control-plane-poll --json 2>&1 | Out-String)
 if($LASTEXITCODE -ne 0){return $false}
 try{
  $obj=ConvertFrom-Json $json
  return ($obj.result -eq 'ok' -and $obj.healthz.ok -eq $true -and
          $obj.readyz.ok -eq $true -and $obj.control_plane_poll.ok -eq $true)
 }catch{return $false}
}
function Verify-Requirements {
 foreach($file in @($node,$client,$credential,$script)){
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw 'PREREQUISITE_MISSING'}
 }
 foreach($item in $relative){
  if(!(Test-Path -LiteralPath (Join-Path $repo $item) -PathType Leaf)){
   throw ('SOURCE_FILE_MISSING_'+$item)
  }
 }
 $live=Get-Stack
 if($null -eq $live){throw 'ACTIVE_ENGINEERING_STACK_NOT_VERIFIED'}
 if(!(Test-Health $live.TunnelPid)){throw 'CURRENT_TUNNEL_NOT_HEALTHY'}
 return $live
}
function Start-Stack {
 if($null -ne (Get-Listener 17486) -or $null -ne (Get-Listener 18086)){
  throw 'START_PORTS_OCCUPIED'
 }
 $sec=ConvertTo-SecureString -String ((Get-Content -LiteralPath $credential -Raw -Encoding UTF8).Trim()) -ErrorAction Stop
 $ptr=[IntPtr]::Zero;$plain=$null;$psi=$null
 try{
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if([string]::IsNullOrWhiteSpace($plain)){throw 'CREDENTIAL_EMPTY'}
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName=$node
  $psi.Arguments='"'+$script+'"'
  $psi.WorkingDirectory=Split-Path $script -Parent
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.EnvironmentVariables['PS_DIRECT_ALLOWED_ROOT']='C:\Engineering'
  $psi.EnvironmentVariables['PS_DIRECT_TUNNEL_CLIENT']=$client
  $psi.EnvironmentVariables['CONTROL_PLANE_API_KEY']=$plain
  $psi.EnvironmentVariables['PS_DIRECT_ENGINEERING_WORKSPACES']=$roots
  $psi.EnvironmentVariables['PS_DIRECT_ENGINEERING_AUDIT_DIR']=$audit
  $p=[Diagnostics.Process]::Start($psi)
  if(!$p){throw 'NEW_STACK_LAUNCH_FAILED'}
  return [int]$p.Id
 }finally{
  if($psi){$psi.EnvironmentVariables.Remove('CONTROL_PLANE_API_KEY')|Out-Null}
  $plain=$null
  if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  if($sec){$sec.Dispose()}
 }
}
function Wait-Stack([int]$expected){
 for($i=0;$i -lt 65;$i++){
  $current=Get-Stack
  if($null -ne $current -and $current.SupervisorPid -eq $expected -and
     (Test-Health $current.TunnelPid)){return $current}
  Start-Sleep -Milliseconds 500
 }
 throw 'NEW_STACK_HEALTH_NOT_CONFIRMED'
}
function Stop-Verified($pair){
 $current=Get-Stack
 if($null -eq $current -or $current.SupervisorPid -ne $pair.SupervisorPid -or
    $current.TunnelPid -ne $pair.TunnelPid){throw 'STACK_IDENTITY_CHANGED'}
 Stop-Process -Id $pair.SupervisorPid -Force -ErrorAction Stop
 Start-Sleep -Milliseconds 450
 $child=Get-CimInstance Win32_Process -Filter "ProcessId=$($pair.TunnelPid)" -ErrorAction SilentlyContinue
 if($child -and $child.Name -ieq 'tunnel-client.exe' -and
    $child.ExecutablePath -ieq $client -and $child.ParentProcessId -eq $pair.SupervisorPid){
  Stop-Process -Id $pair.TunnelPid -Force -ErrorAction Stop
 }
 for($i=0;$i -lt 40;$i++){
  if($null -eq (Get-Listener 17486) -and $null -eq (Get-Listener 18086)){return}
  Start-Sleep -Milliseconds 350
 }
 throw 'STACK_PORTS_NOT_RELEASED'
}
function Stop-PartialNew([int]$id){
 if($id -le 0){return}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
 if(!$p -or $p.Name -ine 'node.exe' -or $p.ExecutablePath -ine $node -or
    !$p.CommandLine -or !$p.CommandLine.Contains($script)){return}
 $children=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop |
   Where-Object {$_.ParentProcessId -eq $id -and $_.ExecutablePath -ieq $client})
 if($children.Count -gt 1){throw 'PARTIAL_CHILD_AMBIGUOUS'}
 if($children.Count -eq 1){
  $childId=[int]$children[0].ProcessId
  $owner=Get-Listener 18086
  if($null -ne $owner -and $owner -ne $childId){throw 'PARTIAL_CHILD_PORT_OWNED_BY_OTHER'}
  Stop-Process -Id $childId -Force -ErrorAction Stop
 }
 Stop-Process -Id $id -Force -ErrorAction Stop
 for($i=0;$i -lt 30;$i++){
  if($null -eq (Get-Listener 17486) -and $null -eq (Get-Listener 18086)){return}
  Start-Sleep -Milliseconds 350
 }
 throw 'PARTIAL_REPLACEMENT_PORTS_OCCUPIED'
}
function Copy-UpgradeFiles {
 foreach($item in $relative){
  $source=Join-Path $repo $item
  $target=Join-Path $stage $item
  $targetDirectory=Split-Path $target -Parent
  if(!(Test-Path -LiteralPath $targetDirectory -PathType Container)){throw 'STAGE_DIR_MISSING'}
  Copy-Item -LiteralPath $source -Destination $target -Force -ErrorAction Stop
  if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
     (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash){
   throw ('STAGE_FILE_HASH_MISMATCH_'+$item)
  }
 }
}
$ready=Verify-Requirements
if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Result='APPROVAL_UPGRADE_INSPECT_PASS'
  CurrentSupervisorPid=$ready.SupervisorPid
  CurrentTunnelPid=$ready.TunnelPid
  CurrentTunnelHealthy=$true
  UpgradeExecuted=$false
 }|ConvertTo-Json
 return
}
$test=Join-Path $repo 'tools\powershell-direct\tests\Test-ApprovalBootstrap.ps1'
if(!(Test-Path -LiteralPath $test -PathType Leaf)){throw 'APPROVAL_BOOTSTRAP_TEST_MISSING'}
& powershell.exe -NoProfile -File $test
if($LASTEXITCODE -ne 0){throw 'APPROVAL_BOOTSTRAP_TEST_FAILED'}
foreach($file in @('tools\powershell-direct\approval-bootstrap.mjs',
                    'tools\powershell-direct\stack-supervisor.mjs')){
 & $node --check (Join-Path $repo $file)
 if($LASTEXITCODE -ne 0){throw ('NODE_SYNTAX_FAILED_'+$file)}
}
# Every executable mode must independently pass 27 engineering tests.
$cases=@(
 'tools/powershell-direct/tests/engineering.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/local_mcp_dispatch.test.mjs'
)
Push-Location $repo
try{
 & $node --test @cases
 if($LASTEXITCODE -ne 0){throw 'ENGINEERING_NODE_TESTS_FAILED'}
}finally{Pop-Location}
if($Mode -eq 'Rehearse'){
 $unchanged=Get-Stack
 if(!$unchanged -or $unchanged.SupervisorPid -ne $ready.SupervisorPid -or
    $unchanged.TunnelPid -ne $ready.TunnelPid){throw 'PRODUCTION_CHANGED_DURING_REHEARSAL'}
 [pscustomobject]@{Result='APPROVAL_UPGRADE_REHEARSAL_PASS';ProductionChanged=$false;NodeSuitePassed=$true;DpapiBootstrapPassed=$true}|ConvertTo-Json
 return
}
if(!$AuthorizeServiceRestart){throw 'EXPLICIT_RESTART_FLAG_REQUIRED'}
$phrase=Read-Host 'Type EXACTLY UPGRADE ENGINEERING APPROVAL 17486'
if($phrase -cne 'UPGRADE ENGINEERING APPROVAL 17486'){throw 'OPERATOR_DECLINED'}
$backup=Join-Path $env:TEMP ('psdirect-approval-upgrade-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$newPid=0;$transactionStarted=$false
try{
 foreach($item in $relative){
  $original=Join-Path $stage $item
  $copy=Join-Path $backup $item
  $copyDir=Split-Path $copy -Parent
  New-Item -ItemType Directory -Path $copyDir -Force | Out-Null
  if(Test-Path -LiteralPath $original -PathType Leaf){Copy-Item -LiteralPath $original -Destination $copy -Force}
 }
 $transactionStarted=$true
 Stop-Verified $ready
 Copy-UpgradeFiles
 $newPid=Start-Stack
 $newStack=Wait-Stack $newPid
 $launcher=Join-Path $stage 'tools\powershell-direct\Open-Approval.ps1'
 & powershell.exe -NoProfile -File $launcher -CheckOnly
 if($LASTEXITCODE -ne 0){throw 'APPROVAL_PAGE_NOT_ACCESSIBLE'}
 [pscustomobject]@{
  Result='ENGINEERING_APPROVAL_UPGRADE_PASS'
  SupervisorPid=$newStack.SupervisorPid
  TunnelPid=$newStack.TunnelPid
  ApprovalLauncher=$launcher
  ProductionChanged=$true
  RemoteEngineeringJobStillNeedsOperatorApproval=$true
 }|ConvertTo-Json
}catch{
 $reason=$_.Exception.Message
 if(!$transactionStarted){throw}
 # Stop-Verified may have failed BEFORE any shutdown. Never disturb an
 # exactly identical healthy original stack, and never redeploy over it.
 $stillOriginal=Get-Stack
 if($stillOriginal -and $stillOriginal.SupervisorPid -eq $ready.SupervisorPid -and
    $stillOriginal.TunnelPid -eq $ready.TunnelPid -and (Test-Health $ready.TunnelPid)){
  throw 'UPGRADE_ABORTED_ORIGINAL_UNCHANGED'
 }
 try{
  if($newPid -gt 0){Stop-PartialNew $newPid}
  # An original child could survive a partially failed Stop-Verified.
  # Stop only the PID / executable / parent that were captured pre-upgrade.
  $oldChild=Get-CimInstance Win32_Process -Filter "ProcessId=$($ready.TunnelPid)" -ErrorAction SilentlyContinue
  if($oldChild -and $oldChild.Name -ieq 'tunnel-client.exe' -and
     $oldChild.ExecutablePath -ieq $client -and
     $oldChild.ParentProcessId -eq $ready.SupervisorPid){
   $healthOwner=Get-Listener 18086
   if($null -ne $healthOwner -and $healthOwner -ne $ready.TunnelPid){
    throw 'OLD_TUNNEL_PORT_OWNED_BY_OTHER_PROCESS'
   }
   Stop-Process -Id $ready.TunnelPid -Force -ErrorAction Stop
  }
  if($null -ne (Get-Listener 17486) -or $null -ne (Get-Listener 18086)){
   throw 'ROLLBACK_PORTS_OCCUPIED'
  }
  foreach($item in $relative){
   $dest=Join-Path $stage $item
   $src=Join-Path $backup $item
   if(Test-Path -LiteralPath $src -PathType Leaf){
    Copy-Item -LiteralPath $src -Destination $dest -Force
   }elseif(Test-Path -LiteralPath $dest -PathType Leaf){
    Remove-Item -LiteralPath $dest -Force
   }
  }
  $restoredPid=Start-Stack
  $restored=Wait-Stack $restoredPid
  [pscustomobject]@{
   Result='ENGINEERING_APPROVAL_UPGRADE_FAILED_ROLLBACK_VERIFIED'
   FailureReason=$reason
   RestoredSupervisorPid=$restored.SupervisorPid
   RestoredTunnelPid=$restored.TunnelPid
  }|ConvertTo-Json
 }catch{
  [pscustomobject]@{
   Result='ENGINEERING_APPROVAL_UPGRADE_FAILED_ROLLBACK_UNCONFIRMED'
   FailureReason=$reason
   RollbackFailure=$_.Exception.Message
   ManualLocalRecoveryRequired=$true
  }|ConvertTo-Json
 }
 throw 'ENGINEERING_APPROVAL_UPGRADE_NOT_COMPLETED'
}finally{
 # Keep backups for manual recovery whenever upgrade was interrupted.
 if(!$transactionStarted){Remove-Item -LiteralPath $backup -Force -Recurse -ErrorAction SilentlyContinue}
}
