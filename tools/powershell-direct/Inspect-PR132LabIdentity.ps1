# Read-only PR102 Lab process/config identity for the pinned PR #132 release candidate.
# Does not stop/start processes, read credential values or alter Lab/Production.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$checkout=Join-Path $workspace 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$candidate=Join-Path $checkout 'docs\chrome-bridge-handoff\chrome-bridge-v20'
$helper=Join-Path $candidate 'deployment\process-identity.ps1'
$expectedSha='fb2c27a843d04e08b97dae876226751d9f3685fd'
$labRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$labExtensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'
$git='C:\Program Files\Git\cmd\git.exe'

$resolvedWorkspace=(Resolve-Path -LiteralPath $workspace).ProviderPath.TrimEnd('\')
if($resolvedWorkspace -ine $workspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $candidate -PathType Container)){throw 'PINNED_CANDIDATE_NOT_FOUND'}
if(!(Test-Path -LiteralPath $helper -PathType Leaf)){throw 'PINNED_PROCESS_IDENTITY_HELPER_NOT_FOUND'}
if(!(Test-Path -LiteralPath $labRoot -PathType Container)){throw 'PR102_LAB_ROOT_NOT_FOUND'}
. $helper

# Verify the checkout commit without relying on PowerShell native-output pipeline capture.
$psi=New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName=$git
$psi.Arguments='rev-parse HEAD'
$psi.WorkingDirectory=$checkout
$psi.UseShellExecute=$false
$psi.CreateNoWindow=$true
$psi.RedirectStandardOutput=$true
$psi.RedirectStandardError=$true
$gitProcess=New-Object System.Diagnostics.Process
$gitProcess.StartInfo=$psi
if(!$gitProcess.Start()){throw 'GIT_PROCESS_START_FAILED'}
$gitOut=$gitProcess.StandardOutput.ReadToEndAsync()
$gitErr=$gitProcess.StandardError.ReadToEndAsync()
if(!$gitProcess.WaitForExit(15000)){try{$gitProcess.Kill()}catch{};throw 'GIT_READ_TIMEOUT'}
$gitProcess.WaitForExit()
$sha=([string]$gitOut.Result).Trim()
if($gitProcess.ExitCode -ne 0 -or $sha -cne $expectedSha){throw 'PINNED_CANDIDATE_SHA_MISMATCH'}
if(![string]::IsNullOrWhiteSpace([string]$gitErr.Result)){throw 'GIT_METADATA_DIAGNOSTIC_STDERR'}

$listeners=@([BridgeNativeMetadata]::Listeners(17484))
if($listeners.Count -ne 1){throw ('LAB_LISTENER_COUNT_MISMATCH: '+$listeners.Count)}
$listenerParts=([string]$listeners[0]).Split('|')
if($listenerParts.Count -ne 2 -or $listenerParts[0] -cne '127.0.0.1'){throw 'LAB_LISTENER_ADDRESS_MISMATCH'}
$pidNumber=0
if(![int]::TryParse($listenerParts[1],[ref]$pidNumber) -or $pidNumber -le 0){throw 'LAB_LISTENER_PID_INVALID'}

$identity=Get-BridgeIdentity $pidNumber
$proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidNumber) -ErrorAction Stop
if(!$proc -or $proc.Name -ine 'node.exe'){throw 'LAB_OWNER_NOT_NODE'}
$expectedExe=(Get-Command node.exe -ErrorAction Stop).Source
if($identity.executable -ine $expectedExe){throw 'LAB_NODE_EXECUTABLE_MISMATCH'}

# Inspect only candidate state files below the exact Lab root; never fall back to a user profile.
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
   $stateEvidence += [pscustomobject]@{
     ConfigPath=$path
     StateRoot=(Split-Path -Parent $path)
     ConfigSha256=$hash
     ExtensionIdMatches=($cfg.extensionId -ceq $labExtensionId)
     AgentTokenPresent=($cfg.agentToken -is [string] -and $cfg.agentToken.Length -ge 32)
     BrowserTokenPresent=($cfg.browserToken -is [string] -and $cfg.browserToken.Length -ge 32)
   }
 }
}
$matchingConfigs=@($stateEvidence | Where-Object {
  $_.ExtensionIdMatches -and $_.AgentTokenPresent -and $_.BrowserTokenPresent
})
if($matchingConfigs.Count -ne 1){
 throw ('LAB_CONFIG_IDENTITY_NOT_UNIQUE: matching Lab config count='+$matchingConfigs.Count)
}
$labConfig=$matchingConfigs[0]

