# Windows PowerShell 5.1 PR102 Lab server cutover integration test.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path $PSScriptRoot -Parent
$updater = Join-Path $packageRoot 'deployment\upgrade-pr102-lab-server.ps1'
. (Join-Path $packageRoot 'deployment\process-identity.ps1')
$root = Join-Path $env:RUNNER_TEMP 'ChromeBridge-PR102-17484-Lab-Server-TestFixture'
$state = Join-Path $root 'state'
$server = Join-Path $root 'server'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$sourceSha = (& git -C $packageRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve source SHA' }
if (Test-Path -LiteralPath $root) { throw 'Fixture already exists; refusing overwrite' }
if (@([BridgeNativeMetadata]::Listeners(17484)).Count -ne 0) { throw 'Port 17484 occupied; refusing unrelated process' }

$activePid = 0
$activeStart = $null
$old = $null
$oldStdoutTask = $null
$oldStderrTask = $null
$testError = $null
$cleanupError = $null
function WaitPort([int]$Pid) {
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    $items = @([BridgeNativeMetadata]::Listeners(17484))
    if ($items.Count -eq 1 -and $items[0] -eq ('127.0.0.1|' + $Pid)) { return }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Server listener did not become ready' }
    Start-Sleep -Milliseconds 150
  } while ($true)
}
function RunUpdater([string[]]$ArgsList) {
  $result = @(& $updater @ArgsList 2>&1)
  if ($LASTEXITCODE -ne 0) { throw ('Updater failed: ' + ($result -join ' ')) }
  return $result
}
function CurrentOwner {
  $items = @([BridgeNativeMetadata]::Listeners(17484))
  if ($items.Count -ne 1 -or $items[0] -notmatch '^127\.0\.0\.1\|[0-9]+$') { throw 'Expected one Lab listener' }
  return [int]($items[0].Split('|')[1])
}

