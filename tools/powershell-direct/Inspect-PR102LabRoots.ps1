# Read-only inventory of the dedicated PR102 Lab roots. No service or file changes.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceExpected = 'C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if ($workspace -ine $workspaceExpected) { throw 'UNEXPECTED_APPROVED_WORKSPACE' }

. (Join-Path (Join-Path $workspaceExpected 'work\ChromeBridge-PR145-4696c1c0-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20\deployment') 'process-identity.ps1')

$serverRoot = 'C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20'
$serverPath = Join-Path $serverRoot 'server'
$extensionRoot = 'C:\Engineering\ChromeBridge-PR102-17484-Lab'
$stateRoot = 'C:\Engineering\ChromeBridge-PR102-17484-State'
$extensionId = 'nhflbnfcaicihaepdcjacdmaddagcmcj'
function Exists([string]$Path) { Test-Path -LiteralPath $Path }
function Reparse([string]$Path) {
  if (-not (Exists $Path)) { return $false }
  return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}
function FileHash([string]$Path) {
  if (-not (Exists $Path)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$serverFiles = @()
if (Exists $serverPath) {
  $serverFiles = @(Get-ChildItem -LiteralPath $serverPath -File -Recurse -Force | ForEach-Object {
    [pscustomobject]@{ Path=$_.FullName.Substring($serverPath.Length).TrimStart('\'); Length=[long]$_.Length }
  })
}
$configPath = Join-Path $stateRoot 'config.json'
$configHash = FileHash $configPath
$agentTokenLength = 0
$browserTokenLength = 0
$configValid = $false
if (Exists $configPath) {
  $cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $configValid = ($cfg.agentToken -is [string] -and $cfg.agentToken.Length -ge 32 -and
    $cfg.browserToken -is [string] -and $cfg.browserToken.Length -ge 32)
  if ($cfg.agentToken -is [string]) { $agentTokenLength = $cfg.agentToken.Length }
  if ($cfg.browserToken -is [string]) { $browserTokenLength = $cfg.browserToken.Length }
}
$manifestPath = Join-Path $extensionRoot 'manifest.json'
$manifest = $null
if (Exists $manifestPath) { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
$extensionEndpoints = @()
foreach ($fileName in @('control.js','connection-check.js','transport-engine.js')) {
  $file = Join-Path $extensionRoot $fileName
  if (Exists $file) {
    $source = [IO.File]::ReadAllText($file)
    $extensionEndpoints += [pscustomobject]@{
      File=$fileName
      Has17484=$source.Contains('127.0.0.1:17484')
      Has17485=$source.Contains('127.0.0.1:17485')
      Has17381=$source.Contains('127.0.0.1:17381')
      Has17382=$source.Contains('127.0.0.1:17382')
    }
  }
}
$portSummary = @()
foreach ($port in @(17381,17382,17484,17485,17486,17487)) {
  $items = @([BridgeNativeMetadata]::Listeners($port))
  $portSummary += [pscustomobject]@{ Port=$port; Listeners=$items }
}
$result = [ordered]@{
  Result='PR102_LAB_ROOTS_READ_ONLY_INVENTORY'
  ServerRoot=$serverRoot
  ServerRootExists=(Exists $serverRoot)
  ServerRootReparse=(Reparse $serverRoot)
  ServerDirectoryExists=(Exists $serverPath)
  ServerEntryExists=(Exists (Join-Path $serverPath 'bridge.mjs'))
  ServerRegistryExists=(Exists (Join-Path $serverPath 'tools.mjs'))
  ServerFileCount=$serverFiles.Count
  ServerTreeFiles=$serverFiles
  ExtensionRoot=$extensionRoot
  ExtensionRootExists=(Exists $extensionRoot)
  ExtensionRootReparse=(Reparse $extensionRoot)
  ExtensionManifestExists=(Exists $manifestPath)
  ExtensionManifestSha256=(FileHash $manifestPath)
  ExtensionManifestVersion=if ($manifest) { [int]$manifest.manifest_version } else { $null }
  ExtensionBackgroundType=if ($manifest -and $manifest.background.PSObject.Properties['type']) { [string]$manifest.background.type } else { '' }
  ExtensionKeyPresent=[bool]($manifest -and $manifest.PSObject.Properties['key'])
  ExtensionHostPermissions=if ($manifest) { @($manifest.host_permissions) } else { @() }
  ExtensionEndpoints=$extensionEndpoints
  StateRoot=$stateRoot
  StateRootExists=(Exists $stateRoot)
  StateRootReparse=(Reparse $stateRoot)
  StateConfigExists=(Exists $configPath)
  StateConfigSha256=$configHash
  StateConfigValid=$configValid
  AgentTokenLength=$agentTokenLength
  BrowserTokenLength=$browserTokenLength
  ExistingBackups=if (Exists (Join-Path $stateRoot 'backups')) { @(Get-ChildItem -LiteralPath (Join-Path $stateRoot 'backups') -Directory -Force | ForEach-Object {$_.Name}) } else { @() }
  PortListeners=$portSummary
}
$result | ConvertTo-Json -Depth 6
