# Read-only PR102 Lab runtime identity inspection. Never prints token values or full command line.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workspaceExpected = 'C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$repo = $workspaceExpected
$candidateRoot = Join-Path $repo 'docs\chrome-bridge-handoff\chrome-bridge-v20'
$extensionRoot = 'C:\Engineering\ChromeBridge-PR102-17484-Lab' # Legacy directory label; endpoint is 17485.
$stateRoot = 'C:\Engineering\ChromeBridge-PR102-17485-State'
$labPort = 17485
$labExtensionId = 'nhflbnfcaicihaepdcjacdmaddagcmcj'
$consiliumExtensionId = 'ojkfdjndmcpnphecoadbcnmlnadmmkah'

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if ($workspace -ine $workspaceExpected) { throw 'UNEXPECTED_APPROVED_WORKSPACE' }
$identityScript = Join-Path $candidateRoot 'deployment\process-identity.ps1'
if (-not (Test-Path -LiteralPath $identityScript -PathType Leaf)) { throw 'PINNED_PROCESS_IDENTITY_HELPER_MISSING' }
. $identityScript
function AclSummary([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $null }
  try {
    $acl = Get-Acl -LiteralPath $Path
    return [pscustomobject]@{
      Owner = [string]$acl.Owner
      Access = @($acl.Access | ForEach-Object {
        [pscustomobject]@{
          Identity = [string]$_.IdentityReference
          Rights = [string]$_.FileSystemRights
          Type = [string]$_.AccessControlType
          IsInherited = [bool]$_.IsInherited
        }
      })
    }
  } catch {
    return [pscustomobject]@{ Error = $_.Exception.Message }
  }
}

$listeners = @([BridgeNativeMetadata]::Listeners($labPort))
if ($listeners.Count -ne 1) { throw ('LAB_LISTENER_COUNT_MISMATCH: ' + $listeners.Count) }
$parts = ([string]$listeners[0]).Split('|')
if ($parts.Count -ne 2 -or $parts[0] -cne '127.0.0.1') { throw 'LAB_LISTENER_NOT_LOOPBACK' }
$pidValue = 0
if (-not [int]::TryParse($parts[1], [ref]$pidValue) -or $pidValue -le 0) { throw 'LAB_LISTENER_PID_INVALID' }

$proc = [Diagnostics.Process]::GetProcessById($pidValue)
try {
  $identity = Get-BridgeHandleIdentity $proc
  $processName = $proc.ProcessName
} finally {
  $proc.Dispose()
}

$command = [string]$identity.command
$entryPoint = ''
$commandKind = 'unrecognized'
if ($command -match '^\s*"[^"]+"\s+"(?<entry>[^"]+)"') {
  $entryPoint = [string]$Matches.entry
  if ($entryPoint -match '(?i)\\server\\bridge\.mjs$') { $commandKind = 'direct-server-entry' }
  elseif ($entryPoint -match '(?i)\\deployment\\cutover-start\.mjs$') { $commandKind = 'transaction-launcher' }
  else { $commandKind = 'other-node-entry' }
}

$workingDirectory = [string]$identity.workingDirectory
$bridgeHome = [string]$identity.bridgeHome
$configPath = ''
if (-not [string]::IsNullOrWhiteSpace($bridgeHome)) {
  $configPath = Join-Path $bridgeHome 'config.json'
}
$configExists = -not [string]::IsNullOrWhiteSpace($configPath) -and (Test-Path -LiteralPath $configPath -PathType Leaf)
$configHash = ''
$agentTokenLength = 0
$browserTokenLength = 0
if ($configExists) {
  $configHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($config.agentToken -is [string]) { $agentTokenLength = $config.agentToken.Length }
  if ($config.browserToken -is [string]) { $browserTokenLength = $config.browserToken.Length }
}

