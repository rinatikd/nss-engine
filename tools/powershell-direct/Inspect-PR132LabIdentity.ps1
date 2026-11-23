# Read-only PR102 Lab owner identity inspection using the exact PR #132 native helper.
# Does not stop/start processes, read credential values or alter state.
[CmdletBinding()]
param([ValidateRange(1,2147483647)][int]$ExpectedPid=21152)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$checkout=Join-Path $workspace 'work\ChromeBridge-PR132-22cdfb36'
$candidate=Join-Path $checkout 'docs\chrome-bridge-handoff\chrome-bridge-v20'
$helper=Join-Path $candidate 'deployment\process-identity.ps1'
$expectedSha='22cdfb36b43b4f9ddf7f96d3cffe042a40616200'
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

$stateEvidence=@()
$configPaths=@(
 (Join-Path $labRoot 'config.json'),
 (Join-Path $labRoot 'state\config.json'),
 (Join-Path $labRoot 'data\config.json'),
 (Join-Path $labRoot '.state\config.json'),
 (Join-Path $env:USERPROFILE '.chrome-bridge\config.json')
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
$transactionJob=$null
$command=[string]$identity.command
$match=[regex]::Match($command,'^"(?<exe>[^"]+)"\s+"(?<script>[^"]+\\cutover-start\.mjs)"\s+"(?<job>[^"]+\\start-[0-9a-f]{32}\.json)"$',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
if($match.Success){
 $jobPath=[IO.Path]::GetFullPath($match.Groups['job'].Value)
 if(Test-Path -LiteralPath $jobPath -PathType Leaf){
   $job=Get-Content -LiteralPath $jobPath -Raw -Encoding UTF8|ConvertFrom-Json
   $transactionJob=[pscustomobject]@{
     JobPath=$jobPath
     Source=$job.source
     State=$job.state
     Port=$job.port
     ConfigSha256=$job.configHash
     SourceMatchesLab=([IO.Path]::GetFullPath([string]$job.source) -ieq $labRoot)
   }
 }
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
 ParentIdentity=$parentIdentity
 TransactionJob=$transactionJob
 ConfigCandidates=$stateEvidence
 LabRootExists=(Test-Path -LiteralPath $labRoot -PathType Container)
 NoCredentialValuesPrinted=$true
 ProcessModified=$false
 LabModified=$false
 ProductionModified=$false
}|ConvertTo-Json -Depth 8
