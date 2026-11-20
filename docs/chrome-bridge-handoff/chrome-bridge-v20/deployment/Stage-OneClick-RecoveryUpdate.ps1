# Safe PR113 LAB update in the existing unpacked-extension path so Chrome
# retains its current extension ID. Default PREVIEW; -Apply opt-in only.
# This is NOT a production deployment.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
$deployment=$PSScriptRoot
$build=Join-Path $deployment 'Build-OneClick-Lab.ps1'
$installed='C:\Engineering\ChromeBridge-PR113-E2E-Build-v2\extension-17484'
$stageRoot='C:\Engineering\ChromeBridge-PR113-Recovery-Stage'
$staged=Join-Path $stageRoot 'extension-17484'
$parent=Split-Path $installed -Parent
$backup=Join-Path $parent ('extension-17484.backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
if(!(Test-Path -LiteralPath $installed -PathType Container)){throw 'KNOWN_LAB_EXTENSION_NOT_FOUND'}
$oldManifest=Get-Content -LiteralPath (Join-Path $installed 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($oldManifest.manifest_version -ne 3 -or $oldManifest.version -ne '0.3.0'){
  throw 'UNEXPECTED_INSTALLED_LAB_EXTENSION'
}
if(!$Apply){
  [PSCustomObject]@{
    Mode='PREVIEW'
    InstalledPath=$installed
    ExistingVersion=$oldManifest.version
    NewNativeMessagingPermission='required'
    Note='Apply stages new source and takes a local backup; reload extension manually afterward'
  }|ConvertTo-Json
  return
}
if(Test-Path -LiteralPath $stageRoot){throw 'STAGE_EXISTS_REVIEW_BEFORE_OVERWRITE'}
& $build -LabPort 17484 -OutputRoot $stageRoot
if($LASTEXITCODE -and $LASTEXITCODE -ne 0){throw 'STAGE_BUILD_FAILED'}
$newManifest=Get-Content -LiteralPath (Join-Path $staged 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($newManifest.name -ne 'Chrome Bridge PR113 LAB (17484)' -or
   $newManifest.host_permissions -notcontains 'http://127.0.0.1:17484/*' -or
   $newManifest.permissions -notcontains 'nativeMessaging'){
  throw 'STAGED_MANIFEST_NOT_APPROVED'
}
$unsafe=@(Get-ChildItem -LiteralPath $staged -Recurse -File|
  Where-Object {$_.Extension -in '.js','.json','.html'}|
  Select-String -SimpleMatch '127.0.0.1:17381')
if($unsafe.Count){throw 'STAGED_PRODUCTION_ENDPOINT_FOUND'}
# Back up the entire unpacked extension in the same drive.
Copy-Item -LiteralPath $installed -Destination $backup -Recurse -ErrorAction Stop
$names=@(Get-ChildItem -LiteralPath $staged -File -Recurse|
  ForEach-Object {$_.FullName.Substring($staged.Length+1)})
foreach($relative in $names){
  $src=Join-Path $staged $relative
  $dst=Join-Path $installed $relative
  $dir=Split-Path $dst -Parent
  if(!(Test-Path $dir)){New-Item -ItemType Directory -Path $dir -Force|Out-Null}
  Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
}
[PSCustomObject]@{
  Mode='UPDATED_LAB_FILES_ONLY'
  InstalledPath=$installed
  Backup=$backup
  UpdatedFiles=$names.Count
  NextAction='Reload existing extension in isolated Chrome; verify extension ID unchanged'
  ProductionModified=$false
}|ConvertTo-Json
