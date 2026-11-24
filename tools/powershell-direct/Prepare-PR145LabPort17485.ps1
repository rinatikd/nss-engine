# Read-only PR145 preparation for PR102 Lab on port 17485.
# Runs source/identity checks plus server-bootstrap and extension-updater dry-runs only.
# It never uses -Apply and never stops the Consilium or Production processes.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$repo=Join-Path $workspaceExpected 'work\ChromeBridge-PR145-754b8f5f-release-clean'
$candidateRoot=Join-Path $repo 'docs\chrome-bridge-handoff\chrome-bridge-v20'
$expectedSha='754b8f5f30663dab9cefcd87b47b51ecb4c0dcdd'
$expectedMergeRef='refs/remotes/origin/pr145/merge'
$remoteExpected='github.com/rinatikd/nss-engine'

$labServerRoot='C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20'
$labExtensionRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$labStateRoot='C:\Engineering\ChromeBridge-PR102-17484-State'
$labPort=17485
$labExtensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'

$consiliumRoot='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0'
$consiliumStateRoot='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0-State'
$consiliumPort=17484
$consiliumExtensionId='ojkfdjndmcpnphecoadbcnmlnadmmkah'

$productionPorts=@(17381,17382)
$git='C:\Program Files\Git\cmd\git.exe'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

. (Join-Path $candidateRoot 'deployment\process-identity.ps1')
. (Join-Path $candidateRoot 'deployment\verify-candidate-source.ps1')

