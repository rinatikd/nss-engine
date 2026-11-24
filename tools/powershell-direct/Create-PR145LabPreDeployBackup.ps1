# Pre-deployment PR145 snapshot of the existing PR102 Lab server and unpacked extension.
# Copies only the existing server payload and extension files. Does not copy State config,
# credential values, Chrome profile data, or touch any running process.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$candidateRoot=Join-Path $workspaceExpected 'work\ChromeBridge-PR145-754b8f5f-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
$expectedSourceSha='754b8f5f30663dab9cefcd87b47b51ecb4c0dcdd'
$labServerRoot='C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20'
$extensionRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$stateRoot='C:\Engineering\ChromeBridge-PR102-17484-State'
$extensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'
$configExpectedSha='cb3bc9bc5ff43559e36185ac130eed56828beac4f27634439476d95f8b33b61b'
$targetPort=17485
$consiliumPort=17484
$consiliumRoot='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0'
$consiliumStateRoot='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0-State'
$consiliumExtensionId='ojkfdjndmcpnphecoadbcnmlnadmmkah'
$productionPorts=@(17381,17382)
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
$identityScript=Join-Path $candidateRoot 'deployment\process-identity.ps1'
if(!(Test-Path -LiteralPath $identityScript -PathType Leaf)){throw 'PINNED_PROCESS_IDENTITY_HELPER_MISSING'}
. $identityScript

