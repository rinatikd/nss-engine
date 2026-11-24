# Read-only preflight for replacing the legacy PowerShell Direct supervisor
# with the isolated PR138 current-head stage. Never stops, starts or writes.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R2-PR138-35e69e7'
$expectedCommit='35e69e7e58c7e1b054a0771cabce07cc0c4108df'
$old='C:\Engineering\ChromeBridge-PowerShell-Direct-Validation\tools\powershell-direct\stack-supervisor.mjs'
$new=Join-Path $stage 'tools\powershell-direct\stack-supervisor.mjs'
$recover=Join-Path $repo 'tools\ai_collaboration\recovery\Recover-PowerShellDirect.ps1'
$node='C:\Program Files\nodejs\node.exe'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$approvalFile=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\Approval\powershell-direct-ui.dpapi'
$audit='C:\Engineering\PowerShellDirect-Engineering-Audit-R2-PR138-35e69e7'
$ports=@(17381,17382,17486,18086,17488)

function Get-Listener([int]$Port){
 $items=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
 if($items.Count -gt 1){return [pscustomobject]@{Count=$items.Count;Pid=$null}}
 if($items.Count -eq 0){return [pscustomobject]@{Count=0;Pid=$null}}
 return [pscustomobject]@{Count=1;Pid=[int]$items[0].OwningProcess}
}
function Test-RemoteHealth([int]$TunnelPid){
 $psi=New-Object System.Diagnostics.ProcessStartInfo
 $psi.FileName=$client
 $psi.Arguments='health --port 18086 --pid '+$TunnelPid+' --require-control-plane-poll --json'
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=New-Object System.Diagnostics.Process
 $p.StartInfo=$psi
 try{
  if(!$p.Start()){return $false}
  $outTask=$p.StandardOutput.ReadToEndAsync()
  $errTask=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(10000)){try{$p.Kill()}catch{};return $false}
  $raw=$outTask.GetAwaiter().GetResult()
  $null=$errTask.GetAwaiter().GetResult()
  if($raw.Length -gt 32768){return $false}
  if($p.ExitCode -ne 0){return $false}
  $j=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  return ($j.result -eq 'ok' -and $j.healthz.ok -eq $true -and
          $j.readyz.ok -eq $true -and $j.control_plane_poll.ok -eq $true)
 }catch{return $false}
 finally{$p.Dispose()}
}

$checks=[ordered]@{}
$listener17486=Get-Listener 17486
$listener18086=Get-Listener 18086
$listener17381=Get-Listener 17381
$listener17382=Get-Listener 17382
$listener17488=Get-Listener 17488

$checks.NodeExecutablePresent=Test-Path -LiteralPath $node -PathType Leaf
$checks.TunnelExecutablePresent=Test-Path -LiteralPath $client -PathType Leaf
$checks.CandidateSupervisorPresent=Test-Path -LiteralPath $new -PathType Leaf
$checks.RecoveryScriptPresent=Test-Path -LiteralPath $recover -PathType Leaf
$checks.RuntimeCredentialFilePresent=Test-Path -LiteralPath $credential -PathType Leaf
$checks.ApprovalTokenFilePresent=Test-Path -LiteralPath $approvalFile -PathType Leaf

$stageCommitMatch=$false
$manifestCount=0
$manifestHashesValid=$false
$policyPerJob=$false
$credentialDecryptable=$false
$recoveryTargetsOriginal=$false
$supervisorIdentity=$false
$tunnelIdentity=$false
$remoteHealth=$false
$stageAuditSafe=$false

