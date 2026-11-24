# Read-only identity and installation diagnostics for the independent Consilium Lab on 17484.
# Does not print credential values, change files, reload Chrome, or stop/start any process.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$candidateRoot=Join-Path $workspaceExpected 'work\ChromeBridge-PR145-754b8f5f-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
$consiliumRoot='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0'
$stateRoot='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0-State'
$port=17484
$extensionId='ojkfdjndmcpnphecoadbcnmlnadmmkah'
$pr102Root='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$pr102Id='nhflbnfcaicihaepdcjacdmaddagcmcj'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
$identityScript=Join-Path $candidateRoot 'deployment\process-identity.ps1'
if(!(Test-Path -LiteralPath $identityScript -PathType Leaf)){throw 'PINNED_PROCESS_IDENTITY_HELPER_MISSING'}
. $identityScript

function FullPath([string]$Value){Get-BridgeCanonicalPath $Value}
function Exists([string]$Path){Test-Path -LiteralPath $Path}
function Reparse([string]$Path){
  if(!(Exists $Path)){return $false}
  return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}
function HashFile([string]$Path){
  if(!(Test-Path -LiteralPath $Path -PathType Leaf)){return ''}
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function ListenerRows([int]$Port){
  $rows=@()
  foreach($item in @([BridgeNativeMetadata]::Listeners($Port))){
    $parts=([string]$item).Split('|')
    $rows += [pscustomobject]@{Raw=[string]$item;Address=if($parts.Count -gt 0){$parts[0]}else{''};ProcessId=if($parts.Count -gt 1){$parts[1]}else{''}}
  }
  return @($rows)
}
function GetChromeMappings {
  $output=@()
  $chromeRoot=Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  if(!(Test-Path -LiteralPath $chromeRoot -PathType Container)){return $output}
  $profiles=@('Default')+@((Get-ChildItem -LiteralPath $chromeRoot -Directory -Force -ErrorAction SilentlyContinue|Where-Object {$_.Name -match '^Profile \d+$'}|ForEach-Object {$_.Name}))
  foreach($profile in $profiles){
    $file=Join-Path (Join-Path $chromeRoot $profile) 'Secure Preferences'
    if(!(Test-Path -LiteralPath $file -PathType Leaf)){continue}
    try{
      $preferences=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
      foreach($id in @($extensionId,$pr102Id)){
        $entry=$preferences.extensions.settings.PSObject.Properties[$id]
        if(!$entry){continue}
        $mapped=[string]$entry.Value.path
        $expected=if($id -ceq $extensionId){$consiliumRoot}else{$pr102Root}
        $output += [pscustomobject]@{
          Profile=$profile
          ExtensionId=$id
          Path=$mapped
          ExpectedPath=$expected
          PathMatches=((FullPath $mapped) -ieq (FullPath $expected))
          State=if($entry.Value.PSObject.Properties['state']){[int]$entry.Value.state}else{$null}
        }
      }
    }catch{}
  }
  return @($output)
}

$listeners=@(ListenerRows $port)
if($listeners.Count -ne 1){throw ('CONSILIUM_LISTENER_COUNT_MISMATCH: '+$listeners.Count)}
$parts=([string]$listeners[0].Raw).Split('|')
if($parts.Count -ne 2 -or $parts[0] -cne '127.0.0.1'){throw 'CONSILIUM_LISTENER_NOT_LOOPBACK'}
$pidValue=0
if(-not [int]::TryParse($parts[1],[ref]$pidValue) -or $pidValue -le 0){throw 'CONSILIUM_PID_INVALID'}
$process=[Diagnostics.Process]::GetProcessById($pidValue)
try{
  $identity=Get-BridgeHandleIdentity $process
  $processName=$process.ProcessName
}finally{$process.Dispose()}

$manifestPath=Join-Path $consiliumRoot 'manifest.json'
$manifest=$null
if(Exists $manifestPath){$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json}
$configPath=Join-Path $stateRoot 'config.json'
$configHash=HashFile $configPath
$configValid=$false
$agentTokenLength=0
$browserTokenLength=0
if(Exists $configPath){
  $config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
  $configValid=($config.agentToken -is [string] -and $config.agentToken.Length -ge 32 -and $config.browserToken -is [string] -and $config.browserToken.Length -ge 32)
  if($config.agentToken -is [string]){$agentTokenLength=$config.agentToken.Length}
  if($config.browserToken -is [string]){$browserTokenLength=$config.browserToken.Length}
}

$topFiles=@()
if(Test-Path -LiteralPath $consiliumRoot -PathType Container){
  $topFiles=@(Get-ChildItem -LiteralPath $consiliumRoot -Force|ForEach-Object {
    [pscustomobject]@{Name=$_.Name;Directory=$_.PSIsContainer;Length=if($_.PSIsContainer){$null}else{[long]$_.Length};LastWriteUtc=$_.LastWriteTimeUtc.ToString('o')}
  })
}
$stateEntries=@()
if(Test-Path -LiteralPath $stateRoot -PathType Container){
  $stateEntries=@(Get-ChildItem -LiteralPath $stateRoot -Force|ForEach-Object {
    [pscustomobject]@{Name=$_.Name;Directory=$_.PSIsContainer;Length=if($_.PSIsContainer){$null}else{[long]$_.Length};LastWriteUtc=$_.LastWriteTimeUtc.ToString('o')}
  })
}
$endpointFiles=@()
foreach($name in @('control.js','connection-check.js','transport-engine.js')){
  $file=Join-Path $consiliumRoot $name
  if(Exists $file){
    $source=[IO.File]::ReadAllText($file)
    $endpointFiles += [pscustomobject]@{
      File=$name
      Has17484=$source.Contains('127.0.0.1:17484')
      Has17485=$source.Contains('127.0.0.1:17485')
      Has17381=$source.Contains('127.0.0.1:17381')
      Has17382=$source.Contains('127.0.0.1:17382')
      Sha256=(HashFile $file)
    }
  }
}

$summary=[ordered]@{
  Result='CONSILIUM_17484_RUNTIME_READ_ONLY'
  ListenerAddress=$parts[0]
  ListenerPort=$port
  ProcessId=$pidValue
  ProcessName=$processName
  Executable=[string]$identity.executable
  ProcessCreatedUtc=[string]$identity.created
  CommandKind='redacted'
  CommandEntryPoint=if(([string]$identity.command) -match '(?i)"(?<entry>[^"]+\.mjs)"'){$Matches.entry}else{''}
  WorkingDirectory=[string]$identity.workingDirectory
  WorkingDirectoryMatches=((FullPath ([string]$identity.workingDirectory)) -ieq (FullPath $consiliumRoot))
  BridgeHome=[string]$identity.bridgeHome
  StateRootMatches=((FullPath ([string]$identity.bridgeHome)) -ieq (FullPath $stateRoot))
  BridgePortEnvironment=[string]$identity.bridgePort
  ExtensionIdEnvironment=[string]$identity.extensionId
  ExtensionIdMatches=([string]$identity.extensionId -ceq $extensionId)
  ExtensionRoot=$consiliumRoot
  ExtensionRootExists=(Exists $consiliumRoot)
  ExtensionRootReparse=(Reparse $consiliumRoot)
  ManifestExists=(Exists $manifestPath)
  ManifestSha256=(HashFile $manifestPath)
  ManifestVersion=if($manifest){[int]$manifest.manifest_version}else{$null}
  ManifestBackgroundType=if($manifest -and $manifest.background.PSObject.Properties['type']){[string]$manifest.background.type}else{''}
  ManifestHostPermissions=if($manifest){@($manifest.host_permissions)}else{@()}
  ManifestContainsKey=[bool]($manifest -and $manifest.PSObject.Properties['key'])
  StateRoot=$stateRoot
  StateRootExists=(Exists $stateRoot)
  StateRootReparse=(Reparse $stateRoot)
  StateConfigExists=(Exists $configPath)
  StateConfigValid=$configValid
  StateConfigSha256=$configHash
  AgentTokenLength=$agentTokenLength
  BrowserTokenLength=$browserTokenLength
  ChromeExtensionMappings=(GetChromeMappings)
  EndpointFiles=$endpointFiles
  ServerEntryExists=(Exists (Join-Path $consiliumRoot 'server\bridge.mjs'))
  ServerRegistryExists=(Exists (Join-Path $consiliumRoot 'server\tools.mjs'))
  TopLevelFiles=$topFiles
  StateTopLevelEntries=$stateEntries
  Port17381Listeners=(ListenerRows 17381)
  Port17382Listeners=(ListenerRows 17382)
  Port17484Listeners=$listeners
  Port17485Listeners=(ListenerRows 17485)
}
$summary|ConvertTo-Json -Depth 7
