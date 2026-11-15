# Read-only engineering ACK cutover inspection. Never restarts processes or copies modules.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$supervisor=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$relative='tools\powershell-direct\service.mjs'
$source=Join-Path $repo $relative
$installed=Join-Path $stage $relative
foreach($f in @($source,$installed,$supervisor,$node,$client)){
 if(!(Test-Path -LiteralPath $f -PathType Leaf)){throw 'ACK_CUTOVER_PREREQUISITE_MISSING'}
}
function Listener([int]$port){
 $l=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($l.Count -ne 1){throw ('ACK_CUTOVER_LISTENER_COUNT_INVALID_'+$port)}
 return [int]$l[0].OwningProcess
}
$parentPid=Listener 17486
$tunnelPid=Listener 18086
$parent=Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid"
$tunnel=Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelPid"
if(!$parent -or $parent.Name -ine 'node.exe' -or $parent.ExecutablePath -ine $node -or
   !$parent.CommandLine -or !$parent.CommandLine.Contains($supervisor)){
 throw 'ACK_CUTOVER_SUPERVISOR_IDENTITY_UNVERIFIED'
}
if(!$tunnel -or $tunnel.Name -ine 'tunnel-client.exe' -or
   $tunnel.ExecutablePath -ine $client -or
   $tunnel.ParentProcessId -ne $parentPid){
 throw 'ACK_CUTOVER_TUNNEL_IDENTITY_UNVERIFIED'
}
$srcHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$stageHash=(Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
& $node --check $source | Out-Null
if($LASTEXITCODE -ne 0){throw 'ACK_CUTOVER_SOURCE_SYNTAX_FAILED'}
[pscustomobject]@{
 Result='ACK_CUTOVER_INSPECT_PASS'
 SupervisorPid=$parentPid
 TunnelPid=$tunnelPid
 SourceSha256=$srcHash
 InstalledSha256=$stageHash
 UpdateNeeded=($srcHash -ne $stageHash)
 ProductionChromeBridgeTouched=$false
 ProcessesRestarted=$false
 LiveFilesModified=$false
 RemoteMcpRoundTripVerifiedByThisScript=$false
}|ConvertTo-Json
