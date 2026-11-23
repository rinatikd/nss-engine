# One approved PR132 Lab release transaction.
# Runs the consolidated read-only preflight, applies server then extension,
# and automatically rolls back in reverse order if extension installation fails.
# Production, tunnels and provider messaging are explicitly out of scope.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$preflightScript=Join-Path $PSScriptRoot 'Run-PR132LabPreflight.ps1'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $preflightScript -PathType Leaf)){throw 'CONSOLIDATED_PREFLIGHT_SCRIPT_MISSING'}

# Dot-source the same consolidated gate, retaining its verified paths,
# process identity, config hash and updater parameter sets in this scope.
$preflightOutput = . $preflightScript
$preflightJson = [string]$preflightOutput
$preflight = ConvertFrom-Json -InputObject $preflightJson
if($preflight.Result -cne 'PR132_LAB_PREFLIGHT_READY'){throw 'PR132_LAB_PREFLIGHT_NOT_READY'}
$manifestBeforeApply=Get-Content -LiteralPath (Join-Path $labExtensionRoot 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
$manifestKeyBefore=''
if($manifestBeforeApply.PSObject.Properties['key']){$manifestKeyBefore=[string]$manifestBeforeApply.key}


function FullPath([string]$Path){
  $full=[IO.Path]::GetFullPath($Path.Trim())
  $rootPath=[IO.Path]::GetPathRoot($full)
  while($full.Length -gt $rootPath.Length -and ($full.EndsWith('\') -or $full.EndsWith('/'))){
    $full=$full.Substring(0,$full.Length-1)
  }
  return $full
}
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function GetLiveIdentity([int]$ProcessId){
  $p=[Diagnostics.Process]::GetProcessById($ProcessId)
  try{
    $null=$p.Handle
    return (Get-BridgeHandleIdentity $p)
  }finally{$p.Dispose()}
}
function ListenerSignature([int]$Port){
  return ((@([BridgeNativeMetadata]::Listeners($Port) | Sort-Object)) -join ';')
}
function GetLabOwner {
  $items=@([BridgeNativeMetadata]::Listeners($labPort))
  Require ($items.Count -eq 1) 'Expected exactly one PR102 Lab listener after cutover'
  $parts=([string]$items[0]).Split('|')
  Require ($parts.Count -eq 2 -and $parts[0] -ceq '127.0.0.1') 'PR102 Lab listener is not loopback-only'
  $id=0
  Require ([int]::TryParse($parts[1],[ref]$id) -and $id -gt 0) 'PR102 Lab listener PID is invalid'
  return $id
}
function AssertLabOwner([int]$ProcessId){
  $identity=GetLiveIdentity $ProcessId
  Require ((FullPath ([string]$identity.executable)) -ieq (FullPath $nodeExe)) 'Post-cutover Node executable mismatch'
  Require ((FullPath ([string]$identity.workingDirectory)) -ieq (FullPath $labServerRoot)) 'Post-cutover server working directory mismatch'
  Require ((FullPath ([string]$identity.bridgeHome)) -ieq (FullPath $labStateRoot)) 'Post-cutover state root mismatch'
  Require ([string]$identity.bridgePort -ceq [string]$labPort) 'Post-cutover Lab port mismatch'
  Require ([string]$identity.extensionId -ceq $labExtensionId) 'Post-cutover extension ID mismatch'
  return $identity
}
function InvokeServerRollback([string]$BackupPath){
  $pidNow=GetLabOwner
  $identityNow=AssertLabOwner $pidNow
  $rollback=@{}
  foreach($key in $serverParams.Keys){$rollback[$key]=$serverParams[$key]}
  $rollback['ExpectedPid']=$pidNow
  $rollback['ExpectedStartUtc']=[DateTime]::Parse($identityNow.created).ToUniversalTime().ToString('o')
  $rollback['RollbackFrom']=$BackupPath
  $rollback['Apply']=$true
  $output=@(& $serverScript @rollback 2>&1)
  $text=[string]::Join([Environment]::NewLine,[string[]]@($output|ForEach-Object {[string]$_}))
  Require ($text -match '\[ROLLED_BACK\]') ('SERVER_ROLLBACK_NOT_CONFIRMED: '+$text)
  return $text
}
function InvokeExtensionRollback([string]$BackupPath){
  $rollback=@{}
  foreach($key in $extensionParams.Keys){$rollback[$key]=$extensionParams[$key]}
  $rollback['RollbackFrom']=$BackupPath
  $rollback['Apply']=$true
  $output=@(& $extensionScript @rollback 2>&1)
  $text=[string]::Join([Environment]::NewLine,[string[]]@($output|ForEach-Object {[string]$_}))
  Require ($text -match '\[RESTORED\]') ('EXTENSION_ROLLBACK_NOT_CONFIRMED: '+$text)
  return $text
}

# Values and strict guards are supplied by Run-PR132LabPreflight.ps1.
if($expectedSha -cne 'e59f3cd640a32868f78264eb85b6dbcdeff0b6fe'){throw 'UNEXPECTED_PR132_RELEASE_SHA'}
$initialPid=[int]$expectedPid
$initialIdentity=$identity
$stateBackupRoot=Join-Path $labStateRoot 'backups'
$extensionBackupsBefore=@()
$serverBackupsBefore=@()
if(Test-Path -LiteralPath $stateBackupRoot -PathType Container){
  $extensionBackupsBefore=@(Get-ChildItem -LiteralPath $stateBackupRoot -Directory -Filter 'extension-*' -ErrorAction SilentlyContinue | ForEach-Object {$_.FullName})
  $serverBackupsBefore=@(Get-ChildItem -LiteralPath $stateBackupRoot -Directory -Filter 'server-*' -ErrorAction SilentlyContinue | ForEach-Object {$_.FullName})
}

$serverBackup=$null
$extensionBackup=$null
$serverApplied=$false
$extensionApplied=$false
$serverApplyOutput=''
$extensionApplyOutput=''
$production17381Before=ListenerSignature 17381
$production17382Before=ListenerSignature 17382
if([string]::IsNullOrWhiteSpace($production17381Before)){throw 'PRODUCTION_17381_BASELINE_NOT_FOUND'}


try{
  # Server cutover: server updater performs PID fencing, backup, health/tools registry
  # verification and automatic rollback on any failed health assertion.
  $serverApply=@{}
  foreach($key in $serverParams.Keys){$serverApply[$key]=$serverParams[$key]}
  $serverApply['Apply']=$true
  $serverOutput=@(& $serverScript @serverApply 2>&1)
  $serverApplyOutput=[string]::Join([Environment]::NewLine,[string[]]@($serverOutput|ForEach-Object {[string]$_}))
  Require ($serverApplyOutput -match '\[UPGRADED\]') ('SERVER_UPGRADE_NOT_CONFIRMED: '+$serverApplyOutput)
  # From this point the new server is live. Mark it immediately so every later
  # assertion failure enters the rollback path.
  $serverApplied=$true
  $backupMatch=[regex]::Match($serverApplyOutput,'(?m)^\[BACKUP\]\s+(.+?)\s*$')
  if($backupMatch.Success){$serverBackup=FullPath $backupMatch.Groups[1].Value}
  if(-not $serverBackup -and (Test-Path -LiteralPath $stateBackupRoot -PathType Container)){
    $newServerBackups=@(Get-ChildItem -LiteralPath $stateBackupRoot -Directory -Filter 'server-*' -ErrorAction SilentlyContinue |
      Where-Object {$serverBackupsBefore -notcontains $_.FullName -and (Test-Path -LiteralPath (Join-Path $_.FullName 'server-backup.json') -PathType Leaf)})
    if($newServerBackups.Count -eq 1){$serverBackup=$newServerBackups[0].FullName}
  }
  Require ($serverBackup) 'SERVER_BACKUP_PATH_NOT_RECOVERABLE'
  Require ((FullPath $serverBackup).StartsWith((FullPath $stateBackupRoot)+'\',[StringComparison]::OrdinalIgnoreCase)) 'SERVER_BACKUP_OUTSIDE_LAB_STATE'
  Require (Test-Path -LiteralPath (Join-Path $serverBackup 'server-backup.json') -PathType Leaf) 'SERVER_BACKUP_MARKER_MISSING'

  # Confirm the new server is healthy and its environment still maps to this Lab only.
  $newPid=GetLabOwner
  $newIdentity=AssertLabOwner $newPid
  Require ([string]$newIdentity.created -cne [string]$initialIdentity.created -and [string]$newIdentity.command -cne [string]$initialIdentity.command) 'Server cutover did not replace the pinned process epoch'
  Require ((Get-FileHash -LiteralPath (Join-Path $labStateRoot 'config.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $configEvidence.ConfigSha256) 'Server cutover changed Lab credentials/config'

  # Extension cutover in the same approved transaction. Its backup lives in the
  # separate Lab state root; the installed extension directory itself stays fixed.
  $extensionApply=@{}
  foreach($key in $extensionParams.Keys){$extensionApply[$key]=$extensionParams[$key]}
  $extensionApply['Apply']=$true
  $extensionOutput=@(& $extensionScript @extensionApply 2>&1)
  $extensionApplyOutput=[string]::Join([Environment]::NewLine,[string[]]@($extensionOutput|ForEach-Object {[string]$_}))
  Require ($extensionApplyOutput -match '\[INSTALLED\]') ('EXTENSION_INSTALL_NOT_CONFIRMED: '+$extensionApplyOutput)
  $extensionBackupMatch=[regex]::Match($extensionApplyOutput,'(?m)^\[INSTALLED\].*Backup:\s*(.+?)\s*$')
  Require ($extensionBackupMatch.Success) 'EXTENSION_BACKUP_PATH_NOT_REPORTED'
  $extensionBackup=FullPath $extensionBackupMatch.Groups[1].Value
  Require ((FullPath $extensionBackup).StartsWith((FullPath $stateBackupRoot)+'\',[StringComparison]::OrdinalIgnoreCase)) 'EXTENSION_BACKUP_OUTSIDE_LAB_STATE'
  Require (Test-Path -LiteralPath (Join-Path $extensionBackup 'lab-backup.json') -PathType Leaf) 'EXTENSION_BACKUP_MARKER_MISSING'
  $extensionApplied=$true

  # Final installation assertions; the browser must be reloaded separately.
  $installedManifest=Get-Content -LiteralPath (Join-Path $labExtensionRoot 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
  Require ([int]$installedManifest.manifest_version -eq 3 -and [string]$installedManifest.background.type -ceq 'module') 'INSTALLED_EXTENSION_MANIFEST_INVALID'
  $manifestKeyAfter=''
  if($installedManifest.PSObject.Properties['key']){$manifestKeyAfter=[string]$installedManifest.key}
  Require ($manifestKeyAfter -ceq $manifestKeyBefore) 'INSTALLED_EXTENSION_IDENTITY_KEY_CHANGED'
  Require (@($installedManifest.host_permissions) -contains 'http://127.0.0.1:17484/*') 'INSTALLED_EXTENSION_LAB_HOST_PERMISSION_MISSING'
  foreach($name in @('control.js','connection-check.js','transport-engine.js')){
    $source=[IO.File]::ReadAllText((Join-Path $labExtensionRoot $name))
    Require ($source.Contains('127.0.0.1:17484')) ('INSTALLED_EXTENSION_ENDPOINT_MISSING: '+$name)
    Require (-not $source.Contains('127.0.0.1:17381') -and -not $source.Contains('127.0.0.1:17382')) ('PRODUCTION_ENDPOINT_IN_EXTENSION: '+$name)
  }
  $finalPid=GetLabOwner
  $finalIdentity=AssertLabOwner $finalPid
  Require ($finalPid -eq $newPid -and $finalIdentity.command -ceq $newIdentity.command) 'Lab server process changed during extension installation'
  Require ((Get-FileHash -LiteralPath (Join-Path $labStateRoot 'config.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $configEvidence.ConfigSha256) 'Extension installation changed Lab credentials/config'
  Require ((ListenerSignature 17381) -ceq $production17381Before) 'PRODUCTION_17381_LISTENER_CHANGED'
  Require ((ListenerSignature 17382) -ceq $production17382Before) 'PRODUCTION_17382_LISTENER_CHANGED'
  Require ([string]$finalIdentity.created -ceq [string]$newIdentity.created) 'Lab server process epoch changed during extension installation'

  [pscustomobject]@{
    Result='PR132_LAB_RELEASE_APPLIED'
    SourceCommit=$expectedSha
    OldProcessId=$initialPid
    NewProcessId=$newPid
    ServerRoot=$labServerRoot
    ExtensionRoot=$labExtensionRoot
    StateRoot=$labStateRoot
    Port=$labPort
    ServerBackup=$serverBackup
    ExtensionBackup=$extensionBackup
    ServerHealth='PASS'
    SessionProviderRegistry='PASS'
    ExtensionManifest='PASS'
    ProductionListenersUnchanged=$true
    ProductionChanged=$false
    ProviderMessagesSent=$false
    SessionAuthorized=$false
    ChromeReloadRequired=$true
    ConnectorRefreshRequired=$true
  }|ConvertTo-Json -Depth 5
}catch{
  $originalError=$_.Exception.Message
  $rollbackResults=@()
  # Extension backup may exist even if updater threw after moving the candidate.
  try{
    if(-not $extensionBackup -and (Test-Path -LiteralPath $stateBackupRoot -PathType Container)){
      $newBackups=@(Get-ChildItem -LiteralPath $stateBackupRoot -Directory -Filter 'extension-*' -ErrorAction SilentlyContinue |
        Where-Object {$extensionBackupsBefore -notcontains $_.FullName -and (Test-Path -LiteralPath (Join-Path $_.FullName 'lab-backup.json') -PathType Leaf)})
      if($newBackups.Count -eq 1){$extensionBackup=$newBackups[0].FullName}
    }
    if($extensionBackup){$rollbackResults+=InvokeExtensionRollback $extensionBackup}
  }catch{$rollbackResults+=('EXTENSION_ROLLBACK_FAILED: '+$_.Exception.Message)}
  try{
    if($serverApplied){
      if(-not $serverBackup){
        $newServerBackups=@(Get-ChildItem -LiteralPath $stateBackupRoot -Directory -Filter 'server-*' -ErrorAction SilentlyContinue |
          Where-Object {$serverBackupsBefore -notcontains $_.FullName -and (Test-Path -LiteralPath (Join-Path $_.FullName 'server-backup.json') -PathType Leaf)})
        if($newServerBackups.Count -eq 1){$serverBackup=$newServerBackups[0].FullName}
      }
      if($serverBackup){$rollbackResults+=InvokeServerRollback $serverBackup}
      else{$rollbackResults+='SERVER_ROLLBACK_UNAVAILABLE: no validated PR102 Lab server backup found'}
    }
  }catch{$rollbackResults+=('SERVER_ROLLBACK_FAILED: '+$_.Exception.Message)}
  $summary='PR132 Lab release failed: '+$originalError
  if($rollbackResults.Count){$summary+='; rollback='+($rollbackResults -join ' | ')}
  throw $summary
}
