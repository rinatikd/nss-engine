# PR102 Lab server cutover. Dry-run by default; never targets Production.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$LabRoot,
  [Parameter(Mandatory=$true)][string]$StateRoot,
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ExpectedPid,
  [Parameter(Mandatory=$true)][string]$ExpectedStartUtc,
  [string]$CandidateRoot = (Join-Path $PSScriptRoot '..'),
  [Parameter(Mandatory=$true)][string]$ExpectedSourceSha,
  [string]$RollbackFrom,
  [switch]$Apply,
  [switch]$TestFixture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$LabPort = 17484
$LabExtensionId = 'nhflbnfcaicihaepdcjacdmaddagcmcj'
. (Join-Path $PSScriptRoot 'process-identity.ps1')

function Require([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function FullPath([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Inside([string]$Child,[string]$Parent) {
  $c = (FullPath $Child) + '\'
  $p = (FullPath $Parent) + '\'
  return $c.StartsWith($p,[StringComparison]::OrdinalIgnoreCase)
}
function HashFile([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function ReadJson([string]$Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function WriteJson([string]$Path,$Value) {
  [IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine,(New-Object System.Text.UTF8Encoding($false)))
}
function TreeHash([string]$Path) {
  $rows = @()
  foreach ($f in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
    if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Reparse point refused: ' + $f.FullName) }
    if (-not $f.PSIsContainer) {
      $rel = $f.FullName.Substring((FullPath $Path).Length + 1).Replace('\','/')
      $rows += ($rel + ':' + (HashFile $f.FullName))
    }
  }
  return (($rows | Sort-Object) -join '|')
}
function AssertListener([int]$Pid) {
  $listeners = @([BridgeNativeMetadata]::Listeners($LabPort))
  Require ($listeners.Count -eq 1) ('Expected one listener on 17484, found ' + $listeners.Count)
  Require ($listeners[0] -eq ('127.0.0.1|' + $Pid)) ('17484 listener does not belong to expected PID; owner=' + $listeners[0])
}
function PinProcess([int]$Pid,[string]$ExpectedStart,[string]$Root) {
  $p = [Diagnostics.Process]::GetProcessById($Pid)
  $null = $p.Handle
  try {
    $identity = Get-BridgeHandleIdentity $p
    Require ($identity.executable -match '(?i)\\node\.exe$') 'Lab listener is not Node.js'
    $actualStart = [DateTime]::Parse($identity.created).ToUniversalTime()
    $expected = [DateTime]::Parse($ExpectedStart).ToUniversalTime()
    Require ([Math]::Abs(($actualStart-$expected).TotalMilliseconds) -le 2) 'PID start-time mismatch; refusing PID reuse'
    $actualCommand = ([string]$identity.command).Replace('/','\')
    $expectedEntry = (Join-Path $Root 'server\bridge.mjs').Replace('/','\')
    Require ($actualCommand.IndexOf($expectedEntry,[StringComparison]::OrdinalIgnoreCase) -ge 0) 'Listener command line does not point to the pinned PR102 Lab server'
    AssertListener $Pid
    return @{process=$p;identity=$identity}
  } catch {
    $p.Dispose()
    throw
  }
}
function CopyServer([string]$Source,[string]$Destination) {
  Require (Test-Path -LiteralPath (Join-Path $Source 'bridge.mjs') -PathType Leaf) 'bridge.mjs missing'
  Require (Test-Path -LiteralPath (Join-Path $Source 'tools.mjs') -PathType Leaf) 'tools.mjs missing'
  $items = @(Get-ChildItem -LiteralPath $Source -Recurse -Force)
  foreach ($item in $items) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Reparse point in candidate server: ' + $item.FullName) }
    if ($item.Name -match '^(config|secrets?|credentials?|agents|provider-journal|send-journal)\.(json|ya?ml|txt)$' -or
        $item.Extension -in @('.pem','.pfx','.p12','.key','.log')) {
      throw ('State/credential-shaped file refused in candidate: ' + $item.Name)
    }
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
}
function WriteExpectedTools([string]$ServerRoot,[string]$OutputFile,[string]$NodeExe) {
  $code = "import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  Push-Location $ServerRoot
  try {
    & $NodeExe --input-type=module -e $code $OutputFile
    Require ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $OutputFile -PathType Leaf)) 'Could not generate expected MCP tools registry'
  } finally { Pop-Location }
}
function Probe([string]$HealthScript,[string]$ServerRoot,[string]$State,[string]$ExpectedFile,[string]$RunDir,[string]$Mode) {
  $job = Join-Path $RunDir ('health-' + $Mode + '.json')
  WriteJson $job @{mode=$Mode;source=$ServerRoot;state=$State;port=$LabPort;expected=$ExpectedFile}
  & $script:NodeExe $HealthScript $job
  Require ($LASTEXITCODE -eq 0) ('MCP health probe failed: ' + $Mode)
}
function StartLabServer([string]$ServerRoot,[string]$State,[string]$RunDir,[string]$ConfigHash) {
  $startJob = Join-Path $RunDir ('start-' + [guid]::NewGuid().ToString('N') + '.json')
  WriteJson $startJob @{source=$ServerRoot;state=$State;port=$LabPort;configHash=$ConfigHash}
  $startScript = Join-Path $RunDir 'cutover-start.mjs'
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe
  $psi.Arguments = '"' + $startScript + '" "' + $startJob + '"'
  $psi.WorkingDirectory = $ServerRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables['CHROME_BRIDGE_HOME'] = $State
  $psi.EnvironmentVariables['CHROME_BRIDGE_PORT'] = [string]$LabPort
  $psi.EnvironmentVariables.Remove('CHROME_BRIDGE_CODEX_POLICY')
  $psi.EnvironmentVariables.Remove('NODE_OPTIONS')
  $psi.EnvironmentVariables.Remove('NODE_PATH')
  $proc = New-Object Diagnostics.Process
  $proc.StartInfo = $psi
  Require ($proc.Start()) 'Could not start Lab Bridge process'
  $stdout = Join-Path $RunDir ('server-' + $proc.Id + '.stdout.log')
  $stderr = Join-Path $RunDir ('server-' + $proc.Id + '.stderr.log')
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  return @{process=$proc;stdoutTask=$outTask;stderrTask=$errTask;stdout=$stdout;stderr=$stderr}
}
function WaitHealthy($Started,[string]$ServerRoot,[string]$State,[string]$ExpectedFile,[string]$HealthScript,[string]$RunDir) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Require (-not $Started.process.HasExited) 'Candidate Bridge process exited during startup'
    try {
      AssertListener $Started.process.Id
      Probe $HealthScript $ServerRoot $State $ExpectedFile $RunDir 'live'
      $Started.stdoutTask.Result | Set-Content -LiteralPath $Started.stdout -Encoding UTF8
      $Started.stderrTask.Result | Set-Content -LiteralPath $Started.stderr -Encoding UTF8
      return
    } catch {
      if ([DateTime]::UtcNow -ge $deadline) { throw }
      Start-Sleep -Milliseconds 250
    }
  } while ($true)
}
function StopPinned($Proc) {
  if ($Proc -and -not $Proc.HasExited) {
    $null = $Proc.Handle
    $Proc.Kill()
    if (-not $Proc.WaitForExit(8000)) { throw 'Owned Bridge process did not stop' }
  }
}
function StartFromCurrentServer([string]$State,[string]$RunDir,[string]$ConfigHash) {
  $start = StartLabServer $root $State $RunDir $ConfigHash
  WaitHealthy $start $root $State $script:ExpectedTools $script:HealthScript $RunDir
  return $start
}

$root = FullPath $LabRoot
$state = FullPath $StateRoot
$candidateRoot = FullPath $CandidateRoot
if ($TestFixture) {
  $runnerTemp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP')
  Require (-not [string]::IsNullOrWhiteSpace($runnerTemp)) 'TestFixture requires RUNNER_TEMP'
  Require (Inside $root $runnerTemp) 'Test fixture must be below RUNNER_TEMP'
  Require ((Split-Path $root -Leaf) -eq 'ChromeBridge-PR102-17484-Lab-Server-TestFixture') 'Unexpected synthetic Lab fixture'
  Require (Inside $state $root) 'Test fixture state must remain inside Lab root'
} else {
  Require ($root -ieq 'C:\Engineering\ChromeBridge-PR102-17484-Lab') 'Only the exact PR102 Lab root may be targeted'
  Require (Inside $state $root) 'Lab state must remain inside PR102 Lab root'
}
Require ((Split-Path $candidateRoot -Leaf) -eq 'chrome-bridge-v20') 'Candidate root must be the pinned chrome-bridge-v20 source tree'
Require (Test-Path -LiteralPath (Join-Path $candidateRoot 'server\bridge.mjs') -PathType Leaf) 'Candidate server source missing'
Require (Test-Path -LiteralPath (Join-Path $candidateRoot 'deployment\cutover-start.mjs') -PathType Leaf) 'Cutover launcher missing'
Require (Test-Path -LiteralPath (Join-Path $candidateRoot 'deployment\cutover-health.mjs') -PathType Leaf) 'Health probe missing'
Require ((Get-Command git -ErrorAction Stop).Source) 'Git unavailable'
$actualSha = (& git -C $candidateRoot rev-parse HEAD).Trim()
Require ($LASTEXITCODE -eq 0 -and $actualSha -eq $ExpectedSourceSha.ToLowerInvariant()) 'Candidate Git SHA mismatch'
$serverRoot = Join-Path $root 'server'
Require (Test-Path -LiteralPath $serverRoot -PathType Container) 'Existing Lab server directory missing'
Require (Test-Path -LiteralPath (Join-Path $state 'config.json') -PathType Leaf) 'Existing Lab config.json missing; refusing to create or replace credentials'
$configPath = Join-Path $state 'config.json'
$configHashBefore = HashFile $configPath
$config = ReadJson $configPath
Require ($config.extensionId -eq $LabExtensionId) 'State config is not pinned to the PR102 Lab extension ID'
Require (($config.agentToken -is [string]) -and ($config.browserToken -is [string])) 'Existing Lab config lacks required tokens'
Require ($config.agentToken.Length -ge 32 -and $config.browserToken.Length -ge 32) 'Existing Lab token material is invalid'
$script:NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$script:HealthScript = Join-Path $candidateRoot 'deployment\cutover-health.mjs'
$nodeVersion = (& $script:NodeExe --version).Trim()
Require ($LASTEXITCODE -eq 0) 'Node version probe failed'

$identity = PinProcess $ExpectedPid $ExpectedStartUtc $root
$oldProc = $identity.process
$oldIdentity = $identity.identity
$run = Join-Path $root ('.server-upgrade-' + [guid]::NewGuid().ToString('N'))
$stageServerRoot = Join-Path $run 'candidate'
$backupRoot = $null
$script:ExpectedTools = Join-Path $run 'expected-tools.json'
$oldExpectedTools = Join-Path $run 'old-tools.json'
$script:NodeExe = $script:NodeExe
New-Item -ItemType Directory -Path $run -Force | Out-Null
$script:HealthScript = Join-Path $candidateRoot 'deployment\cutover-health.mjs'
try {
  $stageServer = Join-Path $stageServerRoot 'server'
  New-Item -ItemType Directory -Path $stageServerRoot -Force | Out-Null
  CopyServer (Join-Path $candidateRoot 'server') $stageServer
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'deployment\cutover-start.mjs') -Destination (Join-Path $stageServerRoot 'cutover-start.mjs') -Force
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'deployment\cutover-health.mjs') -Destination (Join-Path $stageServerRoot 'cutover-health.mjs') -Force

  foreach ($file in Get-ChildItem -LiteralPath $stageServer -Recurse -File -Filter '*.mjs') {
    & $script:NodeExe --check $file.FullName
    Require ($LASTEXITCODE -eq 0) ('Node syntax error: ' + $file.Name)
  }
  WriteExpectedTools $stageServerRoot $script:ExpectedTools $script:NodeExe
  $names = @((ReadJson $script:ExpectedTools).result.tools | ForEach-Object { $_.name })
  foreach ($required in @('session_request','session_authorize','session_status','session_revoke','provider_prepare','provider_commit','provider_status','provider_stop','provider_revoke','provider_events')) {
    Require ($names -contains $required) ('Required Session/Provider tool missing: ' + $required)
  }
  Probe (Join-Path $stageServerRoot 'cutover-health.mjs') $stageServerRoot $state $script:ExpectedTools $run 'isolated'

  $oldServerHash = TreeHash $serverRoot
  $candidateServerHash = TreeHash $stageServer
  Require ($candidateServerHash.Length -gt 0) 'Candidate server hash is empty'
  Write-Output ('[TARGET] PR102 Lab only; port=' + $LabPort)
  Write-Output ('[OWNER_PID] ' + $oldIdentity.id)
  Write-Output ('[OWNER_CREATED_UTC] ' + $oldIdentity.created)
  Write-Output ('[OWNER_EXE] ' + $oldIdentity.executable)
  Write-Output ('[OLD_SERVER_SHA256_TREE] ' + $oldServerHash)
  Write-Output ('[CANDIDATE_SERVER_SHA256_TREE] ' + $candidateServerHash)
  Write-Output ('[STATE_CONFIG_SHA256] ' + $configHashBefore)
  Write-Output ('[SOURCE_SHA] ' + $actualSha)
  Write-Output ('[NODE] ' + $nodeVersion)
  if ($RollbackFrom) {
    $backupRoot = FullPath $RollbackFrom
    Require (Inside $backupRoot (Join-Path $root 'backups')) 'Rollback source must be inside PR102 Lab backups'
    $markerPath = Join-Path $backupRoot 'server-backup.json'
    Require (Test-Path -LiteralPath $markerPath -PathType Leaf) 'Server backup marker missing'
    $marker = ReadJson $markerPath
    Require ($marker.schema -eq 'chrome-bridge-pr102-lab-server-backup-v1' -and $marker.port -eq 17484) 'Server backup marker mismatch'
    Require ((FullPath ([string]$marker.labRoot)) -ieq $root) 'Server backup belongs to another Lab root'
    Require ((FullPath ([string]$marker.stateRoot)) -ieq $state) 'Server backup belongs to another state directory'
    Require ((HashFile $configPath) -eq [string]$marker.stateConfigSha256) 'Lab config changed since server backup'
    $rollbackServer = Join-Path $backupRoot 'server'
    Require (Test-Path -LiteralPath (Join-Path $rollbackServer 'bridge.mjs') -PathType Leaf) 'Rollback server is missing bridge.mjs'
    Require ((TreeHash $rollbackServer) -eq [string]$marker.serverTreeSha256) 'Rollback server hash mismatch'
    if (-not $Apply) { Write-Output '[ROLLBACK_DRY_RUN] Verified backup; no files or processes changed.'; return }
  } else {
    $backupParent = Join-Path $root 'backups'
    New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
    $backupRoot = Join-Path $backupParent ('server-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Copy-Item -LiteralPath $serverRoot -Destination (Join-Path $backupRoot 'server') -Recurse -Force
    $marker = [ordered]@{
      schema='chrome-bridge-pr102-lab-server-backup-v1'
      target='PR102_LAB'
      port=17484
      labRoot=$root
      stateRoot=$state
      createdUtc=[DateTime]::UtcNow.ToString('o')
      stateConfigSha256=$configHashBefore
      serverTreeSha256=$oldServerHash
      ownerPid=$oldIdentity.id
      ownerCreatedUtc=$oldIdentity.created
      sourceSha=$actualSha
    }
    WriteJson (Join-Path $backupRoot 'server-backup.json') $marker
    if (-not $Apply) {
      Write-Output '[DRY_RUN] Server package and rollback snapshot validated; no files or processes changed.'
      Write-Output ('[BACKUP_PLAN] ' + $backupRoot)
      return
    }
  }

  Require ((HashFile $configPath) -eq $configHashBefore) 'Lab config changed after preflight'
  AssertListener $ExpectedPid
  $fresh = PinProcess $ExpectedPid $ExpectedStartUtc $root
  try {
    Require ($fresh.identity.command -ceq $oldIdentity.command) 'Lab listener command line changed during preflight'
    Require ((TreeHash $serverRoot) -eq $oldServerHash) 'Installed Lab server changed during preflight'
  } finally { $fresh.process.Dispose() }

  $null = $oldProc.Handle
  $oldProc.Kill()
  Require ($oldProc.WaitForExit(8000)) 'Original Lab Bridge process did not stop'
  $listenersAfterStop = @([BridgeNativeMetadata]::Listeners($LabPort))
  Require ($listenersAfterStop.Count -eq 0) 'Port 17484 remained occupied after stopping the pinned owner'

  $displaced = Join-Path $root ('.server-displaced-' + [guid]::NewGuid().ToString('N'))
  $candidateReady = Join-Path $root ('.server-ready-' + [guid]::NewGuid().ToString('N'))
  $started = $null
  try {
    Move-Item -LiteralPath $serverRoot -Destination $displaced -ErrorAction Stop
    Move-Item -LiteralPath $stageServer -Destination $serverRoot -ErrorAction Stop
    $candidateParent = Join-Path $run 'active-source'
    New-Item -ItemType Directory -Path $candidateParent -Force | Out-Null
    # The launcher imports <source>/server/bridge.mjs. Point source to the Lab root.
    $started = StartLabServer $root $state $run $configHashBefore
    WaitHealthy $started $root $state $script:ExpectedTools $script:HealthScript $run
    Require ((HashFile $configPath) -eq $configHashBefore) 'Lab config mutated during server startup'
    Remove-Item -LiteralPath $displaced -Recurse -Force
    Write-Output '[UPGRADED] PR102 Lab server is running with the new Session/Provider registry.'
    Write-Output ('[NEW_PID] ' + $started.process.Id)
    Write-Output ('[BACKUP] ' + $backupRoot)
    Write-Output '[NEXT] Reload only the PR102 Lab extension, then refresh/reconnect the ChatGPT Lab connector.'
  } catch {
    if ($started -and -not $started.process.HasExited) { StopPinned $started.process }
    if (Test-Path -LiteralPath $serverRoot) { Remove-Item -LiteralPath $serverRoot -Recurse -Force }
    if (Test-Path -LiteralPath $displaced) { Move-Item -LiteralPath $displaced -Destination $serverRoot -ErrorAction Stop }
    $rollbackStarted = StartLabServer $root $state $run $configHashBefore
    $oldToolsFile = Join-Path $run 'old-tools.json'
    WriteExpectedTools $root $oldToolsFile $script:NodeExe
    WaitHealthy $rollbackStarted $root $state $oldToolsFile $script:HealthScript $run
    Write-Output '[AUTO_ROLLBACK] Previous PR102 Lab server restored and healthy.'
    throw ('Upgrade failed; old server automatically restored: ' + $_.Exception.Message)
  }
} finally {
  if ($oldProc) { $oldProc.Dispose() }
  if (Test-Path -LiteralPath $run) {
    # Keep logs and evidence after apply; remove disposable staging on dry-run only.
    if (-not $Apply) { Remove-Item -LiteralPath $run -Recurse -Force }
  }
}
