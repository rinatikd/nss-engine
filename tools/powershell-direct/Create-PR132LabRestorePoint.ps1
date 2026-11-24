# Create a verified post-install PR132 Lab restore point.
# Read-only checks + copies only. Does not stop/restart services, edit config, or touch Production.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$expectedPid=3416
$expectedSourceSha='4696c1c0b8fc1c970a003413d267d666faf424a7'
$expectedConfigSha='cb3bc9bc5ff43559e36185ac130eed56828beac4f27634439476d95f8b33b61b'
$labServerRoot='C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20'
$labExtensionRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$stateRoot='C:\Engineering\ChromeBridge-PR102-17484-State'
$labPort=17484
$labExtensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'
$candidateRoot='C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\ChromeBridge-PR145-4696c1c0-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
. (Join-Path $candidateRoot 'deployment\process-identity.ps1')
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function FullPath([string]$Path){Get-BridgeCanonicalPath $Path}
function Get-TreeEntries([string]$Root){
  $base=FullPath $Root
  $items=@(Get-ChildItem -LiteralPath $base -Recurse -Force -ErrorAction Stop)
  $rows=@()
  foreach($item in $items){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('RESTORE_POINT_REPARSE_POINT_REFUSED: '+$item.FullName)}
    if($item.PSIsContainer){continue}
    $relative=$item.FullName.Substring($base.Length).TrimStart('\').Replace('\','/')
    $rows += [pscustomobject]@{Path=$relative;Length=[long]$item.Length;Sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  return @($rows|Sort-Object Path)
}
function Get-TreeDigest($Entries){
  $text=[string]::Join('|',@($Entries|ForEach-Object {$_.Path+':'+$_.Length+':'+$_.Sha256}))
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-','').ToLowerInvariant())}
  finally{$sha.Dispose()}
}
Require (Test-Path -LiteralPath $labServerRoot -PathType Container) 'LAB_SERVER_ROOT_MISSING'
Require (Test-Path -LiteralPath (Join-Path $labServerRoot 'server\bridge.mjs') -PathType Leaf) 'LAB_SERVER_ENTRY_MISSING'
Require (Test-Path -LiteralPath (Join-Path $labServerRoot 'server\tools.mjs') -PathType Leaf) 'LAB_TOOLS_REGISTRY_MISSING'
Require (Test-Path -LiteralPath $labExtensionRoot -PathType Container) 'LAB_EXTENSION_ROOT_MISSING'
Require (Test-Path -LiteralPath (Join-Path $labExtensionRoot 'manifest.json') -PathType Leaf) 'LAB_EXTENSION_MANIFEST_MISSING'
Require (Test-Path -LiteralPath (Join-Path $stateRoot 'config.json') -PathType Leaf) 'LAB_STATE_CONFIG_MISSING'
$configHash=(Get-FileHash -LiteralPath (Join-Path $stateRoot 'config.json') -Algorithm SHA256).Hash.ToLowerInvariant()
Require ($configHash -ceq $expectedConfigSha) 'LAB_CONFIG_HASH_CHANGED_SINCE_PREFLIGHT'
$listeners=@([BridgeNativeMetadata]::Listeners($labPort))
Require ($listeners.Count -eq 1) ('LAB_LISTENER_COUNT_MISMATCH: '+$listeners.Count)
Require ([string]$listeners[0] -ceq ('127.0.0.1|'+$expectedPid)) ('LAB_LISTENER_OWNER_MISMATCH: '+[string]::Join(';',$listeners))
$proc=[Diagnostics.Process]::GetProcessById($expectedPid)
try{
  $identity=Get-BridgeHandleIdentity $proc
  Require ($identity.executable -match '(?i)\\node\.exe$') 'LAB_PROCESS_NOT_NODE'
  Require ((FullPath ([string]$identity.workingDirectory)) -ieq (FullPath $labServerRoot)) 'LAB_PROCESS_WORKDIR_MISMATCH'
  Require ((FullPath ([string]$identity.bridgeHome)) -ieq (FullPath $stateRoot)) 'LAB_PROCESS_STATE_ROOT_MISMATCH'
  Require ([string]$identity.bridgePort -ceq [string]$labPort) 'LAB_PROCESS_PORT_MISMATCH'
  Require ([string]$identity.extensionId -ceq $labExtensionId) 'LAB_PROCESS_EXTENSION_ID_MISMATCH'
  $command=([string]$identity.command).Replace('/','\').Trim()
  $direct=$command -match '(?i)server\\bridge\.mjs$'
  $launcher=$command -match '(?i)cutover-start\.mjs"\s+".*\\start-[0-9a-f]{32}\.json"$'
  Require ($direct -or $launcher) 'LAB_PROCESS_COMMAND_NOT_RECOGNIZED'
  if($launcher){
    $m=[regex]::Match($command,'(?i)^"(?<exe>[^"]+)"\s+"(?<script>[^"]+\\cutover-start\.mjs)"\s+"(?<job>[^"]+\\start-[0-9a-f]{32}\.json)"$')
    Require ($m.Success) 'LAB_TRANSACTION_LAUNCHER_PARSE_FAILED'
    $scriptPath=FullPath $m.Groups['script'].Value
    $jobPath=FullPath $m.Groups['job'].Value
    Require ($scriptPath.StartsWith((FullPath $labServerRoot)+'\',[StringComparison]::OrdinalIgnoreCase)) 'LAB_TRANSACTION_SCRIPT_OUTSIDE_ROOT'
    Require ($jobPath.StartsWith((FullPath $labServerRoot)+'\',[StringComparison]::OrdinalIgnoreCase)) 'LAB_TRANSACTION_JOB_OUTSIDE_ROOT'
    Require (Test-Path -LiteralPath $scriptPath -PathType Leaf) 'LAB_TRANSACTION_SCRIPT_MISSING'
    Require (Test-Path -LiteralPath $jobPath -PathType Leaf) 'LAB_TRANSACTION_JOB_MISSING'
    $job=Get-Content -LiteralPath $jobPath -Raw -Encoding UTF8|ConvertFrom-Json
    Require ((FullPath ([string]$job.source)) -ieq (FullPath $labServerRoot)) 'LAB_TRANSACTION_SOURCE_MISMATCH'
    Require ((FullPath ([string]$job.state)) -ieq (FullPath $stateRoot)) 'LAB_TRANSACTION_STATE_MISMATCH'
    Require ([int]$job.port -eq $labPort) 'LAB_TRANSACTION_PORT_MISMATCH'
    Require ([string]$job.configHash -ceq $configHash) 'LAB_TRANSACTION_CONFIG_HASH_MISMATCH'
  }
  $processCreatedUtc=[string]$identity.created
}finally{$proc.Dispose()}
$manifest=Get-Content -LiteralPath (Join-Path $labExtensionRoot 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
Require ([int]$manifest.manifest_version -eq 3) 'LAB_EXTENSION_NOT_MV3'
Require ([string]$manifest.background.type -ceq 'module') 'LAB_EXTENSION_BACKGROUND_TYPE_MISMATCH'
Require (@($manifest.host_permissions) -contains 'http://127.0.0.1:17484/*') 'LAB_EXTENSION_LAB_PERMISSION_MISSING'
foreach($name in @('control.js','connection-check.js','transport-engine.js')){
  $file=Join-Path $labExtensionRoot $name
  Require (Test-Path -LiteralPath $file -PathType Leaf) ('LAB_EXTENSION_FILE_MISSING: '+$name)
  $source=[IO.File]::ReadAllText($file)
  Require ($source.Contains('127.0.0.1:17484')) ('LAB_EXTENSION_LAB_ENDPOINT_MISSING: '+$name)
  Require (-not $source.Contains('127.0.0.1:17381') -and -not $source.Contains('127.0.0.1:17382')) ('PRODUCTION_ENDPOINT_FOUND_IN_EXTENSION: '+$name)
}
$serverSource=Join-Path $labServerRoot 'server'
$extensionSource=$labExtensionRoot
$serverBefore=Get-TreeEntries $serverSource
$extensionBefore=Get-TreeEntries $extensionSource
Require ($serverBefore.Count -gt 0 -and $extensionBefore.Count -gt 0) 'RESTORE_POINT_SOURCE_EMPTY'
$restoreRoot=Join-Path $stateRoot 'restore-points'
New-Item -ItemType Directory -Path $restoreRoot -Force|Out-Null
$stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$id='PR132-RC1-'+$stamp+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$pending=Join-Path $restoreRoot ('.pending-'+$id)
$final=Join-Path $restoreRoot $id
Require (-not (Test-Path -LiteralPath $final)) 'RESTORE_POINT_DESTINATION_EXISTS'
New-Item -ItemType Directory -Path $pending -Force|Out-Null
try{
  New-Item -ItemType Directory -Path (Join-Path $pending 'server') -Force|Out-Null
  New-Item -ItemType Directory -Path (Join-Path $pending 'extension') -Force|Out-Null
  Get-ChildItem -LiteralPath $serverSource -Force|Copy-Item -Destination (Join-Path $pending 'server') -Recurse -Force -ErrorAction Stop
  Get-ChildItem -LiteralPath $extensionSource -Force|Copy-Item -Destination (Join-Path $pending 'extension') -Recurse -Force -ErrorAction Stop
  $serverAfter=Get-TreeEntries $serverSource
  $extensionAfter=Get-TreeEntries $extensionSource
  $serverSnapshot=Get-TreeEntries (Join-Path $pending 'server')
  $extensionSnapshot=Get-TreeEntries (Join-Path $pending 'extension')
  Require ((Get-TreeDigest $serverBefore) -ceq (Get-TreeDigest $serverAfter)) 'LAB_SERVER_CHANGED_DURING_SNAPSHOT'
  Require ((Get-TreeDigest $extensionBefore) -ceq (Get-TreeDigest $extensionAfter)) 'LAB_EXTENSION_CHANGED_DURING_SNAPSHOT'
  Require ((Get-TreeDigest $serverBefore) -ceq (Get-TreeDigest $serverSnapshot)) 'SERVER_SNAPSHOT_HASH_MISMATCH'
  Require ((Get-TreeDigest $extensionBefore) -ceq (Get-TreeDigest $extensionSnapshot)) 'EXTENSION_SNAPSHOT_HASH_MISMATCH'
  $files=@()
  foreach($entry in $serverSnapshot){$files += [pscustomobject]@{Component='server';Path=$entry.Path;Length=$entry.Length;Sha256=$entry.Sha256}}
  foreach($entry in $extensionSnapshot){$files += [pscustomobject]@{Component='extension';Path=$entry.Path;Length=$entry.Length;Sha256=$entry.Sha256}}
  $checksums=[pscustomobject]@{Algorithm='SHA256';FileCount=$files.Count;Files=$files}
  $utf8=New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $pending 'checksums.json'),($checksums|ConvertTo-Json -Depth 8)+[Environment]::NewLine,$utf8)
  $point=[pscustomobject]@{
    Result='PR132_LAB_RESTORE_POINT_CREATED'
    RestorePointId=$id
    CreatedUtc=(Get-Date).ToUniversalTime().ToString('o')
    SourceCommit=$expectedSourceSha
    ProcessId=$expectedPid
    ProcessCreatedUtc=$processCreatedUtc
    ProcessExecutable=[string]$identity.executable
    ProcessCommandKind=if($direct){'direct-server-entry'}else{'transaction-launcher'}
    ServerRoot=$labServerRoot
    ExtensionRoot=$labExtensionRoot
    StateRoot=$stateRoot
    Port=$labPort
    ExtensionId=$labExtensionId
    ConfigSha256=$configHash
    ServerTreeSha256=(Get-TreeDigest $serverSnapshot)
    ExtensionTreeSha256=(Get-TreeDigest $extensionSnapshot)
    ServerFileCount=$serverSnapshot.Count
    ExtensionFileCount=$extensionSnapshot.Count
    TotalFileCount=$files.Count
    IncludesCredentials=$false
    IncludesLabConfig=$false
    ProductionChanged=$false
    ChecksumsFile='checksums.json'
  }
  [IO.File]::WriteAllText((Join-Path $pending 'restore-point.json'),($point|ConvertTo-Json -Depth 8)+[Environment]::NewLine,$utf8)
  $manifestHash=(Get-FileHash -LiteralPath (Join-Path $pending 'restore-point.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $pending 'restore-point.sha256'),$manifestHash+[Environment]::NewLine,$utf8)
  Move-Item -LiteralPath $pending -Destination $final
  [pscustomobject]@{
    Result='PR132_LAB_RESTORE_POINT_CREATED'
    RestorePointId=$id
    RestorePointPath=$final
    ManifestSha256=$manifestHash
    ServerTreeSha256=$point.ServerTreeSha256
    ExtensionTreeSha256=$point.ExtensionTreeSha256
    ServerFileCount=$point.ServerFileCount
    ExtensionFileCount=$point.ExtensionFileCount
    TotalFileCount=$point.TotalFileCount
    SourceCommit=$expectedSourceSha
    LabProcessId=$expectedPid
    ProductionChanged=$false
    CredentialsIncluded=$false
  }|ConvertTo-Json -Depth 5
}catch{
  if(Test-Path -LiteralPath $pending -PathType Container){Remove-Item -LiteralPath $pending -Recurse -Force -ErrorAction SilentlyContinue}
  throw
}