$securePreferenceMatch = $false
$secureMappings = @()
$extensionIdsToInspect = @($labExtensionId, $consiliumExtensionId)
$chromeRoots = @((Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')) |
  Where-Object { Test-Path -LiteralPath $_ -PathType Container }
foreach ($chromeRoot in $chromeRoots) {
  $profiles = @('Default') + @(
    Get-ChildItem -LiteralPath $chromeRoot -Directory -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^Profile \d+$' } |
      ForEach-Object { $_.Name }
  )
  foreach ($profile in $profiles) {
    $preferencesPath = Join-Path (Join-Path $chromeRoot $profile) 'Secure Preferences'
    if (-not (Test-Path -LiteralPath $preferencesPath -PathType Leaf)) { continue }
    try {
      $preferences = Get-Content -LiteralPath $preferencesPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($inspectId in $extensionIdsToInspect) {
        $entry = $preferences.extensions.settings.PSObject.Properties[$inspectId]
        if (-not $entry) { continue }
        $mappedPath = [IO.Path]::GetFullPath([string]$entry.Value.path).TrimEnd('\')
        $entryState = $null
        if ($entry.Value.PSObject.Properties['state']) { $entryState = [int]$entry.Value.state }
        $mapsToPr102 = ($inspectId -ceq $labExtensionId -and
          $mappedPath -ieq [IO.Path]::GetFullPath($extensionRoot).TrimEnd('\'))
        $secureMappings += [pscustomobject]@{
          Profile = $profile
          ExtensionId = $inspectId
          Path = $mappedPath
          State = $entryState
          MapsToPR102Root = $mapsToPr102
        }
        if ($mapsToPr102) { $securePreferenceMatch = $true }
      }
    } catch {}
  }
}

$summary = [ordered]@{
  Result = 'PR102_LAB_RUNTIME_IDENTITY_READ'
  ListenerAddress = $parts[0]
  ListenerPort = $labPort
  ProcessId = $pidValue
  ProcessName = $processName
  ExecutablePath = [string]$identity.executable
  CommandKind = $commandKind
  EntryPoint = $entryPoint
  EntryPointExists = [bool]($entryPoint -and (Test-Path -LiteralPath $entryPoint -PathType Leaf))
  WorkingDirectory = $workingDirectory
  WorkingDirectoryExists = [bool](Test-Path -LiteralPath $workingDirectory -PathType Container)
  ServerBridgeEntryExists = [bool](Test-Path -LiteralPath (Join-Path $workingDirectory 'server\bridge.mjs') -PathType Leaf)
  ServerToolsRegistryExists = [bool](Test-Path -LiteralPath (Join-Path $workingDirectory 'server\tools.mjs') -PathType Leaf)
  BridgeHome = $bridgeHome
  BridgeHomeExists = [bool](-not [string]::IsNullOrWhiteSpace($bridgeHome) -and (Test-Path -LiteralPath $bridgeHome -PathType Container))
  BridgePortEnvironment = [string]$identity.bridgePort
  ExtensionIdEnvironment = [string]$identity.extensionId
  ExpectedExtensionIdMatches = ([string]$identity.extensionId -ceq $labExtensionId)
  StateRootMatchesExpected = ([string]$bridgeHome -ieq $stateRoot)
  StateConfigExists = $configExists
  StateConfigSha256 = $configHash
  AgentTokenLength = $agentTokenLength
  BrowserTokenLength = $browserTokenLength
  ChromeSecurePreferencesMapLabExtension = $securePreferenceMatch
  ChromeExtensionMappings = @($secureMappings)
  ExtensionRootAcl = (AclSummary $extensionRoot)
  StateRootAcl = (AclSummary $stateRoot)
  ExpectedExtensionRoot = $extensionRoot
  ExtensionRootDirectoryNameIsLegacy17484Label = ((Split-Path $extensionRoot -Leaf) -eq 'ChromeBridge-PR102-17484-Lab')
  ExpectedStateRoot = $stateRoot
  ProcessCreatedUtc = [string]$identity.created
}
$summary | ConvertTo-Json -Depth 5
