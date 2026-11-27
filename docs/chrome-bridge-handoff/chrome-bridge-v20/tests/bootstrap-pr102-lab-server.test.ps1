# Exercise first-time PR102 Lab server bootstrap on disposable CI fixtures only.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path $PSScriptRoot -Parent
$bootstrap = Join-Path $packageRoot 'deployment\bootstrap-pr102-lab-server.ps1'
$bootstrapSource = [IO.File]::ReadAllText($bootstrap)
if ($bootstrapSource.Contains('C:\Engineering\ChromeBridge-PR102-17484-State') -or
    -not $bootstrapSource.Contains('C:\Engineering\ChromeBridge-PR102-17485-State')) {
  throw 'Bootstrap must target the dedicated PR102 17485 StateRoot, never the 17484 StateRoot'
}
$updater = Join-Path $packageRoot 'deployment\upgrade-pr102-lab-server.ps1'
. (Join-Path $packageRoot 'deployment\process-identity.ps1')
. (Join-Path $packageRoot 'deployment\verify-candidate-source.ps1')

$root = Join-Path $env:RUNNER_TEMP 'ChromeBridge-PR102-17485-Lab-Server-TestFixture'
$state = Join-Path $root 'state'
$server = Join-Path $root 'server'
$node = [string](Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$sourceSha = (& git -C $packageRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve candidate source SHA' }
if (Test-Path -LiteralPath $root) { throw 'Bootstrap fixture already exists; refusing overwrite' }
if (@([BridgeNativeMetadata]::Listeners(17485)).Count -ne 0) { throw 'Port 17485 occupied; refusing unrelated process' }

function RunScript([string]$Path,[hashtable]$NamedArgs) {
  $result = @(& $Path @NamedArgs 2>&1)
  if ($LASTEXITCODE -ne 0) { throw ('Script failed: ' + $Path + '; ' + ($result -join ' ')) }
  return $result
}
function CurrentOwner {
  $items = @([BridgeNativeMetadata]::Listeners(17485))
  if ($items.Count -ne 1 -or $items[0] -notmatch '^127\.0\.0\.1\|[0-9]+$') { throw 'Expected one PR102 test listener' }
  return [int]($items[0].Split('|')[1])
}
function GetOwnerIdentity([int]$ProcessId) {
  $p = [Diagnostics.Process]::GetProcessById($ProcessId)
  try { return Get-BridgeHandleIdentity $p } finally { $p.Dispose() }
}
function StopFixtureOwner {
  $items = @([BridgeNativeMetadata]::Listeners(17485))
  if ($items.Count -eq 0) { return }
  if ($items.Count -ne 1 -or $items[0] -notmatch '^127\.0\.0\.1\|[0-9]+$') { throw 'Unexpected listener set during fixture cleanup' }
  $pidValue = [int]($items[0].Split('|')[1])
  $p = [Diagnostics.Process]::GetProcessById($pidValue)
  try {
    $identity = Get-BridgeHandleIdentity $p
    if ((Get-BridgeCanonicalPath ([string]$identity.workingDirectory)) -ine (Get-BridgeCanonicalPath $root) -or
        (Get-BridgeCanonicalPath ([string]$identity.bridgeHome)) -ine (Get-BridgeCanonicalPath $state) -or
        [string]$identity.bridgePort -cne '17485' -or
        [string]$identity.extensionId -cne 'nhflbnfcaicihaepdcjacdmaddagcmcj') {
      throw 'Cleanup refused to stop a process not owned by this synthetic fixture'
    }
    $null = $p.Handle
    $p.Kill()
    if (-not $p.WaitForExit(8000)) { throw 'Synthetic PR102 server did not stop' }
  } finally { $p.Dispose() }
}

$testError = $null
$cleanupError = $null
$oldServerHash = ''
$configHash = ''
$backup = ''
try {
  New-Item -ItemType Directory -Path $server -Force | Out-Null
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  $legacy = Join-Path $packageRoot 'rollback-candidates\v020-cors-recovered\server'
  if (-not (Test-Path -LiteralPath (Join-Path $legacy 'bridge.mjs'))) { throw 'Legacy server fixture missing' }
  Copy-Item -Path (Join-Path $legacy '*') -Destination $server -Recurse -Force
  $config = @{
    agentToken = 'synthetic-lab-agent-' + [guid]::NewGuid().ToString('N')
    browserToken = 'synthetic-lab-browser-' + [guid]::NewGuid().ToString('N')
    extensionId = 'deliberately-stale-config-extension-id'
  }
  $configPath = Join-Path $state 'config.json'
  [IO.File]::WriteAllText($configPath,($config | ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false)))
  $configHash = (Get-FileHash $configPath -Algorithm SHA256).Hash
  $oldServerHash = (Get-FileHash (Join-Path $server 'bridge.mjs') -Algorithm SHA256).Hash

  $common = @{
    LabRoot = $root
    StateRoot = $state
    CandidateRoot = $packageRoot
    ExpectedSourceSha = $sourceSha
    NodeExe = $node
    TestFixture = $true
  }
  $dry = RunScript $bootstrap $common
  if (($dry -join ' ') -notmatch '\[DRY_RUN\]') { throw 'Bootstrap dry-run marker missing' }
  if ((Get-FileHash $configPath -Algorithm SHA256).Hash -ne $configHash) { throw 'Bootstrap dry-run changed synthetic State config' }
  if ((Get-FileHash (Join-Path $server 'bridge.mjs') -Algorithm SHA256).Hash -ne $oldServerHash) { throw 'Bootstrap dry-run changed installed server' }
  if (@([BridgeNativeMetadata]::Listeners(17485)).Count -ne 0) { throw 'Bootstrap dry-run started a listener' }
  Write-Output '[PASS] PR102 bootstrap dry-run preserves existing server and State'

  $apply = @{}
  foreach ($key in $common.Keys) { $apply[$key] = $common[$key] }
  $apply['Apply'] = $true
  $applied = RunScript $bootstrap $apply
  if (($applied -join ' ') -notmatch '\[BOOTSTRAPPED\]') { throw 'Bootstrap apply marker missing' }
  $backupLine = @($applied | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\[BACKUP\]\s+' } | Select-Object -Last 1)
  if ($backupLine.Count -ne 1) { throw 'Bootstrap backup path not reported' }
  $backup = ($backupLine[0] -replace '^\[BACKUP\]\s+','').Trim()
  if (-not (Test-Path -LiteralPath (Join-Path $backup 'server-backup.json'))) { throw 'Bootstrap backup marker missing' }
  $marker = Get-Content -LiteralPath (Join-Path $backup 'server-backup.json') -Raw | ConvertFrom-Json
  if ([int]$marker.port -ne 17485 -or $marker.target -cne 'PR102_LAB') { throw 'Bootstrap backup is not pinned to PR102 port 17485' }
  $activePid = CurrentOwner
  $identity = GetOwnerIdentity $activePid
  if ([string]$identity.extensionId -cne 'nhflbnfcaicihaepdcjacdmaddagcmcj') { throw 'Bootstrap did not pin the PR102 extension identity' }
  if ([string]$identity.bridgePort -cne '17485') { throw 'Bootstrap did not pin port 17485' }
  if ((Get-FileHash $configPath -Algorithm SHA256).Hash -ne $configHash) { throw 'Bootstrap changed State config/tokens' }

  # Exercise the normal server updater's backup-compatible rollback path.
  $rollback = @{
    LabRoot = $root
    StateRoot = $state
    ExpectedPid = $activePid
    ExpectedStartUtc = [string]$identity.created
    CandidateRoot = $packageRoot
    ExpectedSourceSha = $sourceSha
    RollbackFrom = $backup
    TestFixture = $true
    Apply = $true
  }
  $rolledBack = RunScript $updater $rollback
  if (($rolledBack -join ' ') -notmatch '\[ROLLED_BACK\]') { throw 'Bootstrap backup rollback marker missing' }
    $expectedOld = Join-Path $env:RUNNER_TEMP 'pr102-bootstrap-rollback-tools.json'
  $oldCode = "import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  Push-Location $root
  try {
    & $node --input-type=module -e $oldCode $expectedOld
    if ($LASTEXITCODE -ne 0) { throw 'Could not read restored server registry' }
  } finally { Pop-Location }
  $oldNames = @((Get-Content $expectedOld -Raw | ConvertFrom-Json).result.tools | ForEach-Object { $_.name })
  if ($oldNames -contains 'session_request' -or $oldNames -contains 'provider_prepare') { throw 'Rollback did not restore legacy server registry' }
  if ((Get-FileHash $configPath -Algorithm SHA256).Hash -ne $configHash) { throw 'Bootstrap rollback changed State config/tokens' }
  Write-Output '[PASS] PR102 bootstrap apply, exact process identity, 30-tool health and compatible rollback'
} catch {
  $testError = $_
} finally {
  try { StopFixtureOwner } catch { $cleanupError = $_ }
  foreach ($file in @('pr102-server-upgrade-tools.json','pr102-server-rollback-health.json','pr102-server-rollback-tools.json','pr102-bootstrap-rollback-tools.json')) {
    $path = Join-Path $env:RUNNER_TEMP $file
    if (Test-Path -LiteralPath $path) { try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop } catch {} }
  }
  if (Test-Path -LiteralPath $root) {
    try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop }
    catch { if (-not $cleanupError) { $cleanupError = $_ } }
  }
}
if ($testError) { throw $testError }
if ($cleanupError) { throw $cleanupError }
