# Read-only inventory before proposed PowerShell Direct 17486 cutover.
# Does not restart processes, touch environment, read credential values,
# write files, or run a tunnel. Emits no command lines or secrets.
[CmdletBinding()]
param(
 [string]$PlatformCheckout='C:\Engineering\ChromeBridge-Recovery-Install-20261114',
 [string]$StagedRoot='C:\Engineering\PowerShellDirect-Engineering-Lab-R1',
 [int]$Port=17486
)
$ErrorActionPreference='Stop'
if($Port -ne 17486){throw 'UNEXPECTED_POWERSHELL_DIRECT_PORT'}
$source=Join-Path $PlatformCheckout 'tools\powershell-direct\stack-supervisor.mjs'
$staged=Join-Path $StagedRoot 'tools\powershell-direct\stack-supervisor.mjs'
$stageManifest=Join-Path $StagedRoot 'source-hashes.json'
$paths=@(
 'tools\powershell-direct\service.mjs',
 'tools\powershell-direct\stack-supervisor.mjs',
 'tools\ai_collaboration\engineering-plan.mjs',
 'tools\ai_collaboration\engineering-runner.mjs',
 'tools\ai_collaboration\engineering-mcp.mjs',
 'tools\ai_collaboration\local_job_service.mjs'
)
$sourcePresent=(Test-Path -LiteralPath $source -PathType Leaf)
$stagePresent=(Test-Path -LiteralPath $staged -PathType Leaf)
$verified=@()
foreach($relative in $paths){
 $a=Join-Path $PlatformCheckout $relative
 $b=Join-Path $StagedRoot $relative
 $good=(Test-Path -LiteralPath $a -PathType Leaf) -and
       (Test-Path -LiteralPath $b -PathType Leaf) -and
       ((Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash -ceq
        (Get-FileHash -LiteralPath $b -Algorithm SHA256).Hash)
 $verified+= [pscustomobject]@{RelativeFile=$relative;CurrentSourceEqualsStaged=$good}
}
$listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
$ownerId=if($listeners.Count -eq 1){[int]$listeners[0].OwningProcess}else{$null}
$owner=$null
if($ownerId){
 $owner=@(Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId" -ErrorAction SilentlyContinue)
}
$node='C:\Program Files\nodejs\node.exe'
$expectedOriginal='C:\Engineering\ChromeBridge-PowerShell-Direct-Validation\tools\powershell-direct\stack-supervisor.mjs'
$ownerVerified=$owner.Count -eq 1 -and $owner[0].Name -eq 'node.exe' -and
 ($owner[0].ExecutablePath -ieq $node) -and
 ($owner[0].CommandLine -like ('*'+$expectedOriginal+'*'))
$remoteToolKey='powershell_engineering_submit'
$stagedSource=if($stagePresent){Get-Content -LiteralPath $staged -Raw}else{''}
$readiness=$sourcePresent -and $stagePresent -and
  @($verified|Where-Object {-not $_.CurrentSourceEqualsStaged}).Count -eq 0 -and
  $listeners.Count -eq 1 -and $ownerVerified -and
  (Test-Path -LiteralPath $stageManifest -PathType Leaf) -and
  $stagedSource.Contains('PS_DIRECT_ENGINEERING_WORKSPACES') -and
  $stagedSource.Contains('PS_DIRECT_ENGINEERING_AUDIT_DIR')
[pscustomobject]@{
 Check='READ_ONLY_POWERSHELL_DIRECT_CUTOVER_PREFLIGHT'
 Port=$Port
 ListenerCount=$listeners.Count
 ListenerPID=$ownerId
 ListenerOwnerMatchesExpectedOriginalSupervisor=[bool]$ownerVerified
 SourceFilesMatchStaged=$verified
 StagedHashManifestExists=(Test-Path -LiteralPath $stageManifest -PathType Leaf)
 TargetSupportsEngineeringEnvironment=$stagedSource.Contains('PS_DIRECT_ENGINEERING_WORKSPACES')
 ExistingTunnelClientProcessCount=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue).Count
 ReadyForReviewedCutoverPlan=[bool]$readiness
 NewRemoteToolsConnected=$false
 ProductionChanged=$false
 Note='Read-only preflight; does not prove remote tunnel health or credential availability'
}|ConvertTo-Json -Depth 6
