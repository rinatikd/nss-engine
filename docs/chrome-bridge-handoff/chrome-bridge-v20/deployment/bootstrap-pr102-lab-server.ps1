# First-time PR102 Lab server bootstrap on its dedicated port 17485.
# Dry-run by default. Never targets or stops the Consilium service on 17484 or Production.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$LabRoot,
  [Parameter(Mandatory=$true)][string]$StateRoot,
  [Parameter(Mandatory=$true)][string]$CandidateRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedSourceSha,
  [string]$NodeExe,
  [switch]$Apply,
  [switch]$TestFixture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$LabPort = 17485
$LabExtensionId = 'nhflbnfcaicihaepdcjacdmaddagcmcj'
. (Join-Path $PSScriptRoot 'process-identity.ps1')
. (Join-Path $PSScriptRoot 'verify-candidate-source.ps1')

function Require([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function FullPath([string]$Path) { return (Get-BridgeCanonicalPath $Path) }
function Inside([string]$Child,[string]$Parent) {
  $c=(FullPath $Child)+'\'
  $p=(FullPath $Parent)+'\'
  return $c.StartsWith($p,[StringComparison]::OrdinalIgnoreCase)
}
function HashFile([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function WriteJson([string]$Path,$Value) {
  [IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 30)+[Environment]::NewLine,(New-Object System.Text.UTF8Encoding($false)))
}
function InvokeNodeCapture([string]$Executable,[string]$Arguments,[string]$WorkingDirectory,[int]$TimeoutMs=15000) {
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName=$Executable
  $psi.Arguments=$Arguments
  $psi.WorkingDirectory=$WorkingDirectory
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $process=New-Object Diagnostics.Process
  $process.StartInfo=$psi
  $started=$false
  try {
    if (-not $process.Start()) { throw 'NODE_PROCESS_START_FAILED' }
    $started=$true
    $stdoutTask=$process.StandardOutput.ReadToEndAsync()
    $stderrTask=$process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMs)) { throw 'NODE_PROCESS_TIMEOUT' }
    return [pscustomobject]@{
      ExitCode=$process.ExitCode
      Stdout=[string]$stdoutTask.GetAwaiter().GetResult()
      Stderr=[string]$stderrTask.GetAwaiter().GetResult()
    }
  } finally {
    if ($started -and -not $process.HasExited) {
      try { $process.Kill(); $null=$process.WaitForExit(3000) } catch {}
    }
    $process.Dispose()
  }
}
function CopyServer([string]$Source,[string]$Destination) {
  Require (Test-Path -LiteralPath (Join-Path $Source 'bridge.mjs') -PathType Leaf) 'bridge.mjs missing'
  Require (Test-Path -LiteralPath (Join-Path $Source 'tools.mjs') -PathType Leaf) 'tools.mjs missing'
  foreach ($item in Get-ChildItem -LiteralPath $Source -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Reparse point in candidate server: '+$item.FullName) }
    if ($item.Name -match '^(config|secrets?|credentials?|agents|provider-journal|send-journal)\.(json|ya?ml|txt)$' -or
        $item.Extension -in @('.pem','.pfx','.p12','.key','.log')) {
      throw ('State/credential-shaped file refused in candidate: '+$item.Name)
    }
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
}
function TreeHash([string]$Path) {
  $rows=@()
  foreach ($item in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Reparse point in server tree: '+$item.FullName) }
    if (-not $item.PSIsContainer) {
      $relative=$item.FullName.Substring((FullPath $Path).Length+1).Replace('\','/')
      $rows+=($relative+':'+(HashFile $item.FullName))
    }
  }
  return (($rows | Sort-Object) -join '|')
}
function WriteExpectedTools([string]$SourceRoot,[string]$OutputFile) {
  $code="import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  $arguments='--input-type=module -e "'+$code.Replace('"','\"')+'" "'+$OutputFile+'"'
  $probe=InvokeNodeCapture $script:NodeExe $arguments $SourceRoot 15000
  Require ($probe.ExitCode -eq 0 -and (Test-Path -LiteralPath $OutputFile -PathType Leaf)) ('Could not generate expected tools registry: '+$probe.Stderr)
}
function AssertCompleteRegistry([string]$Path) {
  $names=@((Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).result.tools | ForEach-Object { [string]$_.name })
  $unique=@($names | Sort-Object -Unique)
  Require ($names.Count -eq 30 -and $unique.Count -eq 30) ('Expected exactly 30 unique MCP tools; found '+$names.Count)
  foreach ($required in @('session_request','session_authorize','session_status','session_revoke','provider_prepare','provider_commit','provider_status','provider_reply_wait','provider_stop','provider_revoke','provider_events')) {
    Require ($names -contains $required) ('Required MCP tool missing: '+$required)
  }
}
function Probe([string]$HealthScript,[string]$SourceRoot,[string]$State,[string]$ExpectedFile,[string]$RunDir,[string]$Mode) {
  $job=Join-Path $RunDir ('health-'+$Mode+'.json')
  WriteJson $job @{mode=$Mode;source=$SourceRoot;state=$State;port=$LabPort;expected=$ExpectedFile}
  $probe=InvokeNodeCapture $script:NodeExe ('"'+$HealthScript+'" "'+$job+'"') $SourceRoot 15000
  Require ($probe.ExitCode -eq 0) ('Health probe failed ('+$Mode+'): '+$probe.Stderr+'; '+$probe.Stdout)
  if ($probe.Stdout) { Write-Output $probe.Stdout.Trim() }
}
function AssertFreePort {
  $listeners=@([BridgeNativeMetadata]::Listeners($LabPort))
  Require ($listeners.Count -eq 0) ('PR102 Lab port 17485 is not free; refusing to stop or replace any process: '+($listeners -join ';'))
}
function CreateBackup([string]$ServerRoot,[string]$State,[string]$ConfigHash,[string]$SourceSha) {
  $backupParent=Join-Path $State 'backups'
  New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
  $backup=Join-Path $backupParent ('server-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Copy-Item -LiteralPath $ServerRoot -Destination (Join-Path $backup 'server') -Recurse -Force
  $treeHash=TreeHash (Join-Path $backup 'server')
  WriteJson (Join-Path $backup 'server-backup.json') @{
    schema='chrome-bridge-pr102-lab-server-backup-v1'
    target='PR102_LAB'
    port=$LabPort
    labRoot=$script:LabRoot
    stateRoot=$State
    createdUtc=[DateTime]::UtcNow.ToString('o')
    stateConfigSha256=$ConfigHash
    serverTreeSha256=$treeHash
    sourceSha=$SourceSha
  }
  return $backup
}
function StartLabServer([string]$State,[string]$RunDir,[string]$ConfigHash) {
  $startJob=Join-Path $RunDir ('start-'+[guid]::NewGuid().ToString('N')+'.json')
  WriteJson $startJob @{source=$script:LabRoot;state=$State;port=$LabPort;configHash=$ConfigHash}
  $startScript=Join-Path $RunDir 'cutover-start.mjs'
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName=$script:NodeExe
  $psi.Arguments='"'+$startScript+'" "'+$startJob+'"'
  $psi.WorkingDirectory=$script:LabRoot
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $psi.EnvironmentVariables['CHROME_BRIDGE_HOME']=$State
  $psi.EnvironmentVariables['CHROME_BRIDGE_PORT']=[string]$LabPort
  $psi.EnvironmentVariables['CHROME_BRIDGE_EXTENSION_ID']=$script:LabExtensionId
  $psi.EnvironmentVariables.Remove('CHROME_BRIDGE_CODEX_POLICY')
  $psi.EnvironmentVariables.Remove('NODE_OPTIONS')
  $psi.EnvironmentVariables.Remove('NODE_PATH')
  $process=New-Object Diagnostics.Process
  $process.StartInfo=$psi
  Require ($process.Start()) 'Could not start PR102 Lab server process'
  $stdoutTask=$process.StandardOutput.ReadToEndAsync()
  $stderrTask=$process.StandardError.ReadToEndAsync()
  Add-Member -InputObject $process -NotePropertyName BootstrapStdoutTask -NotePropertyValue $stdoutTask
  Add-Member -InputObject $process -NotePropertyName BootstrapStderrTask -NotePropertyValue $stderrTask
  return $process
}
function WaitHealthy($Process,[string]$State,[string]$ExpectedFile,[string]$RunDir) {
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  do {
    if ($Process.HasExited) {
      $stdout=''; $stderr=''
      try { if ($Process.BootstrapStdoutTask) { $stdout=[string]$Process.BootstrapStdoutTask.GetAwaiter().GetResult() } } catch {}
      try { if ($Process.BootstrapStderrTask) { $stderr=[string]$Process.BootstrapStderrTask.GetAwaiter().GetResult() } } catch {}
      throw ('PR102 Lab server exited during bootstrap; exitCode='+$Process.ExitCode+'; stdout='+$stdout+'; stderr='+$stderr)
    }
    $listeners=@([BridgeNativeMetadata]::Listeners($LabPort))
    if ($listeners.Count -eq 1 -and $listeners[0] -eq ('127.0.0.1|'+$Process.Id)) {
      Probe $script:HealthScript $script:LabRoot $State $ExpectedFile $RunDir 'live'
      return
    }
    if ([DateTime]::UtcNow -ge $deadline) { throw ('PR102 Lab did not bind 127.0.0.1:17485; listeners='+($listeners -join ';')) }
    Start-Sleep -Milliseconds 250
  } while ($true)
}
function StopStartedProcess($Process) {
  if ($Process -and -not $Process.HasExited) {
    $null=$Process.Handle
    $listeners=@([BridgeNativeMetadata]::Listeners($LabPort))
    if ($listeners.Count -eq 1 -and $listeners[0] -eq ('127.0.0.1|'+$Process.Id)) {
      $Process.Kill()
      if (-not $Process.WaitForExit(8000)) { throw 'Bootstrap-owned PR102 process did not stop' }
    } elseif ($listeners.Count -gt 0) {
      throw ('Unexpected process now owns PR102 Lab port; refusing to terminate it: '+($listeners -join ';'))
    }
  }
}
function AssertStartedIdentity($Process,[string]$State) {
  $p=[Diagnostics.Process]::GetProcessById($Process.Id)
  try {
    $identity=Get-BridgeHandleIdentity $p
    Require ((FullPath ([string]$identity.executable)) -ieq (FullPath $script:NodeExe)) 'PR102 bootstrap executable mismatch'
    Require ((FullPath ([string]$identity.workingDirectory)) -ieq (FullPath $script:LabRoot)) 'PR102 bootstrap working directory mismatch'
    Require ((FullPath ([string]$identity.bridgeHome)) -ieq (FullPath $State)) 'PR102 bootstrap StateRoot mismatch'
    Require ([string]$identity.bridgePort -ceq [string]$LabPort) 'PR102 bootstrap port environment mismatch'
    Require ([string]$identity.extensionId -ceq $script:LabExtensionId) 'PR102 bootstrap extension ID mismatch'
    $command=([string]$identity.command).Replace('/','\')
    Require ($command -match '(?i)cutover-start\.mjs"\s+".*\\start-[0-9a-f]{32}\.json"$') 'PR102 bootstrap command is not a pinned transaction launcher'
    return $identity
  } finally { $p.Dispose() }
}

$root=FullPath $LabRoot
$state=FullPath $StateRoot
$candidate=FullPath $CandidateRoot
$script:LabRoot=$root
if ($TestFixture) {
  $runnerTemp=[Environment]::GetEnvironmentVariable('RUNNER_TEMP')
  Require (-not [string]::IsNullOrWhiteSpace($runnerTemp)) 'TestFixture requires RUNNER_TEMP'
  Require (Inside $root $runnerTemp) 'TestFixture LabRoot must be below RUNNER_TEMP'
  Require ((Split-Path $root -Leaf) -eq 'ChromeBridge-PR102-17485-Lab-Server-TestFixture') 'Unexpected PR102 bootstrap fixture name'
  Require (Inside $state $root) 'TestFixture StateRoot must remain inside LabRoot'
} else {
  Require ($root -ieq 'C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20') 'Only the exact PR102 Lab server root may be targeted'
  Require ($state -ieq 'C:\Engineering\ChromeBridge-PR102-17484-State') 'Only the existing PR102 Lab StateRoot may be targeted'
  Require (-not ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'PR102 Lab server root must not be a reparse point'
  Require (-not ((Get-Item -LiteralPath $state -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'PR102 Lab StateRoot must not be a reparse point'
}
Require ((Split-Path $candidate -Leaf) -eq 'chrome-bridge-v20') 'CandidateRoot must be the pinned chrome-bridge-v20 tree'
Require (Test-Path -LiteralPath $root -PathType Container) 'Existing PR102 Lab server root missing'
Require (Test-Path -LiteralPath $state -PathType Container) 'Existing PR102 Lab StateRoot missing'
$serverRoot=Join-Path $root 'server'
Require (Test-Path -LiteralPath $serverRoot -PathType Container) 'Existing PR102 Lab server directory missing'
Require (Test-Path -LiteralPath (Join-Path $serverRoot 'bridge.mjs') -PathType Leaf) 'Existing PR102 Lab bridge entry missing'
$configPath=Join-Path $state 'config.json'
Require (Test-Path -LiteralPath $configPath -PathType Leaf) 'Existing PR102 Lab config missing; refusing to create credentials'
$configHash=HashFile $configPath
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
Require (($config.agentToken -is [string]) -and $config.agentToken.Length -ge 32) 'PR102 Lab agent token missing or invalid'
Require (($config.browserToken -is [string]) -and $config.browserToken.Length -ge 32) 'PR102 Lab browser token missing or invalid'
$expectedSource=Assert-BridgeCandidateSource -CandidateRoot $candidate -ExpectedSourceSha $ExpectedSourceSha -InputPaths @(
  'server',
  'deployment/cutover-health.mjs',
  'deployment/cutover-start.mjs',
  'deployment/process-identity.ps1',
  'deployment/verify-candidate-source.ps1',
  'deployment/bootstrap-pr102-lab-server.ps1',
  'deployment/upgrade-pr102-lab-server.ps1'
)
AssertFreePort
if ([string]::IsNullOrWhiteSpace($NodeExe)) {
  $nodeCommand=Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $NodeExe=[string]$nodeCommand.Source
}
$availableNodePaths=@(Get-Command node.exe -CommandType Application -All -ErrorAction Stop | ForEach-Object { [string]$_.Source })
$script:NodeExe=Get-BridgePinnedExecutable $NodeExe $availableNodePaths
$nodeVersion=InvokeNodeCapture $script:NodeExe '--version' $root 10000
Require ($nodeVersion.ExitCode -eq 0) ('Node version probe failed: '+$nodeVersion.Stderr)

$oldTreeHash=TreeHash $serverRoot
$run=Join-Path $root ('.server-upgrade-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$stageRoot=Join-Path $run 'candidate'
$stageServer=Join-Path $stageRoot 'server'
$healthScript=Join-Path $run 'cutover-health.mjs'
$startScript=Join-Path $run 'cutover-start.mjs'
$script:HealthScript=$healthScript
$expectedTools=Join-Path $run 'expected-tools.json'
$started=$null
$backupRoot=$null
$displaced=$null
$completed=$false
$keepRun=$false
try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  CopyServer (Join-Path $candidate 'server') $stageServer
  Copy-Item -LiteralPath (Join-Path $candidate 'deployment\cutover-health.mjs') -Destination $healthScript -Force
  Copy-Item -LiteralPath (Join-Path $candidate 'deployment\cutover-start.mjs') -Destination $startScript -Force
  foreach ($file in Get-ChildItem -LiteralPath $stageServer -Recurse -File -Filter '*.mjs') {
    $syntax=InvokeNodeCapture $script:NodeExe ('--check "'+$file.FullName+'"') $stageRoot 10000
    Require ($syntax.ExitCode -eq 0) ('Node syntax failed for '+$file.Name+': '+$syntax.Stderr)
  }
  WriteExpectedTools $stageRoot $expectedTools
  AssertCompleteRegistry $expectedTools
  Probe $healthScript $stageRoot $state $expectedTools $run 'isolated'
  $candidateTreeHash=TreeHash $stageServer
  Require ($candidateTreeHash.Length -gt 0) 'Staged PR102 server tree hash is empty'
  Require ((HashFile $configPath) -ceq $configHash) 'PR102 Lab config changed during staging'
  Require ((TreeHash $serverRoot) -ceq $oldTreeHash) 'Existing PR102 Lab server changed during staging'
  AssertFreePort
  Write-Output '[TARGET] PR102 Lab only; port=17485'
  Write-Output ('[SOURCE_SHA] '+$expectedSource)
  Write-Output ('[STATE_CONFIG_SHA256] '+$configHash)
  Write-Output ('[OLD_SERVER_TREE] '+$oldTreeHash)
  Write-Output ('[CANDIDATE_SERVER_TREE] '+$candidateTreeHash)
  Write-Output ('[NODE] '+$nodeVersion.Stdout.Trim())
  if (-not $Apply) {
    Write-Output '[DRY_RUN] PR102 server candidate and 30-tool registry validated; no installed files, processes or State changed.'
    return
  }

  Require ((HashFile $configPath) -ceq $configHash) 'PR102 Lab config changed before bootstrap'
  Require ((TreeHash $serverRoot) -ceq $oldTreeHash) 'Existing PR102 Lab server changed before bootstrap'
  AssertFreePort
  $backupParent=Join-Path $state 'backups'
  New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
  $backupRoot=CreateBackup $serverRoot $state $configHash $expectedSource
  Require ((TreeHash (Join-Path $backupRoot 'server')) -ceq $oldTreeHash) 'PR102 bootstrap backup verification failed'
  $displaced=Join-Path $root ('.server-displaced-'+[guid]::NewGuid().ToString('N'))
  Move-Item -LiteralPath $serverRoot -Destination $displaced -ErrorAction Stop
  Move-Item -LiteralPath $stageServer -Destination $serverRoot -ErrorAction Stop
  $started=StartLabServer $state $run $configHash
  WaitHealthy $started $state $expectedTools $run
  $newIdentity=AssertStartedIdentity $started $state
  Require ((HashFile $configPath) -ceq $configHash) 'PR102 Lab config mutated during bootstrap'
  Require ((TreeHash $serverRoot) -ceq $candidateTreeHash) 'Installed PR102 server tree differs from staged candidate'
  Remove-Item -LiteralPath $displaced -Recurse -Force
  $displaced=$null
  $keepRun=$true
  $completed=$true
  Write-Output '[BOOTSTRAPPED] PR102 Lab server is running on 127.0.0.1:17485.'
  Write-Output ('[NEW_PID] '+$started.Id)
  Write-Output ('[PROCESS_CREATED_UTC] '+$newIdentity.created)
  Write-Output ('[BACKUP] '+$backupRoot)
  Write-Output '[CONSILIUM] Port 17484 and its owner were not touched.'
  Write-Output '[NEXT] Install/reload only the PR102 extension on the same 17485 endpoint.'
} catch {
  $originalError=$_.Exception.Message
  if ($started) {
    try { StopStartedProcess $started } catch { $originalError+='; STOP_FAILED: '+$_.Exception.Message }
  }
  if ($displaced -and (Test-Path -LiteralPath $displaced)) {
    try {
      if (Test-Path -LiteralPath $serverRoot) {
        $failedRoot=Join-Path $root ('.server-failed-'+[guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $serverRoot -Destination $failedRoot -ErrorAction Stop
        Remove-Item -LiteralPath $failedRoot -Recurse -Force
      }
      Move-Item -LiteralPath $displaced -Destination $serverRoot -ErrorAction Stop
      $displaced=$null
      Write-Output '[AUTO_ROLLBACK] Previous PR102 server files restored.'
    } catch { $originalError+='; FILE_RESTORE_FAILED: '+$_.Exception.Message }
  }
  throw ('PR102 Lab bootstrap failed: '+$originalError)
} finally {
  if ($started) { try { $started.Dispose() } catch {} }
  if (-not $keepRun -and (Test-Path -LiteralPath $run)) {
    try { Remove-Item -LiteralPath $run -Recurse -Force -ErrorAction Stop } catch {}
  }
  if ($displaced -and (Test-Path -LiteralPath $displaced)) {
    # Never delete the only copy of the original server tree.
    Write-Warning ('Original server tree remains preserved at '+$displaced)
  }
}