function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function FullPath([string]$Path){Get-BridgeCanonicalPath $Path}
function AssertRoot([string]$Path){
  Require (Test-Path -LiteralPath $Path -PathType Container) ('REQUIRED_ROOT_MISSING: '+$Path)
  Require (-not ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) ('ROOT_REPARSE_POINT_REFUSED: '+$Path)
}
function GetTreeEntries([string]$Root){
  $base=FullPath $Root
  $rows=@()
  foreach($item in Get-ChildItem -LiteralPath $base -Recurse -Force -ErrorAction Stop){
    Require (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) ('TREE_REPARSE_POINT_REFUSED: '+$item.FullName)
    if($item.PSIsContainer){continue}
    $relative=$item.FullName.Substring($base.Length).TrimStart('\').Replace('\','/')
    $rows += [pscustomobject]@{
      Path=$relative
      Length=[long]$item.Length
      Sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  return @($rows|Sort-Object Path)
}
function GetTreeDigest($Entries){
  $text=[string]::Join('|',@($Entries|ForEach-Object {$_.Path+':'+$_.Length+':'+$_.Sha256}))
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-','').ToLowerInvariant())}
  finally{$sha.Dispose()}
}
function ListenerSignature([int]$Port){
  return ((@([BridgeNativeMetadata]::Listeners($Port)|Sort-Object)) -join ';')
}
function GetPinnedConsilium {
  $listeners=@([BridgeNativeMetadata]::Listeners($consiliumPort))
  Require ($listeners.Count -eq 1) ('CONSILIUM_LISTENER_COUNT_MISMATCH: '+$listeners.Count)
  $parts=([string]$listeners[0]).Split('|')
  Require ($parts.Count -eq 2 -and $parts[0] -ceq '127.0.0.1') 'CONSILIUM_NOT_LOOPBACK'
  $pidValue=0
  Require ([int]::TryParse($parts[1],[ref]$pidValue) -and $pidValue -gt 0) 'CONSILIUM_PID_INVALID'
  $process=[Diagnostics.Process]::GetProcessById($pidValue)
  try{
    $identity=Get-BridgeHandleIdentity $process
    Require ((FullPath ([string]$identity.workingDirectory)) -ieq (FullPath $consiliumRoot)) 'CONSILIUM_WORKDIR_MISMATCH'
    Require ((FullPath ([string]$identity.bridgeHome)) -ieq (FullPath $consiliumStateRoot)) 'CONSILIUM_STATE_ROOT_MISMATCH'
    Require ([string]$identity.bridgePort -ceq [string]$consiliumPort) 'CONSILIUM_PORT_ENV_MISMATCH'
    Require ([string]$identity.extensionId -ceq $consiliumExtensionId) 'CONSILIUM_EXTENSION_ID_MISMATCH'
    return [pscustomobject]@{Pid=$pidValue;Created=[string]$identity.created;Command=[string]$identity.command}
  }finally{$process.Dispose()}
}
function AssertChromeMapping {
  $chromeRoot=Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  Require (Test-Path -LiteralPath $chromeRoot -PathType Container) 'CHROME_USER_DATA_MISSING'
  $profiles=@('Default')+@((Get-ChildItem -LiteralPath $chromeRoot -Directory -Force -ErrorAction SilentlyContinue|Where-Object {$_.Name -match '^Profile \d+$'}|ForEach-Object {$_.Name}))
  $found=$false
  foreach($profile in $profiles){
    $file=Join-Path (Join-Path $chromeRoot $profile) 'Secure Preferences'
    if(!(Test-Path -LiteralPath $file -PathType Leaf)){continue}
    try{
      $preferences=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
      $entry=$preferences.extensions.settings.PSObject.Properties[$extensionId]
      if($entry -and (FullPath ([string]$entry.Value.path)) -ieq (FullPath $extensionRoot)){$found=$true}
    }catch{}
  }
  Require $found 'PR102_CHROME_EXTENSION_MAPPING_MISMATCH'
}

# Pin all source and identity inputs before creating a backup.
foreach($path in @($labServerRoot,$extensionRoot,$stateRoot)){AssertRoot $path}
AssertRoot $candidateRoot
Require (Test-Path -LiteralPath (Join-Path $labServerRoot 'server\bridge.mjs') -PathType Leaf) 'LAB_SERVER_ENTRY_MISSING'
Require (Test-Path -LiteralPath (Join-Path $labServerRoot 'server\tools.mjs') -PathType Leaf) 'LAB_TOOLS_REGISTRY_MISSING'
Require (Test-Path -LiteralPath (Join-Path $candidateRoot 'deployment\process-identity.ps1') -PathType Leaf) 'CANDIDATE_IDENTITY_HELPER_MISSING'
$configPath=Join-Path $stateRoot 'config.json'
Require (Test-Path -LiteralPath $configPath -PathType Leaf) 'LAB_STATE_CONFIG_MISSING'
$configHash=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
Require ($configHash -ceq $configExpectedSha) 'LAB_STATE_CONFIG_HASH_CHANGED'
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
Require ($config.agentToken -is [string] -and $config.agentToken.Length -ge 32) 'LAB_AGENT_TOKEN_INVALID'
Require ($config.browserToken -is [string] -and $config.browserToken.Length -ge 32) 'LAB_BROWSER_TOKEN_INVALID'

$manifestPath=Join-Path $extensionRoot 'manifest.json'
Require (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'LAB_EXTENSION_MANIFEST_MISSING'
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
Require ([int]$manifest.manifest_version -eq 3) 'LAB_EXTENSION_NOT_MV3'
Require ([string]$manifest.background.type -ceq 'module') 'LAB_EXTENSION_BACKGROUND_TYPE_MISMATCH'
Require (@($manifest.host_permissions) -contains 'http://127.0.0.1:17484/*') 'LAB_EXTENSION_NOT_IN_EXPECTED_PREDEPLOY_STATE'
foreach($name in @('control.js','connection-check.js','transport-engine.js')){
  $file=Join-Path $extensionRoot $name
  Require (Test-Path -LiteralPath $file -PathType Leaf) ('LAB_EXTENSION_FILE_MISSING: '+$name)
  $source=[IO.File]::ReadAllText($file)
  Require ($source.Contains('127.0.0.1:17484')) ('LAB_EXTENSION_17484_ENDPOINT_MISSING: '+$name)
  Require (-not $source.Contains('127.0.0.1:17485')) ('LAB_EXTENSION_ALREADY_PARTIALLY_MIGRATED: '+$name)
  Require (-not $source.Contains('127.0.0.1:17381') -and -not $source.Contains('127.0.0.1:17382')) ('PRODUCTION_ENDPOINT_FOUND: '+$name)
}
AssertChromeMapping

$consiliumBefore=GetPinnedConsilium
$consiliumListenerBefore=ListenerSignature $consiliumPort
$productionBefore=@{}
foreach($port in $productionPorts){$productionBefore[[string]$port]=ListenerSignature $port}
$targetListenerBefore=ListenerSignature $targetPort
Require ([string]::IsNullOrWhiteSpace($targetListenerBefore)) 'TARGET_PORT_17485_NOT_FREE'
$serverSource=Join-Path $labServerRoot 'server'
$serverBefore=GetTreeEntries $serverSource
$extensionBefore=GetTreeEntries $extensionRoot
Require ($serverBefore.Count -gt 0 -and $extensionBefore.Count -gt 0) 'BACKUP_SOURCE_EMPTY'
$serverDigest=GetTreeDigest $serverBefore
$extensionDigest=GetTreeDigest $extensionBefore
$restoreRoot=Join-Path $stateRoot 'restore-points'
if(Test-Path -LiteralPath $restoreRoot -PathType Container){
  Require (-not ((Get-Item -LiteralPath $restoreRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'RESTORE_ROOT_REPARSE_POINT_REFUSED'
}else{
  New-Item -ItemType Directory -Path $restoreRoot -Force|Out-Null
}
$stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$id='PR145-PREDEPLOY-'+$stamp+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$pending=Join-Path $restoreRoot ('.pending-'+$id)
$final=Join-Path $restoreRoot $id
Require (-not (Test-Path -LiteralPath $final)) 'BACKUP_DESTINATION_ALREADY_EXISTS'
New-Item -ItemType Directory -Path $pending -Force|Out-Null
try{
  New-Item -ItemType Directory -Path (Join-Path $pending 'server') -Force|Out-Null
  New-Item -ItemType Directory -Path (Join-Path $pending 'extension') -Force|Out-Null
  Get-ChildItem -LiteralPath $serverSource -Force|Copy-Item -Destination (Join-Path $pending 'server') -Recurse -Force -ErrorAction Stop
  Get-ChildItem -LiteralPath $extensionRoot -Force|Copy-Item -Destination (Join-Path $pending 'extension') -Recurse -Force -ErrorAction Stop
  $serverAfter=GetTreeEntries $serverSource
  $extensionAfter=GetTreeEntries $extensionRoot
  $serverSnapshot=GetTreeEntries (Join-Path $pending 'server')
  $extensionSnapshot=GetTreeEntries (Join-Path $pending 'extension')
  Require ((GetTreeDigest $serverBefore) -ceq (GetTreeDigest $serverAfter)) 'LAB_SERVER_CHANGED_DURING_BACKUP'
  Require ((GetTreeDigest $extensionBefore) -ceq (GetTreeDigest $extensionAfter)) 'LAB_EXTENSION_CHANGED_DURING_BACKUP'
  Require ((GetTreeDigest $serverBefore) -ceq (GetTreeDigest $serverSnapshot)) 'SERVER_BACKUP_HASH_MISMATCH'
  Require ((GetTreeDigest $extensionBefore) -ceq (GetTreeDigest $extensionSnapshot)) 'EXTENSION_BACKUP_HASH_MISMATCH'
  Require ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $configHash) 'LAB_CONFIG_CHANGED_DURING_BACKUP'
  Require ((ListenerSignature $targetPort) -ceq $targetListenerBefore) 'TARGET_PORT_CHANGED_DURING_BACKUP'
  Require ((ListenerSignature $consiliumPort) -ceq $consiliumListenerBefore) 'CONSILIUM_LISTENER_CHANGED_DURING_BACKUP'
  foreach($port in $productionPorts){Require ((ListenerSignature $port) -ceq $productionBefore[[string]$port]) ('PRODUCTION_LISTENER_CHANGED: '+$port)}
  $consiliumAfter=GetPinnedConsilium
  Require ($consiliumAfter.Pid -eq $consiliumBefore.Pid) 'CONSILIUM_PID_CHANGED_DURING_BACKUP'
  Require ($consiliumAfter.Created -ceq $consiliumBefore.Created) 'CONSILIUM_PROCESS_EPOCH_CHANGED_DURING_BACKUP'
  Require ($consiliumAfter.Command -ceq $consiliumBefore.Command) 'CONSILIUM_COMMAND_CHANGED_DURING_BACKUP'

  $files=@()
  foreach($entry in $serverSnapshot){$files += [pscustomobject]@{Component='server';Path=$entry.Path;Length=$entry.Length;Sha256=$entry.Sha256}}
  foreach($entry in $extensionSnapshot){$files += [pscustomobject]@{Component='extension';Path=$entry.Path;Length=$entry.Length;Sha256=$entry.Sha256}}
  $checksums=[pscustomobject]@{Algorithm='SHA256';FileCount=$files.Count;Files=$files}
  $utf8=New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $pending 'checksums.json'),($checksums|ConvertTo-Json -Depth 8)+[Environment]::NewLine,$utf8)
  $point=[pscustomobject]@{
    Result='PR145_LAB_PREDEPLOY_BACKUP_CREATED'
    BackupId=$id
    CreatedUtc=(Get-Date).ToUniversalTime().ToString('o')
    CandidateSourceCommit=$expectedSourceSha
    LabServerRoot=$labServerRoot
    LabServerPayload='server'
    LabExtensionRoot=$extensionRoot
    LabStateRoot=$stateRoot
    LabPort=$targetPort
    LabExtensionId=$extensionId
    ConfigSha256=$configHash
    ServerTreeSha256=$serverDigest
    ExtensionTreeSha256=$extensionDigest
    ServerFileCount=$serverSnapshot.Count
    ExtensionFileCount=$extensionSnapshot.Count
    TotalFileCount=$files.Count
    ConsiliumPort=$consiliumPort
    ConsiliumProcessId=$consiliumBefore.Pid
    ProductionPortsUnchanged=$true
    IncludesCredentials=$false
    IncludesLabConfig=$false
    ChromeProfileDataIncluded=$false
    ChecksumsFile='checksums.json'
  }
  [IO.File]::WriteAllText((Join-Path $pending 'backup-manifest.json'),($point|ConvertTo-Json -Depth 8)+[Environment]::NewLine,$utf8)
  $manifestHash=(Get-FileHash -LiteralPath (Join-Path $pending 'backup-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $pending 'backup-manifest.sha256'),$manifestHash+[Environment]::NewLine,$utf8)
  Move-Item -LiteralPath $pending -Destination $final
  [pscustomobject]@{
    Result='PR145_LAB_PREDEPLOY_BACKUP_CREATED'
    BackupId=$id
    BackupPath=$final
    ManifestSha256=$manifestHash
    ServerTreeSha256=$serverDigest
    ExtensionTreeSha256=$extensionDigest
    ServerFileCount=$serverSnapshot.Count
    ExtensionFileCount=$extensionSnapshot.Count
    TotalFileCount=$files.Count
    CandidateSourceCommit=$expectedSourceSha
    LabConfigSha256=$configHash
    ConsiliumProcessId=$consiliumBefore.Pid
    ConsiliumUnchanged=$true
    ProductionListenersUnchanged=$true
    IncludesCredentials=$false
    IncludesLabConfig=$false
  }|ConvertTo-Json -Depth 5
}catch{
  if(Test-Path -LiteralPath $pending -PathType Container){Remove-Item -LiteralPath $pending -Recurse -Force -ErrorAction SilentlyContinue}
  throw
}
