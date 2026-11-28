$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..\deployment\upgrade-windows.ps1'
$scriptPath = [IO.Path]::GetFullPath($scriptPath)
function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
function ExpectFailure([scriptblock]$Action, [string]$Message) {
  $failed = $false
  try { & $Action } catch { $failed = $true }
  Assert $failed $Message
}
function WriteManifest([string]$Path) {
  $manifest = @{
    manifest_version = 3
    version = '0.2.0'
    permissions = @('storage','scripting')
    host_permissions = @('http://127.0.0.1/*')
    background = @{ service_worker = 'background.js' }
  }
  [IO.File]::WriteAllText($Path, ($manifest | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('chrome-bridge-restore-safety-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $fixture 'profile'
$backup = Join-Path $fixture 'backup'
$installed = Join-Path $root 'extension'
$backupExtension = Join-Path $backup 'extension'
New-Item -ItemType Directory -Force -Path $installed,$backupExtension | Out-Null
try {
  WriteManifest (Join-Path $installed 'manifest.json')
  WriteManifest (Join-Path $backupExtension 'manifest.json')
  Set-Content -LiteralPath (Join-Path $installed 'current.txt') -Value 'current-extension'
  Set-Content -LiteralPath (Join-Path $backupExtension 'backup.txt') -Value 'backup-extension'
  Set-Content -LiteralPath (Join-Path $root 'config.json') -Value '{"token":"synthetic-preserve-me"}'
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'server') | Out-Null
  Set-Content -LiteralPath (Join-Path $root 'server/server.mjs') -Value 'synthetic-server-preserve-me'
  $manifestPath = Join-Path $installed 'manifest.json'
  $manifestHash = (Get-FileHash -LiteralPath $manifestPath).Hash
  $configHash = (Get-FileHash -LiteralPath (Join-Path $root 'config.json')).Hash
  $serverHash = (Get-FileHash -LiteralPath (Join-Path $root 'server/server.mjs')).Hash

  ExpectFailure { & $scriptPath -BridgeRoot $root -RollbackFrom $backup } 'Restore without -ConfirmRestore unexpectedly succeeded'
  Assert ((Get-FileHash -LiteralPath $manifestPath).Hash -eq $manifestHash) 'Unconfirmed Restore modified the installed manifest'
  Assert (Test-Path -LiteralPath (Join-Path $installed 'current.txt')) 'Unconfirmed Restore modified installed extension files'
  Assert (@(Get-ChildItem -LiteralPath $root -Directory -Filter '.extension-*').Count -eq 0) 'Unconfirmed Restore created staging/displaced directories'

  ExpectFailure { & $scriptPath -RollbackFrom $backup -ConfirmRestore } 'Restore without explicit -BridgeRoot unexpectedly succeeded'
  ExpectFailure { & $scriptPath -BridgeRoot 'C:\Engineering\chrome-bridge' -RollbackFrom $backup -ConfirmRestore } 'Production BridgeRoot was not rejected'

  $wrongRoot = Join-Path $fixture 'wrong-profile'
  New-Item -ItemType Directory -Force -Path (Join-Path $wrongRoot 'extension') | Out-Null
  WriteManifest (Join-Path $wrongRoot 'extension/manifest.json')
  ExpectFailure { & $scriptPath -BridgeRoot $wrongRoot -RollbackFrom $backup -ConfirmRestore } 'Unmarked disposable target was accepted'

  Set-Content -LiteralPath (Join-Path $root '.chrome-bridge-disposable') -Value 'CHROME_BRIDGE_DISPOSABLE_RESTORE_V1' -NoNewline
  & $scriptPath -BridgeRoot $root -RollbackFrom $backup -ConfirmRestore
  Assert (Test-Path -LiteralPath (Join-Path $installed 'backup.txt')) 'Confirmed Restore did not restore the backup extension'
  Assert (-not (Test-Path -LiteralPath (Join-Path $installed 'current.txt'))) 'Confirmed Restore retained displaced extension content'
  Assert ((Get-FileHash -LiteralPath (Join-Path $root 'config.json')).Hash -eq $configHash) 'Restore modified config/credentials'
  Assert ((Get-FileHash -LiteralPath (Join-Path $root 'server/server.mjs')).Hash -eq $serverHash) 'Restore modified server files'
  Write-Output '[PASS] Restore confirmation, explicit disposable target, no-write rejection, and extension-only recovery'
} finally {
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