$command=([string]$identity.command).Replace('/','\')
$expectedBridge=(Join-Path $labRoot 'server\bridge.mjs').Replace('/','\')
$directServer=$command.IndexOf($expectedBridge,[StringComparison]::OrdinalIgnoreCase) -ge 0
$transactionJob=$null
$transactionValid=$false
$commandKind='UNMATCHED'
$match=[regex]::Match(
 $command,
 '^"(?<exe>[^"]+)"\s+"(?<script>[^"]+\\cutover-start\.mjs)"\s+"(?<job>[^"]+\\start-[0-9a-f]{32}\.json)"$',
 [Text.RegularExpressions.RegexOptions]::IgnoreCase
)
if($match.Success){
 $jobPath=[IO.Path]::GetFullPath($match.Groups['job'].Value)
 $scriptPath=[IO.Path]::GetFullPath($match.Groups['script'].Value)
 $jobRoot=(Split-Path -Parent $jobPath)
 if(!(Test-Path -LiteralPath $jobPath -PathType Leaf)){throw 'LAB_TRANSACTION_JOB_MISSING'}
 $job=Get-Content -LiteralPath $jobPath -Raw -Encoding UTF8|ConvertFrom-Json
 $jobState=[IO.Path]::GetFullPath([string]$job.state)
 $jobSource=[IO.Path]::GetFullPath([string]$job.source)
 $transactionJob=[pscustomobject]@{
   JobPath=$jobPath
   ScriptPath=$scriptPath
   SourceMatchesLab=($jobSource -ieq $labRoot)
   StateMatchesConfig=($jobState -ieq $labConfig.StateRoot)
   Port=[int]$job.port
   ConfigHashMatches=([string]$job.configHash -eq $labConfig.ConfigSha256)
   ScriptWithinLab=$scriptPath.StartsWith($labRoot+'\',[StringComparison]::OrdinalIgnoreCase)
   JobWithinLab=$jobPath.StartsWith($labRoot+'\',[StringComparison]::OrdinalIgnoreCase)
   SameTransactionRoot=($jobRoot -ieq (Split-Path -Parent $scriptPath))
 }
 $transactionValid=(
   $transactionJob.SourceMatchesLab -and
   $transactionJob.StateMatchesConfig -and
   $transactionJob.Port -eq 17484 -and
   $transactionJob.ConfigHashMatches -and
   $transactionJob.ScriptWithinLab -and
   $transactionJob.JobWithinLab -and
   $transactionJob.SameTransactionRoot
 )
 if($transactionValid){$commandKind='transaction-launcher'}
}
if($directServer){$commandKind='direct-bridge'}
if(-not ($directServer -or $transactionValid)){
 throw 'LAB_PROCESS_COMMAND_LINE_NOT_PINNED_TO_EXPECTED_LAB_SERVER'
}

$startUtc=[DateTime]::Parse($identity.created).ToUniversalTime().ToString('o')
[pscustomobject]@{
 Check='PR102_LAB_PROCESS_IDENTITY_READ_ONLY'
 CandidateSha=$sha
 LabRoot=$labRoot
 StateRoot=$labConfig.StateRoot
 ConfigPath=$labConfig.ConfigPath
 ConfigSha256=$labConfig.ConfigSha256
 ExtensionIdMatches=$true
 AgentTokenPresent=$labConfig.AgentTokenPresent
 BrowserTokenPresent=$labConfig.BrowserTokenPresent
 ListenerAddress=$listenerParts[0]
 ExpectedPid=$pidNumber
 ExpectedStartUtc=$startUtc
 ProcessName=$proc.Name
 Executable=$identity.executable
 CommandLineKind=$commandKind
 TransactionJob=$transactionJob
 NoCredentialValuesPrinted=$true
 ProcessModified=$false
 LabModified=$false
 ProductionModified=$false
}|ConvertTo-Json -Depth 8