if(Test-Path -LiteralPath (Join-Path $stage 'source-hashes.json') -PathType Leaf){
 try{
  $manifest=Get-Content -LiteralPath (Join-Path $stage 'source-hashes.json') -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  $manifestCount=@($manifest).Count
  $manifestHashesValid=$manifestCount -eq 110 -and @($manifest|Where-Object {
   $_.File -notmatch '^tools/(powershell-direct|ai_collaboration)/' -or
   $_.Sha256 -notmatch '^[0-9a-fA-F]{64}$'
  }).Count -eq 0
  $manifestHashesValid=$manifestHashesValid -and @($manifest|Where-Object {
   $file=Join-Path $stage ($_.File.Replace('/','\'))
   !(Test-Path -LiteralPath $file -PathType Leaf) -or
   (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $_.Sha256
  }).Count -eq 0
 }catch{$manifestHashesValid=$false}
}
$checks.CandidateManifestHas110VerifiedFiles=$manifestHashesValid

if($checks.CandidateSupervisorPresent){
 $supervisorSource=Get-Content -LiteralPath $new -Raw
 $serviceSource=Get-Content -LiteralPath (Join-Path $stage 'tools\powershell-direct\service.mjs') -Raw
 $planSource=Get-Content -LiteralPath (Join-Path $stage 'tools\ai_collaboration\engineering-plan.mjs') -Raw
 $policyPerJob=($supervisorSource.Contains('PS_DIRECT_ENGINEERING_AUDIT_DIR') -and
  !$supervisorSource.Contains('PS_DIRECT_ALLOWED_ROOT') -and
  !$supervisorSource.Contains('PS_DIRECT_ENGINEERING_WORKSPACES') -and
  !$supervisorSource.Contains('PS_DIRECT_NAMED_SUITE_WORKSPACES') -and
  $serviceSource.Contains('engineeringAuditDirectory') -and
  $planSource.Contains('canonicalUserWorkspace'))
}
$checks.PerJobWorkspaceAndNoLegacyAllowlist=$policyPerJob

if($checks.RecoveryScriptPresent){
 $recoverySource=Get-Content -LiteralPath $recover -Raw
 $recoveryTargetsOriginal=$recoverySource.Contains($old)
}
$checks.RollbackScriptTargetsOriginalSupervisor=$recoveryTargetsOriginal

if($checks.RuntimeCredentialFilePresent){
 $secure=$null
 try{
  $cipher=(Get-Content -LiteralPath $credential -Raw -Encoding UTF8).Trim()
  $secure=ConvertTo-SecureString -String $cipher -ErrorAction Stop
  $credentialDecryptable=($secure.Length -ge 8)
 }catch{$credentialDecryptable=$false}
 finally{if($secure){$secure.Dispose()}}
}
$checks.RuntimeCredentialDecryptable=$credentialDecryptable

if($listener17486.Count -eq 1 -and $listener18086.Count -eq 1){
 $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener17486.Pid)" -ErrorAction SilentlyContinue
 $supervisorIdentity=($null -ne $owner -and $owner.Name -ieq 'node.exe' -and
  $owner.ExecutablePath -ieq $node -and $owner.CommandLine -and
  $owner.CommandLine.Contains($old))
 if($supervisorIdentity){
  $children=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
   Where-Object {$_.ParentProcessId -eq $listener17486.Pid -and $_.ExecutablePath -ieq $client})
  $tunnelIdentity=($children.Count -eq 1 -and $children[0].ProcessId -eq $listener18086.Pid)
  if($tunnelIdentity){$remoteHealth=Test-RemoteHealth ([int]$listener18086.Pid)}
 }
}
$checks.ExistingSupervisorExactIdentity=$supervisorIdentity
$checks.ExistingChildTunnelExactIdentity=$tunnelIdentity
$checks.ExistingTunnelRemoteHealthPoll=$remoteHealth

$auditRoot=[IO.Path]::GetFullPath($audit)
$repoRoot=[IO.Path]::GetFullPath($repo).TrimEnd('\')+'\'
$stageAuditSafe=(!$auditRoot.StartsWith($repoRoot,[StringComparison]::OrdinalIgnoreCase))
if(Test-Path -LiteralPath $audit){
 $auditItem=Get-Item -LiteralPath $audit -Force
 $stageAuditSafe=$stageAuditSafe -and $auditItem.PSIsContainer -and
  (($auditItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}else{$stageAuditSafe=$stageAuditSafe -and (Test-Path -LiteralPath 'C:\Engineering' -PathType Container)}
$checks.AuditDirectoryOutsideGitCheckout=$stageAuditSafe

$checks.PsDirectListener17486Unique=$listener17486.Count -eq 1
$checks.TunnelListener18086Unique=$listener18086.Count -eq 1
$checks.OldR2DiagnosticPortNotAliased=($listener17488.Count -eq 0 -or
 ($listener17488.Pid -ne $listener17486.Pid -and $listener17488.Pid -ne $listener18086.Pid))

$failures=@($checks.GetEnumerator()|Where-Object{$_.Value -ne $true}|ForEach-Object{$_.Key})
[pscustomobject]@{
 Check='PR138_CURRENT_R2_CUTOVER_PREFLIGHT_READ_ONLY'
 CandidateCommit=$expectedCommit
 Stage=$stage
 ExistingSupervisorPid=$listener17486.Pid
 ExistingTunnelPid=$listener18086.Pid
 Bridge17381Pid=$listener17381.Pid
 Bridge17382Pid=$listener17382.Pid
 ExistingR2DiagnosticPid=$listener17488.Pid
 VerifiedManifestFileCount=$manifestCount
 AuditDirectory=$audit
 VerifiedChecks=$checks
 FailedChecks=$failures
 ReadyToDraftOperatorTransaction=($failures.Count -eq 0)
 CredentialValuesEmitted=$false
 ApprovalTokenEmitted=$false
 ProcessCommandLinesEmitted=$false
 FilesWritten=$false
 ProcessesStartedOrStopped=$false
 ProductionTouched=$false
 TunnelTouched=$false
}|ConvertTo-Json -Depth 6
