# Read-only PR102 Lab owner identity inspection using the exact PR #132 native helper.
# Does not stop/start processes, read credential values or alter state.
[CmdletBinding()]
param([ValidateRange(1,2147483647)][int]$ExpectedPid=21152)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$checkout=Join-Path $workspace 'work\ChromeBridge-PR132-fb2c27a8'
$candidate=Join-Path $checkout 'docs\chrome-bridge-handoff\chrome-bridge-v20'
$helper=Join-Path $candidate 'deployment\process-identity.ps1'
$expectedSha='fb2c27a843d04e08b97dae876226751d9f3685fd'
$labRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$labExtensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'
if(!(Test-Path -LiteralPath $helper -PathType Leaf)){throw 'PINNED_PROCESS_IDENTITY_HELPER_NOT_FOUND'}
. $helper
$sha=(& 'C:\Program Files\Git\cmd\git.exe' -C $checkout rev-parse HEAD | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $sha -cne $expectedSha){throw 'PINNED_CANDIDATE_SHA_MISMATCH'}

$listeners=@([BridgeNativeMetadata]::Listeners(17484))
$listenerOwner=if($listeners.Count -eq 1){[string]$listeners[0]}else{$null}
$expectedOwner='127.0.0.1|'+$ExpectedPid
if($listeners.Count -ne 1 -or $listenerOwner -cne $expectedOwner){
  throw ('LAB_LISTENER_IDENTITY_MISMATCH: '+($listeners -join ';'))
}

$identity=Get-BridgeIdentity $ExpectedPid
$proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ExpectedPid) -ErrorAction Stop
if(!$proc -or $proc.Name -ine 'node.exe'){throw 'LAB_OWNER_NOT_NODE'}
$ownerResult=Invoke-CimMethod -InputObject $proc -MethodName GetOwner -ErrorAction SilentlyContinue
$parentIdentity=$null
if($proc.ParentProcessId){
  try{$parentIdentity=Get-BridgeIdentity ([int]$proc.ParentProcessId)}catch{$parentIdentity=$null}
}

# Only inspect candidate state files beneath the exact Lab root. Never fall back
# to the user's default ~/.chrome-bridge profile, which may belong to Production.
$stateEvidence=@()
$configPaths=@(
 (Join-Path $labRoot 'config.json'),
 (Join-Path $labRoot 'state\config.json'),
 (Join-Path $labRoot 'data\config.json'),
 (Join-Path $labRoot '.state\config.json')
)
foreach($path in $configPaths){
 if(Test-Path -LiteralPath $path -PathType Leaf){
   $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
   $cfg=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
   $stateEvidence+= [pscustomobject]@{
     ConfigPath=$path
     StateRoot=(Split-Path -Parent $path)
     ConfigSha256=$hash
     ExtensionIdMatches=($cfg.extensionId -ceq $labExtensionId)
     AgentTokenPresent=($cfg.agentToken -is [string] -and $cfg.agentToken.Length -ge 32)
     BrowserTokenPresent=($cfg.browserToken -is [string] -and $cfg.browserToken.Length -ge 32)
   }
 }
}
$matchingConfigs=@($stateEvidence|Where-Object {
 $_.ExtensionIdMatches -and $_.AgentTokenPresent -and $_.BrowserTokenPresent
})
if($matchingConfigs.Count -ne 1){
 throw ('LAB_CONFIG_IDENTITY_NOT_UNIQUE: matching Lab config count='+$matchingConfigs.Count)
}
$labConfig=$matchingConfigs[0]
$transactionJob=$null
$command=([string]$identity.command).Replace('/','\')
$expectedBridge=(Join-Path $labRoot 'server\bridge.mjs').Replace('/','\')
$directServer=$command.IndexOf($expectedBridge,[StringComparison]::OrdinalIgnoreCase) -ge 0
$match=[regex]::Match($command,'^"(?<exe>[^"]+)"\s+"(?<script>[^"]+\\cutover-start\.mjs)"\s+"(?<job>[^"]+\\start-[0-9a-f]{32}\.json)"$',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
if($match.Success){
 $jobPath=[IO.Path]::GetFullPath($match.Groups['job'].Value)
 $scriptPath=[IO.Path]::GetFullPath($match.Groups['script'].Value)
 $jobRoot=(Split-Path -Parent $jobPath)
 if(!(Test-Path -LiteralPath $jobPath -PathType Leaf)){throw 'LAB_TRANSACTION_JOB_MISSING'}
 $job=Get-Content -LiteralPath $jobPath -Raw -Encoding UTF8|ConvertFrom-Json
 $jobState=[IO.Path]::GetFullPath([string]$job.state)
 $transactionJob=[pscustomobject]@{
   JobPath=$jobPath
   ScriptPath=$scriptPath
   Source=[IO.Path]::GetFullPath([string]$job.source)
   State=$jobState
   Port=[int]$job.port
   ConfigSha256=[string]$job.configHash
   SourceMatchesLab=([IO.Path]::GetFullPath([string]$job.source) -ieq $labRoot)
   StateMatchesConfig=($jobState -ieq $labConfig.StateRoot)
   ConfigHashMatches=([string]$job.configHash -eq $labConfig.ConfigSha256)
   ScriptWithinLab=($scriptPath.StartsWith($labRoot+'\',[StringComparison]::OrdinalIgnoreCase))
   JobWithinLab=($jobPath.StartsWith($labRoot+'\',[StringComparison]::OrdinalIgnoreCase))
   SameTransactionRoot=($jobRoot -ieq (Split-Path -Parent $scriptPath))
 }
 $transactionValid=($transactionJob.SourceMatchesLab -and $transactionJob.StateMatchesConfig -and
   $transactionJob.ConfigHashMatches -and $transactionJob.Port -eq 17484 -and
   $transactionJob.ScriptWithinLab -and $transactionJob.JobWithinLab -and
   $transactionJob.SameTransactionRoot)
}else{
 $transactionValid=$false
}
if(-not ($directServer -or $transactionValid)){
 throw 'LAB_PROCESS_COMMAND_LINE_NOT_PINNED_TO_EXPECTED_LAB_SERVER'
}
[pscustomobject]@{
 Check='PR102_LAB_PROCESS_IDENTITY_READ_ONLY'
 CandidateSha=$sha
 Listener=$listenerOwner
 ProcessId=$identity.id
 ProcessName=$proc.Name
 ParentProcessId=[int]$proc.ParentProcessId
 ProcessOwner=if($ownerResult.ReturnValue -eq 0){$ownerResult.Domain+'\'+$ownerResult.User}else{$null}
 Executable=$identity.executable
 CommandLine=$identity.command
 StartTimeUtc=$identity.created
 DirectServerCommandMatchesLab=$directServer
 TransactionLauncherVerified=[bool]$transactionValid
 TransactionJob=$transactionJob
 StateRoot=$labConfig.StateRoot
 ConfigPath=$labConfig.ConfigPath
 ConfigSha256=$labConfig.ConfigSha256
 AgentTokenPresent=$labConfig.AgentTokenPresent
 BrowserTokenPresent=$labConfig.BrowserTokenPresent
 LabRootExists=(Test-Path -LiteralPath $labRoot -PathType Container)
 NoCredentialValuesPrinted=$true
 ProcessModified=$false
 LabModified=$false
 ProductionModified=$false
}|ConvertTo-Json -Depth 8
