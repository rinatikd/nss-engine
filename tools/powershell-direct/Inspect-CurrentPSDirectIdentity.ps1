# Read-only identity inspection for current PowerShell Direct listeners.
# Never prints full command lines, environment variables, tokens or credentials.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
function Listener([int]$port){
 $x=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($x.Count -eq 1){return [int]$x[0].OwningProcess}
 return $null
}
$super=Listener 17486
$tunnel=Listener 18086
$superProc=if($super){Get-CimInstance Win32_Process -Filter "ProcessId=$super" -ErrorAction SilentlyContinue}else{$null}
$tunnelProc=if($tunnel){Get-CimInstance Win32_Process -Filter "ProcessId=$tunnel" -ErrorAction SilentlyContinue}else{$null}
$scriptPath=''
$known=@(
 'C:\Engineering\ChromeBridge-PowerShell-Direct-Validation\tools\powershell-direct\stack-supervisor.mjs',
 'C:\Engineering\PowerShellDirect-Engineering-Lab-R1\tools\powershell-direct\stack-supervisor.mjs',
 'C:\Engineering\PowerShellDirect-Engineering-Lab-R2\tools\powershell-direct\stack-supervisor.mjs',
 'C:\Engineering\ChromeBridge-Recovery-Install-20261114\tools\powershell-direct\stack-supervisor.mjs'
)
$matches=[System.Collections.Generic.List[string]]::new()
if($superProc -and $superProc.CommandLine){
 foreach($path in $known){if($superProc.CommandLine.Contains($path)){$matches.Add($path)}}
 $m=[regex]::Match($superProc.CommandLine,'(?i)([A-Z]:\\[^"]*stack-supervisor\.mjs)')
 if($m.Success){$scriptPath=$m.Groups[1].Value}
}
$childTunnel=$false
if($superProc -and $tunnelProc){
 $childTunnel=$tunnelProc.Name -ieq 'tunnel-client.exe' -and
  $tunnelProc.ExecutablePath -ieq $client -and
  $tunnelProc.ParentProcessId -eq $super
}
$health=$false;$healthCategory='NOT_RUN'
if($childTunnel){
 $psi=New-Object System.Diagnostics.ProcessStartInfo
 $psi.FileName=$client
 $psi.Arguments='health --port 18086 --pid '+$tunnel+' --require-control-plane-poll --json'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=New-Object System.Diagnostics.Process;$p.StartInfo=$psi
 try{
  if($p.Start()){
   $o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync()
   if($p.WaitForExit(10000)){
    $raw=$o.GetAwaiter().GetResult();$null=$e.GetAwaiter().GetResult()
    if($p.ExitCode -eq 0 -and $raw.Length -le 32768){
     try{$j=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
      $health=($j.result -eq 'ok' -and $j.healthz.ok -eq $true -and
       $j.readyz.ok -eq $true -and $j.control_plane_poll.ok -eq $true)
      $healthCategory=if($health){'HEALTH_READY_AND_CONTROL_PLANE_POLL_OK'}else{'HEALTH_OR_CONTROL_PLANE_NOT_READY'}
     }catch{$healthCategory='HEALTH_JSON_INVALID'}
    }else{$healthCategory='HEALTH_COMMAND_FAILED'}
   }else{try{$p.Kill()}catch{};$healthCategory='HEALTH_TIMEOUT'}
  }else{$healthCategory='HEALTH_START_FAILED'}
 }catch{$healthCategory='HEALTH_PROBE_ERROR'}
 finally{$p.Dispose()}
}
[pscustomobject]@{
 Check='CURRENT_PSDIRECT_PROCESS_IDENTITY_READ_ONLY'
 SupervisorPid=$super
 SupervisorName=if($superProc){$superProc.Name}else{$null}
 SupervisorExeMatch=($null -ne $superProc -and $superProc.ExecutablePath -ieq $node)
 SupervisorParentPid=if($superProc){$superProc.ParentProcessId}else{$null}
 SupervisorScriptPath=$scriptPath
 KnownSupervisorPathMatches=@($matches)
 TunnelPid=$tunnel
 TunnelName=if($tunnelProc){$tunnelProc.Name}else{$null}
 TunnelExecutableMatch=($null -ne $tunnelProc -and $tunnelProc.ExecutablePath -ieq $client)
 TunnelParentMatchesSupervisor=$childTunnel
 RemoteControlPlaneHealth=$health
 RemoteHealthCategory=$healthCategory
 RawCommandLinesEmitted=$false
 EnvironmentEmitted=$false
 CredentialsEmitted=$false
 ProcessesChanged=$false
}|ConvertTo-Json -Depth 4
