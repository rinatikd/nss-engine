# Recover the existing staged PowerShell Direct stack only when it is fully down.
# Never modifies staged source, Chrome Bridge production 17381/17382, or credentials.
# Mode Inspect is read-only. Mode Start requires an explicit local switch.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Start')][string]$Mode='Inspect',
 [switch]$AuthorizeLocalRecovery
)
$ErrorActionPreference='Stop'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$script=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$audit='C:\Engineering\PowerShellDirect-Engineering-Audit-R1'
$roots=$repo+';'+$stage

function Owner([int]$port){
 $found=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($found.Count -gt 1){throw ('AMBIGUOUS_LISTENER_'+$port)}
 if($found.Count -eq 0){return $null}
 return [int]$found[0].OwningProcess
}
function Status([string]$status,[int]$pidValue=0,[int]$tunnel=0){
 [pscustomobject]@{
  Result=$status;SupervisorPid=if($pidValue -gt 0){$pidValue}else{$null}
  TunnelPid=if($tunnel -gt 0){$tunnel}else{$null}
  Listener17486=Owner 17486;Listener18086=Owner 18086
  ProductionPortsChangedByThisScript=$false;SourceFilesChanged=$false
  SecretValueEmitted=$false
 }|ConvertTo-Json
}
foreach($file in @($node,$client,$script,$credential)){
 if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw 'RECOVERY_PREREQUISITE_MISSING'}
}
if(!(Test-Path -LiteralPath $repo -PathType Container) -or
   !(Test-Path -LiteralPath $stage -PathType Container)){
 throw 'RECOVERY_WORKSPACE_MISSING'
}
$listener1=Owner 17486
$listener2=Owner 18086
if($null -ne $listener1 -or $null -ne $listener2){
 Status 'RECOVERY_REFUSED_PORT_OCCUPIED'
 return
}
# Do not create duplicate processes when a previous listener has not yet bound.
$existing=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
 Where-Object {
  $_.ExecutablePath -ieq $node -and $_.CommandLine -and
  $_.CommandLine.Contains($script)
 })
if($existing.Count -gt 0){
 Status 'RECOVERY_REFUSED_SUPERVISOR_ALREADY_EXISTS'
 return
}
if($Mode -eq 'Inspect'){
 Status 'RECOVERY_START_PRECHECK_PASS'
 return
}
if(!$AuthorizeLocalRecovery){throw 'EXPLICIT_LOCAL_RECOVERY_AUTH_REQUIRED'}

# Only Start may decrypt the existing CurrentUser DPAPI recovery key.
$secure=$null;$ptr=[IntPtr]::Zero;$plain=$null;$psi=$null;$child=$null
try{
 $secure=ConvertTo-SecureString -String ((Get-Content -LiteralPath $credential -Raw -Encoding UTF8).Trim()) -ErrorAction Stop
 $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
 $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
 if([string]::IsNullOrWhiteSpace($plain)){throw 'RECOVERY_CREDENTIAL_EMPTY'}
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
 $child=[Diagnostics.Process]::Start($psi)
 if(!$child){throw 'RECOVERY_NODE_START_FAILED'}
}finally{
 if($psi){$psi.EnvironmentVariables.Remove('CONTROL_PLANE_API_KEY')|Out-Null}
 $plain=$null
 if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
 if($secure){$secure.Dispose()}
}
$pidValue=[int]$child.Id
try{
 $state='NODE_START_IN_PROGRESS';$tunnelPid=0
 for($i=0;$i -lt 40;$i++){
  $child.Refresh()
  if($child.HasExited){$state='SUPERVISOR_EXITED';break}
  $svcOwner=Owner 17486
  if($null -ne $svcOwner -and $svcOwner -ne $pidValue){
   $state='UNEXPECTED_SERVICE_LISTENER_OWNER';break
  }
  $tunnelOwner=Owner 18086
  if($null -ne $tunnelOwner){
   $tunnel=@(Get-CimInstance Win32_Process -Filter ("ProcessId="+$tunnelOwner) -ErrorAction SilentlyContinue)
   if($tunnel.Count -ne 1 -or
      $tunnel[0].Name -ine 'tunnel-client.exe' -or
      $tunnel[0].ExecutablePath -ine $client -or
      $tunnel[0].ParentProcessId -ne $pidValue){
     $state='UNEXPECTED_TUNNEL_LISTENER_OWNER';break
   }
   $tunnelPid=[int]$tunnelOwner
  }
  if($svcOwner -eq $pidValue -and $tunnelPid -gt 0){
   $state='LOCAL_LISTENERS_CONFIRMED';break
  }
  Start-Sleep -Milliseconds 250
 }
 if($state -eq 'NODE_START_IN_PROGRESS'){$state='LOCAL_STARTUP_TIMED_OUT'}
 Status $state $pidValue $tunnelPid
}finally{
 if($child){$child.Dispose()}
}
