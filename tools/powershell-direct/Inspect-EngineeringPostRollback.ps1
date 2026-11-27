# Read-only post-rollback inspection of actual local PowerShell Direct stack.
# No credentials, URLs, health raw output, process command lines, or secrets printed.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$supervisor=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$module=Join-Path $stage 'tools\powershell-direct\service.mjs'
$source=Join-Path $repo 'tools\powershell-direct\service.mjs'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
function Listener([int]$port){
 $items=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($items.Count -gt 1){throw ('POSTROLLBACK_AMBIGUOUS_LISTENER_'+$port)}
 if($items.Count -eq 0){return 0}
 return [int]$items[0].OwningProcess
}
function TestHealth([int]$pidValue){
 $psi=New-Object Diagnostics.ProcessStartInfo
 $psi.FileName=$client
 $psi.Arguments='health --port 18086 --pid '+$pidValue+' --require-control-plane-poll --json'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=$null
 try{
  $p=[Diagnostics.Process]::Start($psi)
  if(!$p){return [pscustomobject]@{Category='PROCESS_START_FAILED'}}
  # Read in parallel with process exit to avoid stdout/stderr pipe deadlock.
  $stdoutTask=$p.StandardOutput.ReadToEndAsync()
  $stderrTask=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(8000)){
   try{$p.Kill()}catch{}
   return [pscustomobject]@{Category='HEALTH_TIMEOUT'}
  }
  [void]$stdoutTask.Wait(2000)
  [void]$stderrTask.Wait(2000)
  $raw=$stdoutTask.Result
  if($p.ExitCode -ne 0){return [pscustomobject]@{Category='HEALTH_NONZERO_EXIT';ExitCode=$p.ExitCode}}
  if($raw.Length -gt 16384){return [pscustomobject]@{Category='HEALTH_OUTPUT_OVERSIZE'}}
  $obj=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  $h=($obj.healthz.ok -eq $true)
  $r=($obj.readyz.ok -eq $true)
  $c=($obj.control_plane_poll.ok -eq $true)
  $root=($obj.result -eq 'ok')
  return [pscustomobject]@{
   Category=if($h -and $r -and $c -and $root){'HEALTH_PASS'}else{'HEALTH_FIELDS_NOT_READY'}
   ResultOk=$root;HealthzOk=$h;ReadyzOk=$r;ControlPlanePollOk=$c
  }
 }catch{
  return [pscustomobject]@{Category='HEALTH_INVOKE_OR_PARSE_ERROR'}
 }finally{if($p){$p.Dispose()}}
}
foreach($f in @($source,$module,$supervisor,$node,$client)){
 if(!(Test-Path -LiteralPath $f -PathType Leaf)){throw 'POSTROLLBACK_PREREQUISITE_MISSING'}
}
$sid=Listener 17486;$tid=Listener 18086
if($sid -eq 0 -or $tid -eq 0){throw 'POSTROLLBACK_LOCAL_LISTENERS_MISSING'}
$s=Get-CimInstance Win32_Process -Filter ("ProcessId="+$sid) -ErrorAction Stop
$t=Get-CimInstance Win32_Process -Filter ("ProcessId="+$tid) -ErrorAction Stop
if(!$s -or $s.Name -ine 'node.exe' -or $s.ExecutablePath -ine $node -or
   !$s.CommandLine -or !$s.CommandLine.Contains($supervisor)){
 throw 'POSTROLLBACK_SUPERVISOR_UNVERIFIED'
}
if(!$t -or $t.Name -ine 'tunnel-client.exe' -or $t.ExecutablePath -ine $client -or
   $t.ParentProcessId -ne $sid){throw 'POSTROLLBACK_TUNNEL_UNVERIFIED'}
$health=TestHealth $tid
[pscustomobject]@{
 Result='POSTROLLBACK_READONLY_INSPECT_COMPLETE'
 SupervisorPid=$sid
 TunnelPid=$tid
 StagedSha256=(Get-FileHash -LiteralPath $module -Algorithm SHA256).Hash
 SourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
 Health=$health
 RestartPerformed=$false
 FilesModified=$false
 CredentialsReadByScript=$false
 ChromeBridgeTouched=$false
 RemoteMcpRoundTripProvenByScript=$false
}|ConvertTo-Json -Depth 5