function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function FullPath([string]$Value){Get-BridgeCanonicalPath $Value}
function AssertNoReparse([string]$Path){
  Require (Test-Path -LiteralPath $Path -PathType Container) ('Required Lab root missing: '+$Path)
  Require (-not ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) ('Reparse point refused: '+$Path)
}
function HashFile([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function TreeHash([string]$Path){
  $base=FullPath $Path
  $rows=@()
  foreach($item in Get-ChildItem -LiteralPath $base -Recurse -Force){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('Reparse point in Lab tree: '+$item.FullName)}
    if(-not $item.PSIsContainer){
      $relative=$item.FullName.Substring($base.Length).TrimStart('\').Replace('\','/')
      $rows+=($relative+':'+$item.Length+':'+(HashFile $item.FullName))
    }
  }
  return (($rows|Sort-Object) -join '|')
}
function ListenerSignature([int]$Port){
  return ((@([BridgeNativeMetadata]::Listeners($Port)|Sort-Object)) -join ';')
}
function InvokeGit([string[]]$Args){
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments=('-C "'+$repo+'" '+[string]::Join(' ',@($Args|ForEach-Object {'"'+([string]$_).Replace('"','\"')+'"'})))
  $psi.WorkingDirectory=$repo
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $p=New-Object Diagnostics.Process
  $p.StartInfo=$psi
  try{
    Require ($p.Start()) 'Could not start trusted Git'
    $outTask=$p.StandardOutput.ReadToEndAsync()
    $errTask=$p.StandardError.ReadToEndAsync()
    Require ($p.WaitForExit(30000)) 'Trusted Git timed out'
    $stdout=[string]$outTask.GetAwaiter().GetResult()
    $stderr=[string]$errTask.GetAwaiter().GetResult()
    Require ($p.ExitCode -eq 0) ('Git query failed: '+$stderr)
    return $stdout.Trim()
  }finally{$p.Dispose()}
}
function RemoteIdentity([string]$Value){
  $uri=$null
  if([Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -and $uri.Host){
    $remotePath=$uri.AbsolutePath.TrimEnd('/')
    if($remotePath.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$remotePath=$remotePath.Substring(0,$remotePath.Length-4)}
    return ($uri.Host.ToLowerInvariant()+$remotePath.ToLowerInvariant())
  }
  if($Value -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
    $remotePath=$Matches.path.TrimStart('/').TrimEnd('/')
    if($remotePath.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$remotePath=$remotePath.Substring(0,$remotePath.Length-4)}
    return ($Matches.host.ToLowerInvariant()+'/'+$remotePath.ToLowerInvariant())
  }
  return ''
}
function GetConsiliumIdentity {
  $listeners=@([BridgeNativeMetadata]::Listeners($consiliumPort))
  Require ($listeners.Count -eq 1) ('Expected one Consilium listener on 17484; found '+$listeners.Count)
  $parts=([string]$listeners[0]).Split('|')
  Require ($parts.Count -eq 2 -and $parts[0] -ceq '127.0.0.1') 'Consilium listener must remain loopback-only'
  $pidValue=0
  Require ([int]::TryParse($parts[1],[ref]$pidValue) -and $pidValue -gt 0) 'Consilium listener PID invalid'
  $process=[Diagnostics.Process]::GetProcessById($pidValue)
  try{
    $identity=Get-BridgeHandleIdentity $process
    Require ((FullPath ([string]$identity.workingDirectory)) -ieq (FullPath $consiliumRoot)) '17484 is not owned by the pinned Consilium working directory'
    Require ((FullPath ([string]$identity.bridgeHome)) -ieq (FullPath $consiliumStateRoot)) '17484 is not owned by the pinned Consilium StateRoot'
    Require ([string]$identity.bridgePort -ceq '17484') 'Consilium CHROME_BRIDGE_PORT changed'
    Require ([string]$identity.extensionId -ceq $consiliumExtensionId) 'Consilium extension ID changed'
    return [pscustomobject]@{Pid=$pidValue;Identity=$identity}
  }finally{$process.Dispose()}
}
function AssertChromeExtensionMapping {
  $chromeRoot=Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  Require (Test-Path -LiteralPath $chromeRoot -PathType Container) 'Chrome User Data root missing'
  $profiles=@('Default')+@((Get-ChildItem -LiteralPath $chromeRoot -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object {$_.Name -match '^Profile \d+$'}|ForEach-Object {$_.Name}))
  $found=$false
  foreach($profile in $profiles){
    $preferencesPath=Join-Path (Join-Path $chromeRoot $profile) 'Secure Preferences'
    if(!(Test-Path -LiteralPath $preferencesPath -PathType Leaf)){continue}
    try{
      $preferences=Get-Content -LiteralPath $preferencesPath -Raw -Encoding UTF8|ConvertFrom-Json
      $entry=$preferences.extensions.settings.PSObject.Properties[$labExtensionId]
      if($entry -and (FullPath ([string]$entry.Value.path)) -ieq (FullPath $labExtensionRoot)){$found=$true}
    }catch{}
  }
  Require $found 'PR102 extension ID is not mapped to the expected existing unpacked extension directory'
}
function AssertRegistryManifest {
  $manifestPath=Join-Path $labExtensionRoot 'manifest.json'
  Require (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'PR102 extension manifest missing'
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
  Require ([int]$manifest.manifest_version -eq 3) 'PR102 extension must remain MV3'
  Require ([string]$manifest.background.service_worker -ceq 'background.js') 'PR102 service worker entry mismatch'
  Require ([string]$manifest.background.type -ceq 'module') 'PR102 service worker must remain module'
  $hosts=@($manifest.host_permissions)
  Require ($hosts -contains 'http://127.0.0.1:17484/*') 'Existing PR102 extension must be pinned to its current 17484 endpoint before staging'
  $unexpected=@($hosts|Where-Object {$_ -match '^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/\*$' -and $_ -cne 'http://127.0.0.1:17484/*'})
  Require ($unexpected.Count -eq 0) 'Unexpected additional loopback host permission on PR102 extension'
  foreach($name in @('control.js','connection-check.js','transport-engine.js')){
    $file=Join-Path $labExtensionRoot $name
    Require (Test-Path -LiteralPath $file -PathType Leaf) ('PR102 endpoint file missing: '+$name)
    $source=[IO.File]::ReadAllText($file)
    Require ($source.Contains('127.0.0.1:17484')) ('Existing PR102 endpoint not found in '+$name)
    Require (-not $source.Contains('127.0.0.1:17485')) ('PR102 extension appears partially migrated in '+$name)
    Require (-not $source.Contains('127.0.0.1:17381') -and -not $source.Contains('127.0.0.1:17382')) ('Production/tunnel endpoint found in '+$name)
  }
  return $manifest
}

# Gate 1: exact pinned candidate source and clean detached worktree.
Require (Test-Path -LiteralPath $candidateRoot -PathType Container) 'Pinned PR145 candidate worktree missing; run Refresh-PR132PinnedWorktree.ps1 first'
$remote=InvokeGit @('remote','get-url','origin')
$storedRemote=InvokeGit @('config','--local','--get','remote.origin.url')
Require ((RemoteIdentity $remote) -ceq $remoteExpected -and (RemoteIdentity $storedRemote) -ceq $remoteExpected) 'PR145 candidate remote identity mismatch'
$head=InvokeGit @('rev-parse','HEAD')
Require ($head -ceq $expectedSha) ('PR145 candidate HEAD mismatch: '+$head)
$mergeHead=InvokeGit @('rev-parse',$expectedMergeRef)
Require ($mergeHead -ceq $expectedSha) ('PR145 remote merge ref mismatch: '+$mergeHead)
$status=InvokeGit @('status','--porcelain=v1','--untracked-files=all')
Require ([string]::IsNullOrWhiteSpace($status)) 'PR145 candidate worktree is not clean'

$serverInputs=@('server','deployment/cutover-health.mjs','deployment/cutover-start.mjs','deployment/process-identity.ps1','deployment/verify-candidate-source.ps1','deployment/bootstrap-pr102-lab-server.ps1','deployment/upgrade-pr102-lab-server.ps1')
$extensionInputs=@('extension','deployment/verify-candidate-source.ps1','deployment/upgrade-pr102-lab.ps1')
$controlRoomInputs=@('consilium-control-room','deployment/verify-candidate-source.ps1')
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $serverInputs
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $extensionInputs
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $controlRoomInputs

# Gate 2: exact existing roots and current PR102 extension identity.
foreach($path in @($labServerRoot,$labExtensionRoot,$labStateRoot)){AssertNoReparse $path}
Require (Test-Path -LiteralPath (Join-Path $labServerRoot 'server\bridge.mjs') -PathType Leaf) 'Existing PR102 server entry missing'
Require (Test-Path -LiteralPath (Join-Path $labServerRoot 'server\tools.mjs') -PathType Leaf) 'Existing PR102 MCP registry missing'
AssertChromeExtensionMapping
$manifest=AssertRegistryManifest

$configPath=Join-Path $labStateRoot 'config.json'
Require (Test-Path -LiteralPath $configPath -PathType Leaf) 'Existing PR102 State config missing'
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
Require ($config.agentToken -is [string] -and $config.agentToken.Length -ge 32) 'PR102 agent token invalid'
Require ($config.browserToken -is [string] -and $config.browserToken.Length -ge 32) 'PR102 browser token invalid'
$configHash=HashFile $configPath
$serverTreeBefore=TreeHash (Join-Path $labServerRoot 'server')
$extensionManifestBefore=HashFile (Join-Path $labExtensionRoot 'manifest.json')
$extensionTreeBefore=TreeHash $labExtensionRoot
$extensionBackupRoot=Join-Path $labStateRoot 'backups'
$backupListBefore=@()
if(Test-Path -LiteralPath $extensionBackupRoot -PathType Container){
  $backupListBefore=@(Get-ChildItem -LiteralPath $extensionBackupRoot -Directory -Force|ForEach-Object {$_.Name}|Sort-Object)
}

# Gate 3: Consilium 17484 is independently pinned and is not the PR102 owner.
$consiliumBefore=GetConsiliumIdentity
$consiliumStart=[string]$consiliumBefore.Identity.created
$consiliumCommand=[string]$consiliumBefore.Identity.command
$productionBefore=@{}
foreach($port in $productionPorts){$productionBefore[[string]$port]=ListenerSignature $port}
$labPortBefore=ListenerSignature $labPort
Require ([string]::IsNullOrWhiteSpace($labPortBefore)) 'Port 17485 already has a listener; refusing any cutover'
$consiliumPortBefore=ListenerSignature $consiliumPort

# Pin Node.exe to the executable used by the known Consilium Node process.
$nodePath=FullPath ([string]$consiliumBefore.Identity.executable)
$nodePaths=@(Get-Command node.exe -CommandType Application -All -ErrorAction Stop|ForEach-Object {[string]$_.Source})
$script:NodeExe=Get-BridgePinnedExecutable $nodePath $nodePaths
$version=$null
$nodeVersionProcess=New-Object Diagnostics.ProcessStartInfo
$nodeVersionProcess.FileName=$script:NodeExe
$nodeVersionProcess.Arguments='--version'
$nodeVersionProcess.WorkingDirectory=$labServerRoot
$nodeVersionProcess.UseShellExecute=$false
$nodeVersionProcess.CreateNoWindow=$true
$nodeVersionProcess.RedirectStandardOutput=$true
$nodeVersionProcess.RedirectStandardError=$true
$versionProcess=New-Object Diagnostics.Process
$versionProcess.StartInfo=$nodeVersionProcess
try{
  Require ($versionProcess.Start()) 'Could not start pinned Node version probe'
  $versionOut=$versionProcess.StandardOutput.ReadToEndAsync()
  $versionErr=$versionProcess.StandardError.ReadToEndAsync()
  Require ($versionProcess.WaitForExit(10000)) 'Node version probe timed out'
  Require ($versionProcess.ExitCode -eq 0) ('Node version probe failed: '+$versionErr.GetAwaiter().GetResult())
  $version=$versionOut.GetAwaiter().GetResult().Trim()
}finally{$versionProcess.Dispose()}

# Gate 4: server and extension dry-runs. Neither invocation receives -Apply.
$bootstrap=Join-Path $candidateRoot 'deployment\bootstrap-pr102-lab-server.ps1'
$extensionUpdater=Join-Path $candidateRoot 'deployment\upgrade-pr102-lab.ps1'
$bootstrapOutput=@(& $bootstrap -LabRoot $labServerRoot -StateRoot $labStateRoot -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -NodeExe $script:NodeExe 2>&1)
$bootstrapText=[string]::Join([Environment]::NewLine,[string[]]@($bootstrapOutput|ForEach-Object {[string]$_}))
Require ($bootstrapText -match '\[DRY_RUN\] PR102 server candidate and 30-tool registry validated') ('PR102 server bootstrap dry-run failed: '+$bootstrapText)
$extensionOutput=@(& $extensionUpdater -LabRoot $labExtensionRoot -StateRoot $labStateRoot -CandidateRoot $candidateRoot -LabPort $labPort -ExpectedSourceSha $expectedSha -NodeExe $script:NodeExe 2>&1)
$extensionText=[string]::Join([Environment]::NewLine,[string[]]@($extensionOutput|ForEach-Object {[string]$_}))
Require ($extensionText -match '\[DRY_RUN\] No installed files changed') ('PR102 extension dry-run failed: '+$extensionText)

# Gate 5: assert byte-for-byte state, installed extension, server, service and listener stability.
Require ((HashFile $configPath) -ceq $configHash) 'PR102 State config changed during dry-run'
Require ((TreeHash (Join-Path $labServerRoot 'server')) -ceq $serverTreeBefore) 'PR102 installed server changed during dry-run'
Require ((HashFile (Join-Path $labExtensionRoot 'manifest.json')) -ceq $extensionManifestBefore) 'PR102 installed extension manifest changed during dry-run'
Require ((TreeHash $labExtensionRoot) -ceq $extensionTreeBefore) 'PR102 installed extension tree changed during dry-run'
$backupListAfter=@()
if(Test-Path -LiteralPath $extensionBackupRoot -PathType Container){
  $backupListAfter=@(Get-ChildItem -LiteralPath $extensionBackupRoot -Directory -Force|ForEach-Object {$_.Name}|Sort-Object)
}
Require ((@($backupListBefore)-join '|') -ceq (@($backupListAfter)-join '|')) 'PR102 backups changed during dry-run'
Require ((ListenerSignature $labPort) -ceq $labPortBefore) 'PR102 port 17485 changed during dry-run'
Require ((ListenerSignature $consiliumPort) -ceq $consiliumPortBefore) 'Consilium port 17484 changed during dry-run'
foreach($port in $productionPorts){
  Require ((ListenerSignature $port) -ceq $productionBefore[[string]$port]) ('Production listener changed on '+$port)
}
$consiliumAfter=GetConsiliumIdentity
Require ($consiliumAfter.Pid -eq $consiliumBefore.Pid) 'Consilium process PID changed during PR102 dry-run'
Require ([string]$consiliumAfter.Identity.created -ceq $consiliumStart) 'Consilium process epoch changed during PR102 dry-run'
Require ([string]$consiliumAfter.Identity.command -ceq $consiliumCommand) 'Consilium command line changed during PR102 dry-run'
Require ((HashFile $configPath) -ceq $configHash) 'PR102 State config changed after final Consilium verification'

[pscustomobject]@{
  Result='PR145_LAB_PREPARATION_READY'
  CandidateCommit=$expectedSha
  CandidateRemoteMergeRef=$expectedMergeRef
  CandidateRoot=$candidateRoot
  LabPort=$labPort
  LabExtensionId=$labExtensionId
  LabServerRoot=$labServerRoot
  LabExtensionRoot=$labExtensionRoot
  LabStateRoot=$labStateRoot
  LabStateConfigSha256=$configHash
  LabServerTreeSha256=$serverTreeBefore
  LabExtensionManifestSha256=$extensionManifestBefore
  LabExtensionTreeSha256=$extensionTreeBefore
  NodeExecutable=$script:NodeExe
  NodeVersion=$version
  ServerBootstrapDryRun='PASS'
  CompleteRegistry='30_UNIQUE_TOOLS_PROVIDER_REPLY_WAIT_PRESENT'
  ExtensionDryRun='PASS'
  ExtensionIdentity='PRESERVED_EXISTING_UNPACKED_PATH'
  ConsiliumPort=17484
  ConsiliumProcessId=$consiliumBefore.Pid
  ConsiliumUnchanged=$true
  ProductionListenersUnchanged=$true
  NoLocalFilesApplied=$true
  NoBridgeProcessesStopped=$true
  NoCredentialsChanged=$true
}|ConvertTo-Json -Depth 6
