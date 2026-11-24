# Windows PowerShell 5.1 PR102 Lab server cutover integration test.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path $PSScriptRoot -Parent
$updater = Join-Path $packageRoot 'deployment\upgrade-pr102-lab-server.ps1'
. (Join-Path $packageRoot 'deployment\process-identity.ps1')
. (Join-Path $packageRoot 'deployment\verify-candidate-source.ps1')
$root = Join-Path $env:RUNNER_TEMP 'ChromeBridge-PR102-17485-Lab-Server-TestFixture'
$rootWithTrailingSeparator = $root + [IO.Path]::DirectorySeparatorChar
if ((Get-BridgeCanonicalPath $rootWithTrailingSeparator) -cne (Get-BridgeCanonicalPath $root)) {
  throw 'Trailing-separator process path normalization failed'
}
$nodeCommand=[string](Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$alternateNode=Join-Path (Split-Path -Parent $nodeCommand) 'alternate-node.exe'
$resolvedPinnedNode=Get-BridgePinnedExecutable $nodeCommand @($nodeCommand.Replace('\','/'),$alternateNode)
if($resolvedPinnedNode -ine (Get-BridgeCanonicalPath $nodeCommand)){
  throw 'Pinned Node executable was not selected from multiple available paths'
}
$missingPinnedNodeRejected=$false
try{
  $null=Get-BridgePinnedExecutable $nodeCommand @($alternateNode)
}catch{
  if($_.Exception.Message -like 'EXPECTED_PROCESS_EXECUTABLE_NOT_IN_PATH*'){$missingPinnedNodeRejected=$true}else{throw}
}
if(-not $missingPinnedNodeRejected){throw 'Missing pinned Node executable was not rejected'}
$state = Join-Path $root 'state'
$server = Join-Path $root 'server'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$sourceSha = (& git -C $packageRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve source SHA' }

$preStatus = Invoke-BridgeCandidateGit -CandidateRoot $packageRoot -GitArgList @('status','--porcelain=v1','--untracked-files=all','--','server','deployment/cutover-health.mjs','deployment/cutover-start.mjs','deployment/process-identity.ps1','deployment/verify-candidate-source.ps1','deployment/upgrade-pr102-lab-server.ps1')
if (-not [string]::IsNullOrWhiteSpace($preStatus)) {
  $identityDiff = Invoke-BridgeCandidateGit -CandidateRoot $packageRoot -GitArgList @('diff','--no-ext-diff','--','deployment/process-identity.ps1')
  $identitySummary = Invoke-BridgeCandidateGit -CandidateRoot $packageRoot -GitArgList @('diff','--numstat','--','deployment/process-identity.ps1')
  Write-Output ('[PROCESS_IDENTITY_DIFF_NUMSTAT] '+$identitySummary)
  Write-Output ('[PROCESS_IDENTITY_DIFF] '+$identityDiff)
}
if ([string]::IsNullOrWhiteSpace($preStatus)) { Write-Output '[CANDIDATE_PRECHECK_STATUS] CLEAN' } else { Write-Output ('[CANDIDATE_PRECHECK_STATUS] '+$preStatus) }

$sourceInputs = @(
  'server',
  'deployment/cutover-health.mjs',
  'deployment/cutover-start.mjs',
  'deployment/process-identity.ps1',
  'deployment/verify-candidate-source.ps1',
  'deployment/upgrade-pr102-lab-server.ps1'
)
$dirtyFile = Join-Path $packageRoot 'server\.pr102-candidate-dirty-test.mjs'
[IO.File]::WriteAllText($dirtyFile,'synthetic untracked candidate source')
$dirtyRejected = $false
try {
  try {
    $null = Assert-BridgeCandidateSource -CandidateRoot $packageRoot -ExpectedSourceSha $sourceSha -InputPaths $sourceInputs
  } catch {
    if ($_.Exception.Message -like 'CANDIDATE_WORKTREE_NOT_CLEAN*') { $dirtyRejected = $true } else { throw }
  }
} finally {
  if (Test-Path -LiteralPath $dirtyFile) { Remove-Item -LiteralPath $dirtyFile -Force }
}
if (-not $dirtyRejected) { throw 'Untracked server candidate file was not rejected' }
Write-Output '[PASS] Server candidate untracked-file rejection'

$ignoredFile = Join-Path $packageRoot 'server\pr102-candidate-ignored-test.json'
[IO.File]::WriteAllText($ignoredFile,'synthetic ignored candidate data')
$ignoredRejected = $false
try {
  try {
    $null = Assert-BridgeCandidateSource -CandidateRoot $packageRoot -ExpectedSourceSha $sourceSha -InputPaths $sourceInputs
  } catch {
    if ($_.Exception.Message -eq 'CANDIDATE_IGNORED_FILES_PRESENT') { $ignoredRejected = $true } else { throw }
  }
} finally {
  if (Test-Path -LiteralPath $ignoredFile) { Remove-Item -LiteralPath $ignoredFile -Force }
}
if (-not $ignoredRejected) { throw 'Ignored server candidate file was not rejected' }
Write-Output '[PASS] Server candidate ignored-file rejection'
if (Test-Path -LiteralPath $root) { throw 'Fixture already exists; refusing overwrite' }
if (@([BridgeNativeMetadata]::Listeners(17485)).Count -ne 0) { throw 'Port 17485 occupied; refusing unrelated process' }

$activePid = 0
$activeStart = $null
$old = $null
$oldStdoutTask = $null
$oldStderrTask = $null
$testError = $null
$cleanupError = $null
function WaitPort([int]$ProcessId) {
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    $items = @([BridgeNativeMetadata]::Listeners(17485))
    if ($items.Count -eq 1 -and $items[0] -eq ('127.0.0.1|' + $ProcessId)) { return }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Server listener did not become ready' }
    Start-Sleep -Milliseconds 150
  } while ($true)
}
function AssertExtensionOriginAccepted {
  $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:17485/bridge/poll')
  $request.Method = 'OPTIONS'
  $request.Headers.Add('Origin', 'chrome-extension://nhflbnfcaicihaepdcjacdmaddagcmcj')
  $request.Timeout = 5000
  $response = $null
  $status = 0
  try {
    $response = [Net.HttpWebResponse]$request.GetResponse()
    $status = [int]$response.StatusCode
  } catch [Net.WebException] {
    if ($_.Exception.Response) {
      $response = [Net.HttpWebResponse]$_.Exception.Response
      $status = [int]$response.StatusCode
    } else { throw }
  } finally {
    if ($response) { $response.Close() }
  }
  if ($status -ne 204) {
    throw ('Expected Lab extension Origin preflight HTTP 204, received HTTP ' + $status)
  }
}
function RunUpdater([hashtable]$NamedArgs) {
  $result = @(& $updater @NamedArgs 2>&1)
  if ($LASTEXITCODE -ne 0) { throw ('Updater failed: ' + ($result -join ' ')) }
  return $result
}
function InvokeNodeHealth([string]$ScriptPath,[string]$JobPath,[string]$WorkingDirectory) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '"' + $ScriptPath + '" "' + $JobPath + '"'
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $psi
  try {
    if (-not $process.Start()) { throw 'Could not start test MCP health probe' }
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(12000)) { throw 'Test MCP health probe timed out' }
    $stdout = [string]$outTask.GetAwaiter().GetResult()
    $stderr = [string]$errTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      throw ('Test MCP health probe failed; exitCode=' + $process.ExitCode + '; stdout=' + $stdout + '; stderr=' + $stderr)
    }
    return $stdout
  } finally {
    if (-not $process.HasExited) {
      try { $process.Kill(); $null = $process.WaitForExit(3000) } catch {}
    }
    $process.Dispose()
  }
}
function CurrentOwner {
  $items = @([BridgeNativeMetadata]::Listeners(17485))
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
    # Deliberately stale but syntactically valid ID: the cutover launcher must honor its pinned process override.
    extensionId = 'ehmllfabjbfcinaigionjggbgonkokfg'
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
  $psi.EnvironmentVariables['CHROME_BRIDGE_PORT'] = '17485'
  $psi.EnvironmentVariables['CHROME_BRIDGE_EXTENSION_ID'] = 'nhflbnfcaicihaepdcjacdmaddagcmcj'
  $psi.EnvironmentVariables.Remove('CHROME_BRIDGE_CODEX_POLICY')
  $old = New-Object Diagnostics.Process
  $old.StartInfo = $psi
  if (-not $old.Start()) { throw 'Legacy fixture process did not start' }
  $oldStdoutTask = $old.StandardOutput.ReadToEndAsync()
  $oldStderrTask = $old.StandardError.ReadToEndAsync()
  WaitPort $old.Id
  $oldMeta = Get-BridgeHandleIdentity $old
  # Safe fixture-only diagnostic: this process was launched by this test with no secrets in its command line.
  Write-Output ('[FIXTURE_IDENTITY] pid=' + $oldMeta.id + '; executable=' + $oldMeta.executable + '; command=' + $oldMeta.command)
  $expectedFixtureEntry = (Join-Path $root 'server\bridge.mjs').Replace('/','\')
  if (([string]$oldMeta.command).Replace('/','\').IndexOf($expectedFixtureEntry,[StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw ('Fixture command mismatch; expected=' + $expectedFixtureEntry + '; actual=' + $oldMeta.command)
  }
  if (([string]$oldMeta.workingDirectory) -ine $root) { throw 'Process working-directory identity mismatch' }
  if (([string]$oldMeta.bridgeHome) -ine $state) { throw 'Process CHROME_BRIDGE_HOME identity mismatch' }
  if ([string]$oldMeta.bridgePort -cne '17485') { throw 'Process CHROME_BRIDGE_PORT identity mismatch' }
  if ([string]$oldMeta.extensionId -and [string]$oldMeta.extensionId -cne 'nhflbnfcaicihaepdcjacdmaddagcmcj') { throw 'Process extension ID identity mismatch' }
  $activePid = $old.Id
  $activeStart = $oldMeta.created

  $updaterArgs = @{
    LabRoot = $root
    StateRoot = $state
    ExpectedPid = [int]$activePid
    ExpectedStartUtc = $activeStart
    CandidateRoot = $packageRoot
    ExpectedSourceSha = $sourceSha
    TestFixture = $true
  }
  $before = (Get-FileHash (Join-Path $server 'bridge.mjs') -Algorithm SHA256).Hash
  $dry = RunUpdater $updaterArgs
  if (($dry -join ' ') -notmatch '\[DRY_RUN\]') { throw 'Server dry-run marker missing' }
  if ((Get-FileHash $configPath -Algorithm SHA256).Hash -ne $configHash) { throw 'Dry-run changed config' }
  if ((Get-FileHash (Join-Path $server 'bridge.mjs') -Algorithm SHA256).Hash -ne $before) { throw 'Dry-run changed server source' }
  WaitPort $activePid

  $applyArgs = @{}
  foreach ($key in $updaterArgs.Keys) { $applyArgs[$key] = $updaterArgs[$key] }
  $applyArgs['Apply'] = $true
  $applied = RunUpdater $applyArgs
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
  [IO.File]::WriteAllText($job,(@{mode='live';source=$root;state=$state;port=17485;expected=$expectedNew} | ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false)))
  $healthOutput = InvokeNodeHealth $health $job $packageRoot
  if ($healthOutput -notmatch '"ok":true') { throw ('Upgraded server health returned unexpected output: ' + $healthOutput) }
  AssertExtensionOriginAccepted
  Write-Output '[PASS] Stale State extensionId safely overridden by pinned Lab process environment'
  $newNames = @((Get-Content $expectedNew -Raw | ConvertFrom-Json).result.tools | ForEach-Object { $_.name })
  $newUniqueNames = @($newNames | Sort-Object -Unique)
  if ($newNames.Count -ne 30 -or $newUniqueNames.Count -ne 30) {
    throw ('New registry must contain exactly 30 unique tools; found ' + $newNames.Count)
  }
  foreach ($n in @('session_request','session_authorize','session_status','session_revoke','provider_prepare','provider_commit','provider_status','provider_reply_wait','provider_stop','provider_revoke','provider_events')) {
    if ($newNames -notcontains $n) { throw ('New registry missing ' + $n) }
  }

  $rollbackArgs = @{
    LabRoot = $root
    StateRoot = $state
    ExpectedPid = [int]$activePid
    ExpectedStartUtc = $activeStart
    CandidateRoot = $packageRoot
    ExpectedSourceSha = $sourceSha
    RollbackFrom = $backup
    TestFixture = $true
  }
  $rbDry = RunUpdater $rollbackArgs
  if (($rbDry -join ' ') -notmatch '\[DRY_RUN\]') { throw 'Rollback dry-run marker missing' }
  $rollbackApplyArgs = @{}
  foreach ($key in $rollbackArgs.Keys) { $rollbackApplyArgs[$key] = $rollbackArgs[$key] }
  $rollbackApplyArgs['Apply'] = $true
  $rb = RunUpdater $rollbackApplyArgs
  if (($rb -join ' ') -notmatch '\[ROLLED_BACK\]') { throw 'Rollback marker missing' }
  $activePid = CurrentOwner
  $p = [Diagnostics.Process]::GetProcessById($activePid)
  try { $activeStart = (Get-BridgeHandleIdentity $p).created } finally { $p.Dispose() }
  $expectedOld = Join-Path $env:RUNNER_TEMP 'pr102-server-rollback-tools.json'
  $oldCode = "import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  Push-Location $root
  try { & $node --input-type=module -e $oldCode $expectedOld; if ($LASTEXITCODE -ne 0) { throw 'Cannot build legacy registry' } } finally { Pop-Location }
  $job2 = Join-Path $env:RUNNER_TEMP 'pr102-server-rollback-health.json'
  [IO.File]::WriteAllText($job2,(@{mode='live';source=$root;state=$state;port=17485;expected=$expectedOld} | ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false)))
  $rollbackHealthOutput = InvokeNodeHealth $health $job2 $root
  if ($rollbackHealthOutput -notmatch '"ok":true') { throw ('Rolled-back server health returned unexpected output: ' + $rollbackHealthOutput) }
  AssertExtensionOriginAccepted
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
  # listener merely because it uses port 17485.
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