try {
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  New-Item -ItemType Directory -Path $server -Force | Out-Null
  $legacy = Join-Path $packageRoot 'rollback-candidates\v020-cors-recovered\server'
  if (-not (Test-Path -LiteralPath (Join-Path $legacy 'bridge.mjs'))) { throw 'Legacy server fixture missing' }
  Copy-Item -Path (Join-Path $legacy '*') -Destination $server -Recurse -Force
  $config = @{
    agentToken = 'synthetic-lab-agent-' + [guid]::NewGuid().ToString('N')
    browserToken = 'synthetic-lab-browser-' + [guid]::NewGuid().ToString('N')
    extensionId = 'nhflbnfcaicihaepdcjacdmaddagcmcj'
  }
  $configPath = Join-Path $state 'config.json'
  [IO.File]::WriteAllText($configPath,($config | ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false)))
  $configHash = (Get-FileHash $configPath -Algorithm SHA256).Hash

  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '"' + (Join-Path $server 'bridge.mjs') + '"'
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables['CHROME_BRIDGE_HOME'] = $state
  $psi.EnvironmentVariables['CHROME_BRIDGE_PORT'] = '17484'
  $psi.EnvironmentVariables.Remove('CHROME_BRIDGE_CODEX_POLICY')
  $old = New-Object Diagnostics.Process
  $old.StartInfo = $psi
  if (-not $old.Start()) { throw 'Legacy fixture process did not start' }
  $oldStdoutTask = $old.StandardOutput.ReadToEndAsync()
  $oldStderrTask = $old.StandardError.ReadToEndAsync()
  WaitPort $old.Id
  $oldMeta = Get-BridgeHandleIdentity $old
  $activePid = $old.Id
  $activeStart = $oldMeta.created

  $args = @('-LabRoot',$root,'-StateRoot',$state,'-ExpectedPid',[string]$activePid,
    '-ExpectedStartUtc',$activeStart,'-CandidateRoot',$packageRoot,
    '-ExpectedSourceSha',$sourceSha,'-TestFixture')
  $before = (Get-FileHash (Join-Path $server 'bridge.mjs') -Algorithm SHA256).Hash
  $dry = RunUpdater $args
  if (($dry -join ' ') -notmatch '\[DRY_RUN\]') { throw 'Server dry-run marker missing' }
  if ((Get-FileHash $configPath -Algorithm SHA256).Hash -ne $configHash) { throw 'Dry-run changed config' }
  if ((Get-FileHash (Join-Path $server 'bridge.mjs') -Algorithm SHA256).Hash -ne $before) { throw 'Dry-run changed server source' }
  WaitPort $activePid

  $applied = RunUpdater ($args + @('-Apply'))
  if (($applied -join ' ') -notmatch '\[UPGRADED\]') { throw 'Upgrade marker missing' }
  if ((Get-FileHash $configPath -Algorithm SHA256).Hash -ne $configHash) { throw 'Upgrade changed config/tokens' }
  $activePid = CurrentOwner
  $p = [Diagnostics.Process]::GetProcessById($activePid)
  try { $activeStart = (Get-BridgeHandleIdentity $p).created } finally { $p.Dispose() }
  $backupLine = @($applied | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\[BACKUP\]\s+' } | Select-Object -Last 1)
  if ($backupLine.Count -ne 1) { throw 'Backup path not reported' }
  $backup = ($backupLine[0] -replace '^\[BACKUP\]\s+','').Trim()
  if (-not (Test-Path -LiteralPath (Join-Path $backup 'server-backup.json'))) { throw 'Server backup marker missing' }

  $expectedNew = Join-Path $env:RUNNER_TEMP 'pr102-server-upgrade-tools.json'
  $code = "import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  Push-Location $packageRoot
  try { & $node --input-type=module -e $code $expectedNew; if ($LASTEXITCODE -ne 0) { throw 'Cannot build expected new registry' } } finally { Pop-Location }
  $health = Join-Path $packageRoot 'deployment\cutover-health.mjs'
  $job = Join-Path $env:RUNNER_TEMP 'pr102-server-upgrade-health.json'
  [IO.File]::WriteAllText($job,(@{mode='live';source=$root;state=$state;port=17484;expected=$expectedNew} | ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false)))
  & $node $health $job
  if ($LASTEXITCODE -ne 0) { throw 'Upgraded server health failed' }
  $newNames = @((Get-Content $expectedNew -Raw | ConvertFrom-Json).result.tools | ForEach-Object { $_.name })
  foreach ($n in @('session_request','session_authorize','session_status','session_revoke','provider_prepare','provider_commit','provider_status','provider_stop','provider_revoke','provider_events')) {
    if ($newNames -notcontains $n) { throw ('New registry missing ' + $n) }
  }

  $rbArgs = @('-LabRoot',$root,'-StateRoot',$state,'-ExpectedPid',[string]$activePid,
    '-ExpectedStartUtc',$activeStart,'-CandidateRoot',$packageRoot,
    '-ExpectedSourceSha',$sourceSha,'-RollbackFrom',$backup,'-TestFixture')
  $rbDry = RunUpdater $rbArgs
  if (($rbDry -join ' ') -notmatch '\[DRY_RUN\]') { throw 'Rollback dry-run marker missing' }
  $rb = RunUpdater ($rbArgs + @('-Apply'))
  if (($rb -join ' ') -notmatch '\[ROLLED_BACK\]') { throw 'Rollback marker missing' }
  $activePid = CurrentOwner
  $p = [Diagnostics.Process]::GetProcessById($activePid)
  try { $activeStart = (Get-BridgeHandleIdentity $p).created } finally { $p.Dispose() }
  $expectedOld = Join-Path $env:RUNNER_TEMP 'pr102-server-rollback-tools.json'
  $oldCode = "import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  Push-Location $root
  try { & $node --input-type=module -e $oldCode $expectedOld; if ($LASTEXITCODE -ne 0) { throw 'Cannot build legacy registry' } } finally { Pop-Location }
  $job2 = Join-Path $env:RUNNER_TEMP 'pr102-server-rollback-health.json'
  [IO.File]::WriteAllText($job2,(@{mode='live';source=$root;state=$state;port=17484;expected=$expectedOld} | ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false)))
  & $node $health $job2
  if ($LASTEXITCODE -ne 0) { throw 'Rolled-back server health failed' }
  $oldNames = @((Get-Content $expectedOld -Raw | ConvertFrom-Json).result.tools | ForEach-Object { $_.name })
  if ($oldNames -contains 'session_request' -or $oldNames -contains 'provider_prepare') { throw 'Rollback did not restore legacy registry' }
  if ((Get-FileHash $configPath -Algorithm SHA256).Hash -ne $configHash) { throw 'Rollback changed config/tokens' }
  Write-Output '[PASS] PR102 Lab server dry-run/apply/health/rollback; PID fencing; config preservation; tools/list upgrade and restore'
} catch {
  # Preserve the original test failure; cleanup must not overwrite its evidence.
  $testError = $_
} finally {
  # The original process is a child created by this test, so its Process handle
  # is an exact, safe cleanup target even if the cutover already stopped it.
  if ($old) {
    try {
      if (-not $old.HasExited) {
        $old.Kill()
        if (-not $old.WaitForExit(8000)) { throw 'Original synthetic server did not stop during cleanup' }
      }
    } catch { if (-not $cleanupError) { $cleanupError = $_ } }
    foreach ($drain in @($oldStdoutTask,$oldStderrTask)) {
      if ($null -ne $drain) {
        try { $null = $drain.Wait(2000) } catch {}
      }
    }
    try { $old.Dispose() } catch {}
  }

  # An updater can start the automatic-rollback server and then throw before
  # returning its PID. Find only Node processes whose executable command path
  # is beneath this unique synthetic fixture root; never kill an unrelated
  # listener merely because it uses port 17484.
  $fixturePrefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  foreach ($candidate in [Diagnostics.Process]::GetProcesses()) {
    try {
      $meta = Get-BridgeHandleIdentity $candidate
      $command = ([string]$meta.command).Replace('/','\')
      if (($meta.executable -match '(?i)\\node\.exe$') -and
          ($command.IndexOf($fixturePrefix,[StringComparison]::OrdinalIgnoreCase) -ge 0) -and
          -not $candidate.HasExited) {
        $candidate.Kill()
        if (-not $candidate.WaitForExit(8000) -and -not $cleanupError) {
          $cleanupError = 'Synthetic Node process did not stop: PID ' + $candidate.Id
        }
      }
    } catch {
      # Processes may exit while being enumerated; only retain a cleanup error
      # when the process still exposes a matching fixture command line.
    } finally {
      try { $candidate.Dispose() } catch {}
    }
  }

  if (Test-Path -LiteralPath $root) {
    $removed = $false
    for ($attempt = 0; $attempt -lt 10 -and -not $removed; $attempt++) {
      try {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
        $removed = -not (Test-Path -LiteralPath $root)
      } catch {
        Start-Sleep -Milliseconds 200
      }
    }
    if (-not $removed -and -not $cleanupError) {
      $cleanupError = 'Synthetic fixture directory remains locked after bounded cleanup retries: ' + $root
    }
  }
  foreach ($n in @('pr102-server-upgrade-tools.json','pr102-server-upgrade-health.json','pr102-server-rollback-tools.json','pr102-server-rollback-health.json')) {
    $f = Join-Path $env:RUNNER_TEMP $n
    if (Test-Path -LiteralPath $f) {
      try { Remove-Item -LiteralPath $f -Force -ErrorAction Stop } catch {}
    }
  }
}

if ($testError) { throw $testError }
if ($cleanupError) { throw $cleanupError }
