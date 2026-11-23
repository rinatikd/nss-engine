# PR102 Lab server cutover. Dry-run by default; never targets Production.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$LabRoot,
  [Parameter(Mandatory=$true)][string]$StateRoot,
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ExpectedPid,
  [Parameter(Mandatory=$true)][string]$ExpectedStartUtc,
  [string]$CandidateRoot = (Join-Path $PSScriptRoot '..'),
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}
  [string]$RollbackFrom,
  [switch]$Apply,
  [switch]$TestFixture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$LabPort = 17484
$LabExtensionId = 'nhflbnfcaicihaepdcjacdmaddagcmcj'
. (Join-Path $PSScriptRoot 'process-identity.ps1')
. (Join-Path $PSScriptRoot 'verify-candidate-source.ps1')

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
function AssertListener([int]$ProcessId) {
  $listeners = @([BridgeNativeMetadata]::Listeners($LabPort))
  Require ($listeners.Count -eq 1) ('Expected one listener on 17484, found ' + $listeners.Count)
  Require ($listeners[0] -eq ('127.0.0.1|' + $ProcessId)) ('17484 listener does not belong to expected PID; owner=' + $listeners[0])
}
function PinProcess([int]$ProcessId,[string]$ExpectedStart,[string]$Root,[string]$State,[string]$ConfigHash) {
  $p = [Diagnostics.Process]::GetProcessById($ProcessId)
  $null = $p.Handle
  try {
    $identity = Get-BridgeHandleIdentity $p
    Require ($identity.executable -match '(?i)\\node\.exe$') 'Lab listener is not Node.js'
    $actualStart = [DateTime]::Parse($identity.created).ToUniversalTime()
    $expected = [DateTime]::Parse($ExpectedStart).ToUniversalTime()
    Require ([Math]::Abs(($actualStart-$expected).TotalMilliseconds) -le 2) 'PID start-time mismatch; refusing PID reuse'
    $actualCommand = ([string]$identity.command).Replace('/','\')
    $expectedEntry = (Join-Path $Root 'server\bridge.mjs').Replace('/','\')
    $directServer = $actualCommand.IndexOf($expectedEntry,[StringComparison]::OrdinalIgnoreCase) -ge 0
    $transactionLauncher = $false

    if (-not $directServer) {
      # A transaction-launched server is accepted only when the exact launcher
      # and sibling job prove this Lab root, state root, port and config hash.
      $argumentMatch = [regex]::Match(
        $actualCommand,
        '^"(?<exe>[^"]+)"\s+"(?<script>[^"]+\\cutover-start\.mjs)"\s+"(?<job>[^"]+\\start-[0-9a-f]{32}\.json)"$',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
      )
      if ($argumentMatch.Success) {
        $exePath = FullPath $argumentMatch.Groups['exe'].Value
        $scriptPath = FullPath $argumentMatch.Groups['script'].Value
        $jobPath = FullPath $argumentMatch.Groups['job'].Value
        $scriptDir = FullPath (Split-Path -Parent $scriptPath)
        $jobDir = FullPath (Split-Path -Parent $jobPath)
        $runName = Split-Path -Leaf $scriptDir
        $sameTransaction = $scriptDir -ieq $jobDir
        $insideLab = (Inside $scriptPath $Root) -and (Inside $jobPath $Root)
        $validRunName = $runName -match '^\.server-upgrade-[0-9a-f]{32}$'
        $pinnedNames = ((Split-Path -Leaf $scriptPath) -ieq 'cutover-start.mjs') -and
          ((Split-Path -Leaf $jobPath) -match '(?i)^start-[0-9a-f]{32}\.json$')
        $sameNode = $exePath -ieq (FullPath $script:NodeExe)
        if ($sameTransaction -and $insideLab -and $validRunName -and $pinnedNames -and $sameNode -and
            (Test-Path -LiteralPath $scriptPath -PathType Leaf) -and
            (Test-Path -LiteralPath $jobPath -PathType Leaf)) {
          $startJob = ReadJson $jobPath
          $jobSource = FullPath ([string]$startJob.source)
          $jobState = FullPath ([string]$startJob.state)
          $jobHash = [string]$startJob.configHash
          $currentHash = HashFile (Join-Path $State 'config.json')
          $transactionLauncher = ($jobSource -ieq (FullPath $Root)) -and
            ($jobState -ieq (FullPath $State)) -and
            ([int]$startJob.port -eq 17484) -and
            ($jobHash -eq $ConfigHash) -and ($jobHash -eq $currentHash)
        }
      }
    }

    Require ($directServer -or $transactionLauncher) 'Lab listener command line is neither pinned bridge.mjs nor a verified PR102 Lab transaction launcher'
    AssertListener $ProcessId
    return @{process=$p;identity=$identity;kind=$(if ($directServer) {'bridge'} else {'transaction-launcher'})}
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
function WriteExpectedTools([string]$SourceRoot,[string]$OutputFile,[string]$NodeExe) {
  $code = "import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  Push-Location $SourceRoot
  try {
    & $NodeExe --input-type=module -e $code $OutputFile
    Require ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $OutputFile -PathType Leaf)) 'Could not generate expected MCP tools registry'
  } finally { Pop-Location }
}
function Probe([string]$HealthScript,[string]$SourceRoot,[string]$State,[string]$ExpectedFile,[string]$RunDir,[string]$Mode) {
  $job = Join-Path $RunDir ('health-' + $Mode + '.json')
  WriteJson $job @{mode=$Mode;source=$SourceRoot;state=$State;port=$LabPort;expected=$ExpectedFile}
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe
  $psi.Arguments = '"' + $HealthScript + '" "' + $job + '"'
  $psi.WorkingDirectory = $SourceRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $probe = New-Object Diagnostics.Process
  $probe.StartInfo = $psi
  try {
    Require ($probe.Start()) 'Could not start MCP health probe'
    $stdoutTask = $probe.StandardOutput.ReadToEndAsync()
    $stderrTask = $probe.StandardError.ReadToEndAsync()
    Require ($probe.WaitForExit(12000)) 'MCP health probe timed out'
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    Require ($probe.ExitCode -eq 0) ('MCP health probe failed: ' + $Mode + '; stdout=' + $stdout + '; stderr=' + $stderr)
    if ($stdout) { Write-Output $stdout.Trim() }
  } finally {
    if ($probe -and -not $probe.HasExited) {
      try { $probe.Kill(); $null = $probe.WaitForExit(3000) } catch {}
    }
    $probe.Dispose()
  }
}
function StartLabServer([string]$State,[string]$RunDir,[string]$ConfigHash) {
  $startJob = Join-Path $RunDir ('start-' + [guid]::NewGuid().ToString('N') + '.json')
  WriteJson $startJob @{source=$script:LabRoot;state=$State;port=$LabPort;configHash=$ConfigHash}
  $startScript = Join-Path $RunDir 'cutover-start.mjs'
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe
  $psi.Arguments = '"' + $startScript + '" "' + $startJob + '"'
  $psi.WorkingDirectory = $script:LabRoot
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
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  return @{process=$proc;stdoutTask=$outTask;stderrTask=$errTask}
}
function WaitHealthy($Started,[string]$State,[string]$ExpectedFile,[string]$RunDir) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if ($Started.process.HasExited) {
      $stdout = ''
      $stderr = ''
      try { if ($Started.stdoutTask) { $stdout = [string]$Started.stdoutTask.GetAwaiter().GetResult() } } catch {}
      try { if ($Started.stderrTask) { $stderr = [string]$Started.stderrTask.GetAwaiter().GetResult() } } catch {}
      $detail = ('Candidate Bridge exited during startup; exitCode=' + $Started.process.ExitCode +
        '; stdout=' + $stdout + '; stderr=' + $stderr)
      throw $detail
    }
    try {
      AssertListener $Started.process.Id
      Probe $script:HealthScript $script:LabRoot $State $ExpectedFile $RunDir 'live'
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
function CreateBackup([string]$CurrentServer,[string]$Root,[string]$State,[string]$ConfigHash,[string]$CurrentTreeHash,[string]$SourceSha,[string]$RunDir) {
  $backupParent = Join-Path $Root 'backups'
  New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
  $backup = Join-Path $backupParent ('server-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Copy-Item -LiteralPath $CurrentServer -Destination (Join-Path $backup 'server') -Recurse -Force
  Require ((TreeHash (Join-Path $backup 'server')) -eq $CurrentTreeHash) 'Backup tree hash mismatch'
  WriteJson (Join-Path $backup 'server-backup.json') @{
    schema='chrome-bridge-pr102-lab-server-backup-v1';target='PR102_LAB';port=17484;
    labRoot=$Root;stateRoot=$State;createdUtc=[DateTime]::UtcNow.ToString('o');
    stateConfigSha256=$ConfigHash;serverTreeSha256=$CurrentTreeHash;sourceSha=$SourceSha
  }
  return $backup
}

$root = FullPath $LabRoot
$state = FullPath $StateRoot
$candidateRoot = FullPath $CandidateRoot
$script:LabRoot = $root
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
$sourceInputs = @(
  'server',
  'deployment/cutover-health.mjs',
  'deployment/cutover-start.mjs',
  'deployment/process-identity.ps1',
  'deployment/verify-candidate-source.ps1',
  'deployment/upgrade-pr102-lab-server.ps1'
)
$actualSha = Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $ExpectedSourceSha -InputPaths $sourceInputs
$serverRoot = Join-Path $root 'server'
Require (Test-Path -LiteralPath $serverRoot -PathType Container) 'Existing Lab server directory missing'
$configPath = Join-Path $state 'config.json'
Require (Test-Path -LiteralPath $configPath -PathType Leaf) 'Existing Lab config.json missing; refusing to create or replace credentials'
$configHashBefore = HashFile $configPath
$config = ReadJson $configPath
Require ($config.extensionId -eq $LabExtensionId) 'State config is not pinned to the PR102 Lab extension ID'
Require (($config.agentToken -is [string]) -and ($config.browserToken -is [string])) 'Existing Lab config lacks required tokens'
Require ($config.agentToken.Length -ge 32 -and $config.browserToken.Length -ge 32) 'Existing Lab token material is invalid'
$script:NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $script:NodeExe --version).Trim()
Require ($LASTEXITCODE -eq 0) 'Node version probe failed'

$identity = PinProcess $ExpectedPid $ExpectedStartUtc $root $state $configHashBefore
$oldProc = $identity.process
$oldIdentity = $identity.identity
$oldTreeHash = TreeHash $serverRoot
$run = Join-Path $root ('.server-upgrade-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$stageRoot = Join-Path $run 'candidate'
$stageServer = Join-Path $stageRoot 'server'
$healthScript = Join-Path $run 'cutover-health.mjs'
$startScript = Join-Path $run 'cutover-start.mjs'
$script:HealthScript = $healthScript
$expectedTools = Join-Path $run 'expected-tools.json'
$oldExpectedTools = Join-Path $run 'old-tools.json'
$started = $null
$backupRoot = $null
$displaced = $null

try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'deployment\cutover-health.mjs') -Destination $healthScript -Force
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'deployment\cutover-start.mjs') -Destination $startScript -Force

  if ($RollbackFrom) {
    $requestedBackup = FullPath $RollbackFrom
    Require (Inside $requestedBackup (Join-Path $root 'backups')) 'Rollback source must be inside PR102 Lab backups'
    $markerPath = Join-Path $requestedBackup 'server-backup.json'
    Require (Test-Path -LiteralPath $markerPath -PathType Leaf) 'Server backup marker missing'
    $marker = ReadJson $markerPath
    Require ($marker.schema -eq 'chrome-bridge-pr102-lab-server-backup-v1' -and $marker.target -eq 'PR102_LAB' -and $marker.port -eq 17484) 'Server backup marker mismatch'
    Require ((FullPath ([string]$marker.labRoot)) -ieq $root) 'Server backup belongs to another Lab root'
    Require ((FullPath ([string]$marker.stateRoot)) -ieq $state) 'Server backup belongs to another state directory'
    Require ((HashFile $configPath) -eq [string]$marker.stateConfigSha256) 'Lab config changed since server backup'
    $rollbackServer = Join-Path $requestedBackup 'server'
    Require (Test-Path -LiteralPath (Join-Path $rollbackServer 'bridge.mjs') -PathType Leaf) 'Rollback server is missing bridge.mjs'
    Require ((TreeHash $rollbackServer) -eq [string]$marker.serverTreeSha256) 'Rollback server hash mismatch'
    CopyServer $rollbackServer $stageServer
  } else {
    CopyServer (Join-Path $candidateRoot 'server') $stageServer
  }

  foreach ($file in Get-ChildItem -LiteralPath $stageServer -Recurse -File -Filter '*.mjs') {
    & $script:NodeExe --check $file.FullName
    Require ($LASTEXITCODE -eq 0) ('Node syntax error: ' + $file.Name)
  }
  WriteExpectedTools $stageRoot $expectedTools $script:NodeExe
  $toolNames = @((ReadJson $expectedTools).result.tools | ForEach-Object { $_.name })
  if (-not $RollbackFrom) {
    foreach ($required in @('session_request','session_authorize','session_status','session_revoke','provider_prepare','provider_commit','provider_status','provider_stop','provider_revoke','provider_events')) {
      Require ($toolNames -contains $required) ('Required Session/Provider tool missing: ' + $required)
    }
  }
  WriteExpectedTools $root $oldExpectedTools $script:NodeExe
  Probe $healthScript $stageRoot $state $expectedTools $run 'isolated'

  $stageHash = TreeHash $stageServer
  Require ($stageHash.Length -gt 0) 'Candidate server tree hash is empty'
  Write-Output ('[TARGET] PR102 Lab only; port=' + $LabPort)
  Write-Output ('[OWNER_PID] ' + $oldIdentity.id)
  Write-Output ('[OWNER_CREATED_UTC] ' + $oldIdentity.created)
  Write-Output ('[OWNER_EXE] ' + $oldIdentity.executable)
  Write-Output ('[OLD_SERVER_SHA256_TREE] ' + $oldTreeHash)
  Write-Output ('[STAGED_SERVER_SHA256_TREE] ' + $stageHash)
  Write-Output ('[STATE_CONFIG_SHA256] ' + $configHashBefore)
  Write-Output ('[SOURCE_SHA] ' + $actualSha)
  Write-Output ('[NODE] ' + $nodeVersion)

  if (-not $Apply) {
    Write-Output '[DRY_RUN] Server and isolated MCP registry validated; no files or processes changed.'
    return
  }

  if (-not $RollbackFrom) {
    $backupRoot = CreateBackup $serverRoot $root $state $configHashBefore $oldTreeHash $actualSha $run
  } else {
    $backupRoot = CreateBackup $serverRoot $root $state $configHashBefore $oldTreeHash $actualSha $run
  }
  Require ((HashFile $configPath) -eq $configHashBefore) 'Lab config changed after preflight'
  $fresh = PinProcess $ExpectedPid $ExpectedStartUtc $root $state $configHashBefore
  try {
    Require ($fresh.identity.command -ceq $oldIdentity.command) 'Lab listener command line changed during preflight'
    Require ((TreeHash $serverRoot) -eq $oldTreeHash) 'Installed Lab server changed during preflight'
  } finally { $fresh.process.Dispose() }

  $null = $oldProc.Handle
  $oldProc.Kill()
  Require ($oldProc.WaitForExit(8000)) 'Original Lab Bridge process did not stop'
  Require (@([BridgeNativeMetadata]::Listeners($LabPort)).Count -eq 0) 'Port 17484 remained occupied after stopping the pinned owner'

  $displaced = Join-Path $root ('.server-displaced-' + [guid]::NewGuid().ToString('N'))
  try {
    Move-Item -LiteralPath $serverRoot -Destination $displaced -ErrorAction Stop
    Move-Item -LiteralPath $stageServer -Destination $serverRoot -ErrorAction Stop
    $started = StartLabServer $state $run $configHashBefore
    WaitHealthy $started $state $expectedTools $run
    Require ((HashFile $configPath) -eq $configHashBefore) 'Lab config mutated during server startup'
    Remove-Item -LiteralPath $displaced -Recurse -Force
    if ($RollbackFrom) {
      Write-Output '[ROLLED_BACK] Previous PR102 Lab server is running and healthy.'
    } else {
      Write-Output '[UPGRADED] PR102 Lab server is running with the new Session/Provider registry.'
    }
    Write-Output ('[NEW_PID] ' + $started.process.Id)
    Write-Output ('[BACKUP] ' + $backupRoot)
    Write-Output '[NEXT] Reload only the PR102 Lab extension, then refresh/reconnect the ChatGPT Lab connector.'
  } catch {
    if ($started -and -not $started.process.HasExited) { StopPinned $started.process }
    if (Test-Path -LiteralPath $displaced) {
      if (Test-Path -LiteralPath $serverRoot) { Remove-Item -LiteralPath $serverRoot -Recurse -Force }
      Move-Item -LiteralPath $displaced -Destination $serverRoot -ErrorAction Stop
    } else {
      Require (Test-Path -LiteralPath (Join-Path $serverRoot 'bridge.mjs') -PathType Leaf) 'Original server directory is missing; automatic rollback cannot continue'
    }
    $rollbackStarted = StartLabServer $state $run $configHashBefore
    WaitHealthy $rollbackStarted $state $oldExpectedTools $run
    Write-Output '[AUTO_ROLLBACK] Previous PR102 Lab server restored and healthy.'
    throw ('Upgrade failed; old server automatically restored: ' + $_.Exception.Message)
  }
} finally {
  if ($oldProc) { $oldProc.Dispose() }
  if ((Test-Path -LiteralPath $run) -and -not $Apply) {
    Remove-Item -LiteralPath $run -Recurse -Force
  }
}
)][string]$ExpectedSourceSha,
  [string]$RollbackFrom,
  [switch]$Apply,
  [switch]$TestFixture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$LabPort = 17484
