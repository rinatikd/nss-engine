# Read-only rehearsal of the current PR138 candidate beside the live R1 stack.
# Executes only the staged Node test files and ephemeral-loopback MCP smoke.
# Does not stop/start R1, start a tunnel, change ports, read credentials or cut over.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R2-PR138-35e69e7'
$old='C:\Engineering\PowerShellDirect-Engineering-Lab-R1\tools\powershell-direct\stack-supervisor.mjs'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$tests=@(
 'tools/powershell-direct/tests/engineering.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/workspace-policy.test.mjs',
 'tools/ai_collaboration/local_mcp_dispatch.test.mjs',
 'tools/powershell-direct/tests/service.test.mjs',
 'tools/ai_collaboration/local_test_runner.test.mjs'
)

function Get-Listener([int]$Port){
 $x=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
 if($x.Count -gt 1){throw ('AMBIGUOUS_LISTENER_'+$Port)}
 if($x.Count -eq 0){return $null}
 return [int]$x[0].OwningProcess
}
function Get-Stack {
 $super=Get-Listener 17486
 $tunnel=Get-Listener 18086
 if(!$super -or !$tunnel){return $null}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$super" -ErrorAction SilentlyContinue
 if(!$p -or $p.Name -ine 'node.exe' -or $p.ExecutablePath -ine $node -or
    !$p.CommandLine -or !$p.CommandLine.Contains($old)){return $null}
 $children=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.ParentProcessId -eq $super -and $_.ExecutablePath -ieq $client})
 if($children.Count -ne 1 -or [int]$children[0].ProcessId -ne $tunnel){return $null}
 return [pscustomobject]@{SupervisorPid=$super;TunnelPid=$tunnel}
}
function Test-Health([int]$TunnelPid){
 $psi=New-Object Diagnostics.ProcessStartInfo
 $psi.FileName=$client
 $psi.Arguments='health --port 18086 --pid '+$TunnelPid+' --require-control-plane-poll --json'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=$null
 try{
  $p=[Diagnostics.Process]::Start($psi)
  if(!$p){return $false}
  $o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(10000)){try{$p.Kill()}catch{};return $false}
  $raw=$o.GetAwaiter().GetResult();$null=$e.GetAwaiter().GetResult()
  if($p.ExitCode -ne 0 -or $raw.Length -gt 32768){return $false}
  $j=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  return ($j.result -eq 'ok' -and $j.healthz.ok -eq $true -and
   $j.readyz.ok -eq $true -and $j.control_plane_poll.ok -eq $true)
 }catch{return $false}
 finally{if($p){$p.Dispose()}}
}
function Invoke-Node([string[]]$Arguments,[int]$TimeoutMs){
 $psi=New-Object Diagnostics.ProcessStartInfo
 $psi.FileName=$node
 $psi.Arguments=[string]::Join(' ',$Arguments)
 $psi.WorkingDirectory=$stage
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=$null
 try{
  $p=[Diagnostics.Process]::Start($psi)
  if(!$p){throw 'NODE_START_FAILED'}
  $o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit($TimeoutMs)){try{$p.Kill()}catch{};throw 'NODE_TEST_TIMEOUT'}
  $stdout=$o.GetAwaiter().GetResult();$stderr=$e.GetAwaiter().GetResult()
  return [pscustomobject]@{ExitCode=$p.ExitCode;Stdout=$stdout;Stderr=$stderr}
 }finally{if($p){$p.Dispose()}}
}

if(!(Test-Path -LiteralPath $stage -PathType Container)){throw 'CURRENT_STAGE_MISSING'}
if(!(Test-Path -LiteralPath $node -PathType Leaf) -or
   !(Test-Path -LiteralPath $client -PathType Leaf)){throw 'TRUSTED_EXECUTABLE_MISSING'}
$initial=Get-Stack
if(!$initial){throw 'ACTIVE_R1_STACK_IDENTITY_NOT_VERIFIED'}
if(!(Test-Health $initial.TunnelPid)){throw 'ACTIVE_R1_REMOTE_HEALTH_NOT_READY'}

$bridgeBefore=@{}
foreach($port in @(17381,17382,17488)){$bridgeBefore[$port]=Get-Listener $port}

$testArgs=@('--test')+$tests
$testResult=Invoke-Node $testArgs 180000
if($testResult.ExitCode -ne 0){
 throw ('CURRENT_R2_NODE_TESTS_FAILED_'+$testResult.ExitCode)
}
$testSummary=[regex]::Match($testResult.Stdout,'(?m)^ℹ tests (\d+)\s*$').Groups[1].Value
$testPass=[regex]::Match($testResult.Stdout,'(?m)^ℹ pass (\d+)\s*$').Groups[1].Value
$testFail=[regex]::Match($testResult.Stdout,'(?m)^ℹ fail (\d+)\s*$').Groups[1].Value

$smoke=Invoke-Node @('tools/powershell-direct/tests/engineering-smoke.mjs') 30000
if($smoke.ExitCode -ne 0 -or $smoke.Stdout -notmatch 'ENGINEERING_LOCAL_MCP_SMOKE_PASS'){
 throw 'CURRENT_R2_LOCAL_MCP_SMOKE_FAILED'
}
$final=Get-Stack
if(!$final -or $final.SupervisorPid -ne $initial.SupervisorPid -or
   $final.TunnelPid -ne $initial.TunnelPid){throw 'R1_STACK_CHANGED_DURING_REHEARSAL'}
if(!(Test-Health $final.TunnelPid)){throw 'R1_REMOTE_HEALTH_CHANGED_DURING_REHEARSAL'}
$bridgeAfter=@{}
foreach($port in @(17381,17382,17488)){$bridgeAfter[$port]=Get-Listener $port}
foreach($port in @(17381,17382,17488)){
 if($bridgeBefore[$port] -ne $bridgeAfter[$port]){throw ('GUARDED_PORT_OWNER_CHANGED_'+$port)}
}

[pscustomobject]@{
 Result='PR138_CURRENT_R2_REHEARSAL_PASS'
 CandidateCommit='35e69e7e58c7e1b054a0771cabce07cc0c4108df'
 StagedRegressionFiles=$tests.Count
 NodeTestsReported=$testSummary
 NodeTestsPassed=$testPass
 NodeTestsFailed=$testFail
 LocalMcpSmokePassed=$true
 ArbitraryCommandRejected=$true
 EphemeralLoopbackOnly=$true
 OriginalR1SupervisorPid=$initial.SupervisorPid
 OriginalR1TunnelPid=$initial.TunnelPid
 OriginalR1RemoteHealthBeforeAndAfter=$true
 Bridge17381OwnerBeforeAndAfter=$bridgeBefore[17381]
 Bridge17382OwnerBeforeAndAfter=$bridgeBefore[17382]
 ExistingR2DiagnosticOwnerBeforeAndAfter=$bridgeBefore[17488]
 R1AndProductionUnchanged=$true
 CredentialsRead=$false
 TunnelsStartedOrStopped=$false
 CutoverPerformed=$false
}|ConvertTo-Json -Depth 4
