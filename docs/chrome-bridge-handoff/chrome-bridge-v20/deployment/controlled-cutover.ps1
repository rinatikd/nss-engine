param(
  [string]$RollbackSource = (Join-Path (Split-Path $PSScriptRoot -Parent) 'rollback-candidates\v020-cors-recovered'),
  [string]$RehearsalProfile,
  [string]$RollbackRun,
  [string]$RunDirectory,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = 'C:\Program Files\nodejs\node.exe'
$health = Join-Path $PSScriptRoot 'cutover-health.mjs'
. (Join-Path $PSScriptRoot 'process-identity.ps1')
$isTest = ![string]::IsNullOrEmpty($RehearsalProfile)
$lock = $null; $original = $null; $proxyHandle = $null; $active = $null
function Read-Json($file) { Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-Json($value, $file) {
  $temporary=$file + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $value | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $temporary -Encoding UTF8
  if (Test-Path -LiteralPath $file) { [IO.File]::Replace($temporary,$file,[NullString]::Value) } else { [IO.File]::Move($temporary,$file) }
}
function Inside($child, $parent) {
  [IO.Path]::GetFullPath($child).StartsWith([IO.Path]::GetFullPath($parent).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Identity($number) {
  Get-BridgeIdentity $number
}
function Pin($identity) {
  # Cache the native Windows handle BEFORE identity checks; Kill uses this handle.
  $p = [Diagnostics.Process]::GetProcessById([int]$identity.id)
  $null = $p.Handle
  try {
    $c = Get-BridgeHandleIdentity $p
    if ($c.executable -ne $identity.executable -or $c.command -cne $identity.command -or $c.created -ne $identity.created) { throw 'Process identity mismatch' }
    if ([Math]::Abs(($p.StartTime.ToUniversalTime() - [DateTime]::Parse($identity.created).ToUniversalTime()).TotalMilliseconds) -gt 2) { throw 'Process creation time mismatch' }
    if ($p.HasExited) { throw 'Process already exited' }
    return $p
  } catch { $p.Dispose(); throw }
}
function Stop-Pinned($p) {
  if (!$p) { return }
  if (!$p.HasExited) { $p.Kill(); if (!$p.WaitForExit(8000)) { throw 'Pinned process did not exit' } }
}
function Listener($port, $owner) {
  $items = @([BridgeNativeMetadata]::Listeners($port))
  if ($items.Count -ne 1 -or $items[0] -ne "127.0.0.1|$owner") { throw "Listener mismatch on $port" }
}
function Free-Port($port) {
  if (@([BridgeNativeMetadata]::Listeners($port)).Count) { throw "Port occupied: $port; occupant will not be stopped" }
}
function Tree-Hash($dir) {
  $map = @{}
  foreach ($f in Get-ChildItem -LiteralPath $dir -Recurse -Force) {
    if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in staged source' }
    if (!$f.PSIsContainer) { $map[$f.FullName.Substring($dir.Length)] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash }
  }
  return ($map.GetEnumerator() | Sort-Object Name | ForEach-Object { $_.Name + ':' + $_.Value }) -join '|'
}
function Protected-Hash {
  $names = @('config.json', 'bridge_mcp_proxy.py', 'Start-TunnelClient.ps1')
  ($names | ForEach-Object { $f = Join-Path $profile.state $_; if (Test-Path -LiteralPath $f) { $_ + ':' + (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash } }) -join '|'
}
function Probe($mode, $source, $port, $expected) {
  $job = Join-Path $run 'health-job.json'
  Write-Json @{mode=$mode;source=$source;port=$port;state=$profile.state;expected=$expected} $job
  & $node $health $job >> (Join-Path $run 'health.log') 2>> (Join-Path $run 'health-errors.log')
  if ($LASTEXITCODE -ne 0) { throw "Health check failed: $mode port=$port" }
}
function Guard {
  if ($proxyHandle.HasExited) { throw 'Proxy exited' }
  Listener $profile.proxyPort $profile.proxy.id
  if ((Protected-Hash) -ne $protected) { throw 'Protected configuration changed' }
  if ((Tree-Hash $candidate) -ne $candidateHash -or (Tree-Hash $rollback) -ne $rollbackHash) { throw 'Staged source changed' }
  if (((Get-FileHash -LiteralPath $expected15).Hash + (Get-FileHash -LiteralPath $expected18).Hash) -ne $schemasHash) { throw 'Schema baseline changed' }
}
function Launch($source) {
  Free-Port $profile.bridgePort
  $startJob = Join-Path $run ('start-' + [Guid]::NewGuid().ToString('N') + '.json')
  Write-Json @{source=$source;state=$profile.state;port=$profile.bridgePort;configHash=$configHash} $startJob
  $si = New-Object Diagnostics.ProcessStartInfo
  $si.FileName = $node; $si.Arguments = '"' + (Join-Path $PSScriptRoot 'cutover-start.mjs') + '" "' + $startJob + '"'
  $si.WorkingDirectory = $source; $si.UseShellExecute = $false; $si.CreateNoWindow = $true
  $si.EnvironmentVariables['CHROME_BRIDGE_HOME'] = $profile.state
  $si.EnvironmentVariables['CHROME_BRIDGE_PORT'] = [string]$profile.bridgePort
  $si.EnvironmentVariables.Remove('CHROME_BRIDGE_CODEX_POLICY')
  $si.EnvironmentVariables.Remove('NODE_OPTIONS'); $si.EnvironmentVariables.Remove('NODE_PATH')
  $p = New-Object Diagnostics.Process
  $p.StartInfo = $si
  if (!$p.Start()) { throw 'Start failed' }
  $null = $p.Handle
  return $p
}
function Wait-Healthy($p, $expected) {
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    if ($p.HasExited) { throw 'Bridge exited during startup' }
    try {
      Listener $profile.bridgePort $p.Id
      Probe live '' $profile.bridgePort $expected
      Probe live '' $profile.proxyPort $expected
      Guard
      return
    } catch { if ([DateTime]::UtcNow -gt $deadline) { throw }; Start-Sleep -Milliseconds 200 }
  } while ($true)
}
function Journal($status, $p) {
  $identity = $null
  if ($p -and !$p.HasExited) { $identity = Get-BridgeHandleIdentity $p }
  Write-Json @{ status=$status; profile=$profile; current=$identity; candidate=$candidate; rollback=$rollback;
    candidateHash=$candidateHash; rollbackHash=$rollbackHash; expected18=$expected18; expected15=$expected15; schemasHash=$schemasHash; protected=$protected; configHash=$configHash;
    updated=[DateTime]::UtcNow.ToString('o') } (Join-Path $run 'run.json')
}
function Rehearsal-Pause($stage) {
  if ($isTest -and $profile.fault -eq "pause-$stage") {
    Write-Json @{stage=$stage;run=$run} (Join-Path $profile.state 'paused.json')
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    while (!(Test-Path -LiteralPath (Join-Path $profile.state 'continue'))) {
      if ([DateTime]::UtcNow -gt $deadline) {throw 'Rehearsal pause timeout'}
      Start-Sleep -Milliseconds 100
    }
  }
}
try {
  foreach ($key in @('CHROME_BRIDGE_CODEX_POLICY','NODE_OPTIONS','NODE_PATH')) { if ([Environment]::GetEnvironmentVariable($key)) { throw "Unsafe inherited environment: $key" } }
  if ($isTest) {
    $profile = Read-Json $RehearsalProfile
    if (!(Inside $profile.state ([IO.Path]::GetTempPath())) -or $profile.bridgePort -in @(17381,17382) -or $profile.proxyPort -in @(17381,17382) -or $profile.bridge.id -in @(2200,9824) -or $profile.proxy.id -in @(2200,9824)) { throw 'Rehearsal cannot target production' }
    $cfg = Read-Json (Join-Path $profile.state 'config.json')
    if ($cfg.agentToken -notlike 'rehearsal-*' -or $cfg.browserToken -notlike 'rehearsal-*') { throw 'Synthetic rehearsal configuration required' }
  } else {
    if ($env:CHROME_BRIDGE_HOME -or $env:CHROME_BRIDGE_PORT) { throw 'Unexpected production environment' }
    $profile = Read-Json (Join-Path $PSScriptRoot 'production-cutover-profile.json')
  }
  if ($profile.bridgePort -eq $profile.proxyPort -or $profile.bridge.id -eq $profile.proxy.id) { throw 'Bridge/proxy must be distinct' }
  $lockFile = Join-Path $profile.state 'controlled-cutover.lock'
  $lock = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  if ($RollbackRun) {
    $saved = Read-Json (Join-Path $RollbackRun 'run.json')
    if ($saved.status -ne 'UPGRADED' -or !$saved.current) { throw 'Run is not an upgraded deployment' }
    if ($saved.profile.state -ne $profile.state -or $saved.profile.bridgePort -ne $profile.bridgePort -or $saved.profile.proxy.id -ne $profile.proxy.id) { throw 'Rollback profile mismatch' }
    $profile.bridge = $saved.current
    $candidate = $saved.candidate; $rollback = $saved.rollback
    $candidateHash = $saved.candidateHash; $rollbackHash = $saved.rollbackHash
    $expected18 = $saved.expected18; $expected15 = $saved.expected15
    $schemasHash = $saved.schemasHash
    $protected = $saved.protected; $configHash=$saved.configHash; $run = [IO.Path]::GetFullPath($RollbackRun)
  } else {
    $run = Join-Path $root ('integration-reports\cutover-runs\' + [Guid]::NewGuid().ToString('N'))
    if ($RunDirectory) { $run=[IO.Path]::GetFullPath($RunDirectory) }
    if (!(Inside $run (Join-Path $root 'integration-reports')) -or (Test-Path -LiteralPath $run)) { throw 'Run directory must be new and inside integration-reports' }
    New-Item -ItemType Directory -Path $run -Force | Out-Null
    $candidate = Join-Path $run 'candidate'; $rollback = Join-Path $run 'rollback'
    foreach ($item in @(@($candidate,$root), @($rollback,$RollbackSource))) {
      $null = Tree-Hash (Join-Path $item[1] 'server')
      New-Item -ItemType Directory -Path $item[0] | Out-Null
      Copy-Item -LiteralPath (Join-Path $item[1] 'server') -Destination $item[0] -Recurse
    }
    $candidateHash = Tree-Hash $candidate; $rollbackHash = Tree-Hash $rollback
    $expected15 = Join-Path $run 'expected15.json'; $expected18 = Join-Path $run 'expected18.json'
    Copy-Item -LiteralPath (Join-Path $root 'integration-reports\rollback-recovery\production-tools-list.json') -Destination $expected15
    & $node --input-type=module -e "import fs from 'node:fs';import {tools} from './server/tools.mjs';fs.writeFileSync(process.argv[1],JSON.stringify({result:{tools:tools.map(({kind,...t})=>t)}}));" $expected18
    if ($LASTEXITCODE) { throw 'Could not capture schemas' }
    $protected = Protected-Hash
    $configHash = (Get-FileHash -LiteralPath (Join-Path $profile.state 'config.json')).Hash
    $schemasHash = (Get-FileHash -LiteralPath $expected15).Hash + (Get-FileHash -LiteralPath $expected18).Hash
  }
  if ($isTest -and ($profile.bridge.id -in @(2200,9824) -or !(Inside $candidate $root) -or !(Inside $rollback $root))) { throw 'Rehearsal target override denied' }
  if ($profile.bridge.executable -ne $node) { throw 'Not the expected Node executable' }
  $original = Pin $profile.bridge; $proxyHandle = Pin $profile.proxy
  Listener $profile.bridgePort $original.Id; Listener $profile.proxyPort $proxyHandle.Id
  Guard
  Probe isolated $candidate 0 $expected18; Probe isolated $rollback 0 $expected15
  $before = $expected15; $after = $expected18; $target = $candidate; $fallback = $rollback
  if ($RollbackRun) { $before=$expected18; $after=$expected15; $target=$rollback; $fallback=$candidate }
  Probe live '' $profile.bridgePort $before; Probe live '' $profile.proxyPort $before
  if (!$Apply) { Write-Output "PREFLIGHT_OK $run"; return }
  if (!$isTest) {
    if ([Console]::IsInputRedirected) { throw 'Local interactive confirmation required' }
    $phrase = "CUTOVER $($original.Id) TO " + $(if ($RollbackRun) {'15'} else {'18'})
    if ((Read-Host "Type $phrase") -cne $phrase) { throw 'Local confirmation not supplied' }
  }
  Rehearsal-Pause 'before-stop'
  Guard; Listener $profile.bridgePort $original.Id
  if ($original.HasExited) { throw 'Original process exited before stop' }
  Journal 'PREPARED' $original
  $stopped = $false
  try {
    Stop-Pinned $original; $stopped = $true
    Journal 'ORIGINAL_STOPPED' $null
    Rehearsal-Pause 'after-stop'
    if ($isTest -and $profile.fault -eq 'before-launch-failure') {throw 'Injected failure before launch'}
    $active = Launch $target
    Journal 'STARTING' $active
    if ($isTest -and $profile.fault -eq 'startup-exit') { Stop-Pinned $active }
    Wait-Healthy $active $after
    if ($isTest -and $profile.fault -eq 'health-failure') { throw 'Injected post-startup health failure' }
    $status = 'UPGRADED'; if ($RollbackRun) { $status='ROLLED_BACK' }
    Journal $status $active
    Write-Output "$status $run PID=$($active.Id)"
  } catch {
    if (!$stopped) { throw }
    try { Stop-Pinned $active } catch { Journal 'RECOVERY_REQUIRED' $active; throw 'Cannot stop owned candidate; recovery not attempted on occupied port' }
    try {
      Guard
      $active = Launch $fallback
      Wait-Healthy $active $before
      Journal 'AUTO_RESTORED' $active
      Write-Output "AUTO_RESTORED $run PID=$($active.Id)"
    } catch { Journal 'RECOVERY_REQUIRED' $active; throw 'Automatic recovery failed; no unrelated process will be stopped' }
    throw 'Cutover failed; original registry restored automatically'
  }
} finally {
  if ($lock) { $lock.Dispose() }
  foreach ($p in @($original,$proxyHandle,$active)) { if ($p) { $p.Dispose() } }
}