$LabExtensionId = 'nhflbnfcaicihaepdcjacdmaddagcmcj'
. (Join-Path $PSScriptRoot 'process-identity.ps1')
. (Join-Path $PSScriptRoot 'verify-candidate-source.ps1')

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
function AssertListener([int]$ProcessId) {
  $listeners = @([BridgeNativeMetadata]::Listeners($LabPort))
  Require ($listeners.Count -eq 1) ('Expected one listener on 17484, found ' + $listeners.Count)
  Require ($listeners[0] -eq ('127.0.0.1|' + $ProcessId)) ('17484 listener does not belong to expected PID; owner=' + $listeners[0])
}
function PinProcess([int]$ProcessId,[string]$ExpectedStart,[string]$Root,[string]$State,[string]$ConfigHash) {
  $p = [Diagnostics.Process]::GetProcessById($ProcessId)
  $null = $p.Handle
  try {
    $identity = Get-BridgeHandleIdentity $p
    Require ($identity.executable -match '(?i)\\node\.exe$') 'Lab listener is not Node.js'
    $actualStart = [DateTime]::Parse($identity.created).ToUniversalTime()
    $expected = [DateTime]::Parse($ExpectedStart).ToUniversalTime()
    Require ([Math]::Abs(($actualStart-$expected).TotalMilliseconds) -le 2) 'PID start-time mismatch; refusing PID reuse'
    $actualCommand = ([string]$identity.command).Replace('/','\')
    $expectedEntry = (Join-Path $Root 'server\bridge.mjs').Replace('/','\')
    $directServer = $actualCommand.IndexOf($expectedEntry,[StringComparison]::OrdinalIgnoreCase) -ge 0
    $transactionLauncher = $false

    if (-not $directServer) {
      # A transaction-launched server is accepted only when the exact launcher
      # and sibling job prove this Lab root, state root, port and config hash.
      $argumentMatch = [regex]::Match(
        $actualCommand,
        '^"(?<exe>[^"]+)"\s+"(?<script>[^"]+\\cutover-start\.mjs)"\s+"(?<job>[^"]+\\start-[0-9a-f]{32}\.json)"$',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
      )
      if ($argumentMatch.Success) {
        $exePath = FullPath $argumentMatch.Groups['exe'].Value
        $scriptPath = FullPath $argumentMatch.Groups['script'].Value
        $jobPath = FullPath $argumentMatch.Groups['job'].Value
        $scriptDir = FullPath (Split-Path -Parent $scriptPath)
        $jobDir = FullPath (Split-Path -Parent $jobPath)
        $runName = Split-Path -Leaf $scriptDir
        $sameTransaction = $scriptDir -ieq $jobDir
        $insideLab = (Inside $scriptPath $Root) -and (Inside $jobPath $Root)
        $validRunName = $runName -match '^\.server-upgrade-[0-9a-f]{32}$'
        $pinnedNames = ((Split-Path -Leaf $scriptPath) -ieq 'cutover-start.mjs') -and
          ((Split-Path -Leaf $jobPath) -match '(?i)^start-[0-9a-f]{32}\.json$')
        $sameNode = $exePath -ieq (FullPath $script:NodeExe)
        if ($sameTransaction -and $insideLab -and $validRunName -and $pinnedNames -and $sameNode -and
            (Test-Path -LiteralPath $scriptPath -PathType Leaf) -and
            (Test-Path -LiteralPath $jobPath -PathType Leaf)) {
          $startJob = ReadJson $jobPath
          $jobSource = FullPath ([string]$startJob.source)
          $jobState = FullPath ([string]$startJob.state)
          $jobHash = [string]$startJob.configHash
          $currentHash = HashFile (Join-Path $State 'config.json')
          $transactionLauncher = ($jobSource -ieq (FullPath $Root)) -and
            ($jobState -ieq (FullPath $State)) -and
            ([int]$startJob.port -eq 17484) -and
            ($jobHash -eq $ConfigHash) -and ($jobHash -eq $currentHash)
        }
      }
    }

    Require ($directServer -or $transactionLauncher) 'Lab listener command line is neither pinned bridge.mjs nor a verified PR102 Lab transaction launcher'
    AssertListener $ProcessId
    return @{process=$p;identity=$identity;kind=$(if ($directServer) {'bridge'} else {'transaction-launcher'})}
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
function WriteExpectedTools([string]$SourceRoot,[string]$OutputFile,[string]$NodeExe) {
  $code = "import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  Push-Location $SourceRoot
  try {
    & $NodeExe --input-type=module -e $code $OutputFile
    Require ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $OutputFile -PathType Leaf)) 'Could not generate expected MCP tools registry'
  } finally { Pop-Location }
}
function Probe([string]$HealthScript,[string]$SourceRoot,[string]$State,[string]$ExpectedFile,[string]$RunDir,[string]$Mode) {
  $job = Join-Path $RunDir ('health-' + $Mode + '.json')
  WriteJson $job @{mode=$Mode;source=$SourceRoot;state=$State;port=$LabPort;expected=$ExpectedFile}
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe
  $psi.Arguments = '"' + $HealthScript + '" "' + $job + '"'
  $psi.WorkingDirectory = $SourceRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $probe = New-Object Diagnostics.Process
  $probe.StartInfo = $psi
  try {
    Require ($probe.Start()) 'Could not start MCP health probe'
    $stdoutTask = $probe.StandardOutput.ReadToEndAsync()
    $stderrTask = $probe.StandardError.ReadToEndAsync()
    Require ($probe.WaitForExit(12000)) 'MCP health probe timed out'
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    Require ($probe.ExitCode -eq 0) ('MCP health probe failed: ' + $Mode + '; stdout=' + $stdout + '; stderr=' + $stderr)
    if ($stdout) { Write-Output $stdout.Trim() }
  } finally {
    if ($probe -and -not $probe.HasExited) {
      try { $probe.Kill(); $null = $probe.WaitForExit(3000) } catch {}
    }
    $probe.Dispose()
  }
}
function StartLabServer([string]$State,[string]$RunDir,[string]$ConfigHash) {
  $startJob = Join-Path $RunDir ('start-' + [guid]::NewGuid().ToString('N') + '.json')
  WriteJson $startJob @{source=$script:LabRoot;state=$State;port=$LabPort;configHash=$ConfigHash}
  $startScript = Join-Path $RunDir 'cutover-start.mjs'
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe
  $psi.Arguments = '"' + $startScript + '" "' + $startJob + '"'
  $psi.WorkingDirectory = $script:LabRoot
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
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  return @{process=$proc;stdoutTask=$outTask;stderrTask=$errTask}
}
function WaitHealthy($Started,[string]$State,[string]$ExpectedFile,[string]$RunDir) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if ($Started.process.HasExited) {
      $stdout = ''
      $stderr = ''
      try { if ($Started.stdoutTask) { $stdout = [string]$Started.stdoutTask.GetAwaiter().GetResult() } } catch {}
      try { if ($Started.stderrTask) { $stderr = [string]$Started.stderrTask.GetAwaiter().GetResult() } } catch {}
      $detail = ('Candidate Bridge exited during startup; exitCode=' + $Started.process.ExitCode +
        '; stdout=' + $stdout + '; stderr=' + $stderr)
      throw $detail
    }
    try {
      AssertListener $Started.process.Id
      Probe $script:HealthScript $script:LabRoot $State $ExpectedFile $RunDir 'live'
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
function CreateBackup([string]$CurrentServer,[string]$Root,[string]$State,[string]$ConfigHash,[string]$CurrentTreeHash,[string]$SourceSha,[string]$RunDir) {
  $backupParent = Join-Path $Root 'backups'
  New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
  $backup = Join-Path $backupParent ('server-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Copy-Item -LiteralPath $CurrentServer -Destination (Join-Path $backup 'server') -Recurse -Force
  Require ((TreeHash (Join-Path $backup 'server')) -eq $CurrentTreeHash) 'Backup tree hash mismatch'
  WriteJson (Join-Path $backup 'server-backup.json') @{
    schema='chrome-bridge-pr102-lab-server-backup-v1';target='PR102_LAB';port=17484;
    labRoot=$Root;stateRoot=$State;createdUtc=[DateTime]::UtcNow.ToString('o');
    stateConfigSha256=$ConfigHash;serverTreeSha256=$CurrentTreeHash;sourceSha=$SourceSha
  }
  return $backup
}

$root = FullPath $LabRoot
$state = FullPath $StateRoot
$candidateRoot = FullPath $CandidateRoot
$script:LabRoot = $root
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
$actualSha = (& git -C $candidateRoot rev-parse HEAD).Trim()
Require ($LASTEXITCODE -eq 0 -and $actualSha -eq $ExpectedSourceSha.ToLowerInvariant()) 'Candidate Git SHA mismatch'
$serverRoot = Join-Path $root 'server'
Require (Test-Path -LiteralPath $serverRoot -PathType Container) 'Existing Lab server directory missing'
$configPath = Join-Path $state 'config.json'
Require (Test-Path -LiteralPath $configPath -PathType Leaf) 'Existing Lab config.json missing; refusing to create or replace credentials'
$configHashBefore = HashFile $configPath
$config = ReadJson $configPath
Require ($config.extensionId -eq $LabExtensionId) 'State config is not pinned to the PR102 Lab extension ID'
Require (($config.agentToken -is [string]) -and ($config.browserToken -is [string])) 'Existing Lab config lacks required tokens'
Require ($config.agentToken.Length -ge 32 -and $config.browserToken.Length -ge 32) 'Existing Lab token material is invalid'
$script:NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $script:NodeExe --version).Trim()
Require ($LASTEXITCODE -eq 0) 'Node version probe failed'

$identity = PinProcess $ExpectedPid $ExpectedStartUtc $root $state $configHashBefore
$oldProc = $identity.process
$oldIdentity = $identity.identity
$oldTreeHash = TreeHash $serverRoot
$run = Join-Path $root ('.server-upgrade-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$stageRoot = Join-Path $run 'candidate'
$stageServer = Join-Path $stageRoot 'server'
$healthScript = Join-Path $run 'cutover-health.mjs'
$startScript = Join-Path $run 'cutover-start.mjs'
$script:HealthScript = $healthScript
$expectedTools = Join-Path $run 'expected-tools.json'
$oldExpectedTools = Join-Path $run 'old-tools.json'
$started = $null
$backupRoot = $null
$displaced = $null

try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'deployment\cutover-health.mjs') -Destination $healthScript -Force
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'deployment\cutover-start.mjs') -Destination $startScript -Force

  if ($RollbackFrom) {
    $requestedBackup = FullPath $RollbackFrom
    Require (Inside $requestedBackup (Join-Path $root 'backups')) 'Rollback source must be inside PR102 Lab backups'
    $markerPath = Join-Path $requestedBackup 'server-backup.json'
    Require (Test-Path -LiteralPath $markerPath -PathType Leaf) 'Server backup marker missing'
    $marker = ReadJson $markerPath
    Require ($marker.schema -eq 'chrome-bridge-pr102-lab-server-backup-v1' -and $marker.target -eq 'PR102_LAB' -and $marker.port -eq 17484) 'Server backup marker mismatch'
    Require ((FullPath ([string]$marker.labRoot)) -ieq $root) 'Server backup belongs to another Lab root'
    Require ((FullPath ([string]$marker.stateRoot)) -ieq $state) 'Server backup belongs to another state directory'
    Require ((HashFile $configPath) -eq [string]$marker.stateConfigSha256) 'Lab config changed since server backup'
    $rollbackServer = Join-Path $requestedBackup 'server'
    Require (Test-Path -LiteralPath (Join-Path $rollbackServer 'bridge.mjs') -PathType Leaf) 'Rollback server is missing bridge.mjs'
    Require ((TreeHash $rollbackServer) -eq [string]$marker.serverTreeSha256) 'Rollback server hash mismatch'
    CopyServer $rollbackServer $stageServer
  } else {
    CopyServer (Join-Path $candidateRoot 'server') $stageServer
  }

  foreach ($file in Get-ChildItem -LiteralPath $stageServer -Recurse -File -Filter '*.mjs') {
    & $script:NodeExe --check $file.FullName
    Require ($LASTEXITCODE -eq 0) ('Node syntax error: ' + $file.Name)
  }
  WriteExpectedTools $stageRoot $expectedTools $script:NodeExe
  $toolNames = @((ReadJson $expectedTools).result.tools | ForEach-Object { $_.name })
  if (-not $RollbackFrom) {
    foreach ($required in @('session_request','session_authorize','session_status','session_revoke','provider_prepare','provider_commit','provider_status','provider_stop','provider_revoke','provider_events')) {
      Require ($toolNames -contains $required) ('Required Session/Provider tool missing: ' + $required)
    }
  }
  WriteExpectedTools $root $oldExpectedTools $script:NodeExe
  Probe $healthScript $stageRoot $state $expectedTools $run 'isolated'

  $stageHash = TreeHash $stageServer
  Require ($stageHash.Length -gt 0) 'Candidate server tree hash is empty'
  Write-Output ('[TARGET] PR102 Lab only; port=' + $LabPort)
  Write-Output ('[OWNER_PID] ' + $oldIdentity.id)
  Write-Output ('[OWNER_CREATED_UTC] ' + $oldIdentity.created)
  Write-Output ('[OWNER_EXE] ' + $oldIdentity.executable)
  Write-Output ('[OLD_SERVER_SHA256_TREE] ' + $oldTreeHash)
  Write-Output ('[STAGED_SERVER_SHA256_TREE] ' + $stageHash)
  Write-Output ('[STATE_CONFIG_SHA256] ' + $configHashBefore)
  Write-Output ('[SOURCE_SHA] ' + $actualSha)
  Write-Output ('[NODE] ' + $nodeVersion)

  if (-not $Apply) {
    Write-Output '[DRY_RUN] Server and isolated MCP registry validated; no files or processes changed.'
    return
  }

  if (-not $RollbackFrom) {
    $backupRoot = CreateBackup $serverRoot $root $state $configHashBefore $oldTreeHash $actualSha $run
  } else {
    $backupRoot = CreateBackup $serverRoot $root $state $configHashBefore $oldTreeHash $actualSha $run
  }
  Require ((HashFile $configPath) -eq $configHashBefore) 'Lab config changed after preflight'
  $fresh = PinProcess $ExpectedPid $ExpectedStartUtc $root $state $configHashBefore
  try {
    Require ($fresh.identity.command -ceq $oldIdentity.command) 'Lab listener command line changed during preflight'
    Require ((TreeHash $serverRoot) -eq $oldTreeHash) 'Installed Lab server changed during preflight'
  } finally { $fresh.process.Dispose() }

  $null = $oldProc.Handle
  $oldProc.Kill()
  Require ($oldProc.WaitForExit(8000)) 'Original Lab Bridge process did not stop'
  Require (@([BridgeNativeMetadata]::Listeners($LabPort)).Count -eq 0) 'Port 17484 remained occupied after stopping the pinned owner'

  $displaced = Join-Path $root ('.server-displaced-' + [guid]::NewGuid().ToString('N'))
  try {
    Move-Item -LiteralPath $serverRoot -Destination $displaced -ErrorAction Stop
    Move-Item -LiteralPath $stageServer -Destination $serverRoot -ErrorAction Stop
    $started = StartLabServer $state $run $configHashBefore
    WaitHealthy $started $state $expectedTools $run
    Require ((HashFile $configPath) -eq $configHashBefore) 'Lab config mutated during server startup'
    Remove-Item -LiteralPath $displaced -Recurse -Force
    if ($RollbackFrom) {
      Write-Output '[ROLLED_BACK] Previous PR102 Lab server is running and healthy.'
    } else {
      Write-Output '[UPGRADED] PR102 Lab server is running with the new Session/Provider registry.'
    }
    Write-Output ('[NEW_PID] ' + $started.process.Id)
    Write-Output ('[BACKUP] ' + $backupRoot)
    Write-Output '[NEXT] Reload only the PR102 Lab extension, then refresh/reconnect the ChatGPT Lab connector.'
  } catch {
    if ($started -and -not $started.process.HasExited) { StopPinned $started.process }
    if (Test-Path -LiteralPath $displaced) {
      if (Test-Path -LiteralPath $serverRoot) { Remove-Item -LiteralPath $serverRoot -Recurse -Force }
      Move-Item -LiteralPath $displaced -Destination $serverRoot -ErrorAction Stop
    } else {
      Require (Test-Path -LiteralPath (Join-Path $serverRoot 'bridge.mjs') -PathType Leaf) 'Original server directory is missing; automatic rollback cannot continue'
    }
    $rollbackStarted = StartLabServer $state $run $configHashBefore
    WaitHealthy $rollbackStarted $state $oldExpectedTools $run
    Write-Output '[AUTO_ROLLBACK] Previous PR102 Lab server restored and healthy.'
    throw ('Upgrade failed; old server automatically restored: ' + $_.Exception.Message)
  }
} finally {
  if ($oldProc) { $oldProc.Dispose() }
  if ((Test-Path -LiteralPath $run) -and -not $Apply) {
    Remove-Item -LiteralPath $run -Recurse -Force
  }
}
