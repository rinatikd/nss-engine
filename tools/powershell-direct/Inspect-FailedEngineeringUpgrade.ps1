# Read-only post-failed-cutover inventory. Never starts/stops processes.
# Prints no command lines, secret values, environment variables or tunnel output.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$expectedSupervisor=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$expectedNode='C:\Program Files\nodejs\node.exe'
$expectedClient='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$files=@(
 'tools\powershell-direct\service.mjs',
 'tools\powershell-direct\stack-supervisor.mjs',
 'tools\powershell-direct\approval-bootstrap.mjs',
 'tools\ai_collaboration\engineering-mcp.mjs',
 'tools\ai_collaboration\local_job_service.mjs'
)
$ports=@(17381,17382,17486,18086)
$listeners=@(foreach($port in $ports){
 $found=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 [pscustomobject]@{Port=$port;ListenerCount=$found.Count;OwnerPid=if($found.Count -eq 1){[int]$found[0].OwningProcess}else{$null}}
})
$processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='tunnel-client.exe'" -ErrorAction Stop)
$portInfos=@(foreach($entry in $listeners){
 $proc=@($processes|Where-Object {$_.ProcessId -eq $entry.OwnerPid})
 [pscustomobject]@{
  Port=$entry.Port
  ListenerCount=$entry.ListenerCount
  OwnerPid=$entry.OwnerPid
  ProcessName=if($proc.Count -eq 1){$proc[0].Name}else{$null}
  MatchesExpectedNode=($entry.Port -eq 17486 -and $proc.Count -eq 1 -and $proc[0].Name -ieq 'node.exe' -and $proc[0].ExecutablePath -ieq $expectedNode -and $proc[0].CommandLine -and $proc[0].CommandLine.Contains($expectedSupervisor))
  MatchesExpectedTunnel=($entry.Port -eq 18086 -and $proc.Count -eq 1 -and $proc[0].Name -ieq 'tunnel-client.exe' -and $proc[0].ExecutablePath -ieq $expectedClient)
 }
})
$fileChecks=@(foreach($relative in $files){
 $a=Join-Path $repo $relative
 $b=Join-Path $stage $relative
 $hasA=Test-Path -LiteralPath $a -PathType Leaf
 $hasB=Test-Path -LiteralPath $b -PathType Leaf
 [pscustomobject]@{
  RelativeFile=$relative
  RepoPresent=$hasA
  StagePresent=$hasB
  HashesEqual=($hasA -and $hasB -and
    ((Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash -ceq
     (Get-FileHash -LiteralPath $b -Algorithm SHA256).Hash))
 }
})
$svc=@($processes|Where-Object {
 $_.Name -ieq 'node.exe' -and $_.ExecutablePath -ieq $expectedNode -and
 $_.CommandLine -and $_.CommandLine.Contains($expectedSupervisor)
})
$children=@(foreach($p in $svc){
 $processes|Where-Object {
  $_.Name -ieq 'tunnel-client.exe' -and $_.ParentProcessId -eq $p.ProcessId -and
  $_.ExecutablePath -ieq $expectedClient
 }
})
[pscustomobject]@{
 Result='POST_FAILED_UPGRADE_READONLY'
 ExpectedSupervisorPresent=(Test-Path -LiteralPath $expectedSupervisor -PathType Leaf)
 TunnelBinaryPresent=(Test-Path -LiteralPath $expectedClient -PathType Leaf)
 SupervisorCount=$svc.Count
 SupervisorPids=@($svc|ForEach-Object {[int]$_.ProcessId})
 DirectTunnelChildPids=@($children|ForEach-Object {[int]$_.ProcessId})
 Ports=$portInfos
 Files=$fileChecks
 Production17381_17382UntouchedByThisCheck=$true
 ModifiedProcesses=$false
 ExposedCredentials=$false
 Note='Read-only inventory. Does not establish remote MCP or control-plane health.'
}|ConvertTo-Json -Depth 6
