# Read-only final rehearsal of controlled PowerShell Direct engineering cutover.
# NEVER stops/starts a process or tunnel, reads credentials, or writes files.
[CmdletBinding()]
param([ValidateSet('Inspect')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
$old='C:\Engineering\ChromeBridge-PowerShell-Direct-Validation\tools\powershell-direct\stack-supervisor.mjs'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$replacement=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$recover='C:\Engineering\ChromeBridge-Recovery-Install-20261114\tools\ai_collaboration\recovery\Recover-PowerShellDirect.ps1'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$node='C:\Program Files\nodejs\node.exe'
$engineeringAudit='C:\Engineering\PowerShellDirect-Engineering-Audit-R1'
$ports=17486,18086
$ls=@{}
foreach($port in $ports){
 $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 $ls[$port]=@{count=$listeners.Count;pid=if($listeners.Count -eq 1){[int]$listeners[0].OwningProcess}else{$null}}
}
$superPid=$ls[17486].pid
$proc=if($superPid){Get-CimInstance Win32_Process -Filter "ProcessId=$superPid" -ErrorAction SilentlyContinue}else{$null}
$originalOwner=$ls[17486].count -eq 1 -and $null -ne $proc -and
 $proc.Name -ieq 'node.exe' -and $proc.ExecutablePath -ieq $node -and
 $proc.CommandLine -and $proc.CommandLine.Contains($old)
$tunnel=@()
if($originalOwner){
 $tunnel=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.ParentProcessId -eq $superPid -and $_.ExecutablePath -ieq $client})
}
$tunnelOwner=$tunnel.Count -eq 1 -and $ls[18086].count -eq 1 -and $ls[18086].pid -eq $tunnel[0].ProcessId
$files=@(
 'tools\powershell-direct\service.mjs',
 'tools\powershell-direct\stack-supervisor.mjs',
 'tools\ai_collaboration\engineering-plan.mjs',
 'tools\ai_collaboration\engineering-runner.mjs',
 'tools\ai_collaboration\engineering-mcp.mjs',
 'tools\ai_collaboration\local_job_service.mjs',
 'tools\ai_collaboration\workspace-policy.mjs'
)
$source='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$parity=@()
foreach($file in $files){
 $left=Join-Path $source $file
 $right=Join-Path $stage $file
 $match=(Test-Path -LiteralPath $left -PathType Leaf) -and
        (Test-Path -LiteralPath $right -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $left -Algorithm SHA256).Hash -eq
         (Get-FileHash -LiteralPath $right -Algorithm SHA256).Hash)
 $parity+=[pscustomobject]@{File=$file;Match=[bool]$match}
}
$recoverSource=if(Test-Path -LiteralPath $recover -PathType Leaf){
 Get-Content -LiteralPath $recover -Raw
}else{''}
$restoreTargetsOld=$recoverSource.Contains($old)
$envFeatures=if(Test-Path -LiteralPath $replacement -PathType Leaf){
 $src=Get-Content -LiteralPath $replacement -Raw
 $plan=Get-Content -LiteralPath (Join-Path $stage 'tools\ai_collaboration\engineering-plan.mjs') -Raw
 $policy=Get-Content -LiteralPath (Join-Path $stage 'tools\ai_collaboration\workspace-policy.mjs') -Raw
 $src.Contains('PS_DIRECT_ENGINEERING_AUDIT_DIR') -and
 !$src.Contains('PS_DIRECT_ENGINEERING_WORKSPACES') -and
 !$src.Contains('PS_DIRECT_NAMED_SUITE_WORKSPACES') -and
 !$src.Contains('PS_DIRECT_ALLOWED_ROOT') -and
 $plan.Contains('canonicalUserWorkspace') -and
 $policy.Contains('WORKSPACE_VOLUME_ROOT_DENIED')
}else{$false}
$checks=[ordered]@{
 VerifiedOriginalSupervisor=[bool]$originalOwner
 VerifiedOriginalTunnel=[bool]$tunnelOwner
 ExistingRecoveryScriptTargetsOriginal=[bool]$restoreTargetsOld
 StageSupervisorExists=(Test-Path -LiteralPath $replacement -PathType Leaf)
 StagedEngineeringOptInSupported=[bool]$envFeatures
 SevenRequiredSourceHashesMatch=(@($parity|Where-Object {-not $_.Match}).Count -eq 0)
 ExistingRuntimeKeyFilePresent=(Test-Path -LiteralPath $credential -PathType Leaf)
 ExpectedTunnelExecutablePresent=(Test-Path -LiteralPath $client -PathType Leaf)
 ExpectedNodeExecutablePresent=(Test-Path -LiteralPath $node -PathType Leaf)
 WorkspacePolicyPerJobAndNoStaticRoots=[bool]$envFeatures
 AuditPathIsNotInsideGitCheckout=(!$engineeringAudit.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase))
}
$ok=@($checks.Values|Where-Object {$_ -ne $true}).Count -eq 0
[pscustomobject]@{
 Check='ENGINEERING_CUTOVER_PREPARATION_READ_ONLY'
 OriginalSupervisorPid=$superPid
 OriginalTunnelPid=if($tunnel.Count -eq 1){$tunnel[0].ProcessId}else{$null}
 StageRoot=$stage
 WorkspaceSelection='PER_JOB_CANONICAL_PATH_LOCAL_APPROVAL'
 EngineeringAuditDirectory=$engineeringAudit
 VerifiedChecks=$checks
 ReadyToDraftOperatorTransaction=[bool]$ok
 AuthorizeShutdown=$false
 RemoteKeyValidatedByThisScript=$false
 BrowserToolRediscoveryVerified=$false
 ProductionTouched=$false
 Note='No cutover or restart performed. Require independent remote auth evidence and rollback procedure.'
}|ConvertTo-Json -Depth 6
