# Read-only inventory of exact PowerShell Direct process/tunnel dependencies.
# No secrets, raw command lines, process changes or tunnel operations.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$expectedNode='C:\Engineering\ChromeBridge-PowerShell-Direct-Validation\tools\powershell-direct\stack-supervisor.mjs'
$expectedExecutable='C:\Program Files\nodejs\node.exe'
$expectedClient='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$ports=17486,18086
$listening=@(foreach($port in $ports){
 $l=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 [pscustomobject]@{Port=$port;Count=$l.Count;Pid=if($l.Count -eq 1){[int]$l[0].OwningProcess}else{$null}}
})
$svcPort=@($listening|Where-Object {$_.Port -eq 17486})[0]
$healthPort=@($listening|Where-Object {$_.Port -eq 18086})[0]
$processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='tunnel-client.exe'" -ErrorAction Stop)
$supervisor=@($processes|Where-Object {
 $_.ProcessId -eq $svcPort.Pid -and $_.Name -ieq 'node.exe' -and
 $_.ExecutablePath -ieq $expectedExecutable -and
 $_.CommandLine -and $_.CommandLine.Contains($expectedNode)
})
$childTunnels=@()
if($supervisor.Count -eq 1){
 $childTunnels=@($processes|Where-Object {
 $_.Name -ieq 'tunnel-client.exe' -and $_.ParentProcessId -eq $supervisor[0].ProcessId -and
 $_.ExecutablePath -ieq $expectedClient
 })
}
$healthOwned=$healthPort.Count -eq 1 -and $childTunnels.Count -eq 1 -and
 $healthPort.Pid -eq $childTunnels[0].ProcessId
$approvedWorkspaces=@(
 'C:\Engineering\ChromeBridge-Recovery-Install-20261114',
 'C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
)
$existingWorkspaces=@($approvedWorkspaces|Where-Object {
 Test-Path -LiteralPath $_ -PathType Container
})
$checks=[ordered]@{
 StageServiceExists=(Test-Path -LiteralPath (Join-Path $stage 'tools\powershell-direct\service.mjs') -PathType Leaf)
 StageSupervisorExists=(Test-Path -LiteralPath (Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs') -PathType Leaf)
 OriginalSupervisorExists=(Test-Path -LiteralPath $expectedNode -PathType Leaf)
 TunnelExecutableExists=(Test-Path -LiteralPath $expectedClient -PathType Leaf)
 RecoveryCredentialFileExists=(Test-Path -LiteralPath $credential -PathType Leaf)
 ExactlyOneOriginalSupervisor=($supervisor.Count -eq 1)
 ExactlyOneDirectTunnelChild=($childTunnels.Count -eq 1)
 TunnelHealthPortOwnedByDirectChild=[bool]$healthOwned
 EngineeringWorkspacesExist=($existingWorkspaces.Count -eq $approvedWorkspaces.Count)
}
$ok=@($checks.Values|Where-Object {$_ -ne $true}).Count -eq 0
[pscustomobject]@{
 Check='ENGINEERING_CUTOVER_DEPENDENCIES_READ_ONLY'
 SupervisorPid=if($supervisor.Count -eq 1){[int]$supervisor[0].ProcessId}else{$null}
 DirectTunnelPid=if($childTunnels.Count -eq 1){[int]$childTunnels[0].ProcessId}else{$null}
 HealthListenerPid=$healthPort.Pid
 RunningTunnelProcessCount=@($processes|Where-Object {$_.Name -ieq 'tunnel-client.exe'}).Count
 Checks=$checks
 ReadyForHumanReviewedCutover=[bool]$ok
 NoActionsPerformed=$true
 CredentialContentsRead=$false
 Note='Requires separate decision and transaction/rollback before changing any running process'
}|ConvertTo-Json -Depth 6
