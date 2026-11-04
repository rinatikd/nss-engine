# Chrome Bridge supervisor: launch existing Start-Bridge.ps1 only when local
# TCP 17381 is absent. Does not touch config, tokens, proxy 17382 or Codex.
[CmdletBinding()]
param(
  [string]$BridgeRoot = 'C:\Engineering\chrome-bridge',
  [string]$StartScript = '',
  [ValidateRange(10,300)][int]$CheckSeconds = 20,
  [switch]$ProbeOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$port = 17381
function IsListening {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $port)
    return ($task.Wait(650) -and $client.Connected)
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}
$root = [IO.Path]::GetFullPath($BridgeRoot)
if (-not $StartScript) { $StartScript = Join-Path $root 'Start-Bridge.ps1' }
$startFile = [IO.Path]::GetFullPath($StartScript)
if ($ProbeOnly) {
  if (IsListening) { Write-Output '[READY] main-server 127.0.0.1:17381 is listening'; exit 0 }
  Write-Output '[DOWN] main-server 127.0.0.1:17381 is not listening'
  exit 2
}
if (-not (Test-Path -LiteralPath $startFile -PathType Leaf)) {
  throw ('Start-Bridge.ps1 not found: ' + $startFile + '. No alternate server launcher will be guessed.')
}
# Prevent multiple watch loops under the same Windows session.
$mutex = New-Object System.Threading.Mutex($false, 'Local\ChromeBridgeServerWatchdog')
$acquired = $false
try {
  try { $acquired = $mutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { Write-Output '[SKIP] Watchdog already active in this session'; exit 0 }
  $failures = 0
  while ($true) {
    if (IsListening) {
      $failures = 0
      Start-Sleep -Seconds $CheckSeconds
      continue
    }
    # Exponential backoff after consecutive failures to prevent crash loops.
    $delay = [int][Math]::Min(300, [Math]::Pow(2, [Math]::Min($failures,7)) * 5)
    Write-Output ('[RECOVERY] 17381 unavailable; launching existing Start-Bridge.ps1 at ' + (Get-Date -Format s))
    try {
      $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        ('"' + $startFile + '"')
      ) -WorkingDirectory $root -WindowStyle Hidden -PassThru -ErrorAction Stop
      Start-Sleep -Seconds 4
      if (IsListening) {
        $failures = 0
        Write-Output '[RECOVERED] 17381 became available'
      } else {
        $failures++
        Write-Output ('[WARNING] Server not ready; retry in ' + $delay + ' seconds')
        # If the child keeps running without opening the expected port,
        # do not create duplicates. Wait for its exit instead.
        while (-not $proc.HasExited -and -not (IsListening)) {
          Start-Sleep -Seconds $CheckSeconds
          $proc.Refresh()
        }
      }
    } catch {
      $failures++
      Write-Output ('[WARNING] Existing launcher could not start: ' + $_.Exception.GetType().Name)
    }
    Start-Sleep -Seconds $delay
  }
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
