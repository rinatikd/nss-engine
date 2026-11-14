# Stage PR113 extension Origin pin in the isolated PR102 server config.
# Updates only extensionId and preserves existing secrets. Does NOT restart services.
[CmdletBinding()]
param(
  [string]$LabState = 'C:\Engineering\ChromeBridge-PR102-17484-State',
  [string]$ExpectedOldId = 'nhflbnfcaicihaepdcjacdmaddagcmcj',
  [switch]$Apply
)
$ErrorActionPreference='Stop'
$configFile=Join-Path $LabState 'config.json'
if(!(Test-Path -LiteralPath $configFile -PathType Leaf)) {
  throw "Lab config missing: $configFile"
}
$config=Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$oldId=[string]$config.extensionId
if($oldId -cne $ExpectedOldId) {
  throw 'Extension pin differs from expected original; refusing to update.'
}
$newId=Read-Host 'Paste new extension ID from chrome://extensions (32 characters, a-p)'
if($newId -cnotmatch '^[a-p]{32}$') {
  throw 'Invalid Chrome extension ID. No changes made.'
}
if($newId -ceq $oldId) {
  Write-Host 'No change needed: ID already pinned'
  exit 0
}
Write-Host "OLD EXTENSION ID: $oldId"
Write-Host "NEW EXTENSION ID: $newId"
if(!$Apply) {
  Write-Host 'DRY RUN: no changes; rerun with -Apply to back up and stage lab config'
  exit 0
}
$backup="$configFile.pr113-backup.$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item -LiteralPath $configFile -Destination $backup -ErrorAction Stop
try {
  $config.extensionId=$newId
  $payload=$config | ConvertTo-Json -Depth 32
  $utf8NoBom=New-Object System.Text.UTF8Encoding($false)
  $tempFile=Join-Path $LabState ('config.pr113-staged-'+[guid]::NewGuid().ToString('N')+'.tmp')
  [System.IO.File]::WriteAllText($tempFile,$payload,$utf8NoBom)
  Move-Item -LiteralPath $tempFile -Destination $configFile -Force
} catch {
  Copy-Item -LiteralPath $backup -Destination $configFile -Force
  throw
}
Write-Host 'RESULT: STAGED ONLY (server still running with original in-memory config)'
Write-Host "BACKUP: $backup"
Write-Host 'No services were restarted. Preserve backup for rollback.'
