# Explicit opt-in to keep the original Chrome Bridge server alive at logon.
# Dry-run by default. No changes to credentials, tunnel, proxy, Codex or server sources.
[CmdletBinding()]
param(
  [string]$BridgeRoot = 'C:\Engineering\chrome-bridge',
  [string]$StartScript = '',
  [switch]$Apply,
  [switch]$Remove
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'ChromeBridge-Server-17381'
$root = [IO.Path]::GetFullPath($BridgeRoot)
if (-not $StartScript) { $StartScript = Join-Path $root 'Start-Bridge.ps1' }
$launcher = [IO.Path]::GetFullPath($StartScript)
$watcher = Join-Path $PSScriptRoot 'watch-bridge.ps1'
if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
  throw 'Windows ScheduledTasks module unavailable'
}
if ($Remove) {
  if (-not $Apply) {
    Write-Output ('[DRY-RUN] Would remove ' + $taskName)
    exit 0
  }
  $prior = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($prior) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  Write-Output '[REMOVED] Watchdog registration removed. Other processes are unchanged.'
  exit 0
}
if (-not (Test-Path -LiteralPath $watcher -PathType Leaf)) { throw 'Watchdog script missing' }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw ('Existing launcher not found: ' + $launcher)
}
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Bridge root missing' }
$principalName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$prior = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($prior) {
  Write-Output ('[EXISTS] ' + $taskName + '; no replacement performed.')
  exit 0
}
# No admin elevation, no stored password and no hidden scheduled task.
$arg = '-NoProfile -ExecutionPolicy Bypass -File "' + $watcher +
  '" -BridgeRoot "' + $root + '" -StartScript "' + $launcher + '"'
Write-Output ('[PLAN] Per-user on-logon watchdog: ' + $taskName)
Write-Output ('[PLAN] User: ' + $principalName)
Write-Output ('[PLAN] Launcher: ' + $launcher)
Write-Output '[PLAN] No service installation and no credentials read.'
if (-not $Apply) { Write-Output '[DRY-RUN] Nothing registered. Add -Apply to opt in.'; exit 0 }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $principalName
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $principalName -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Monitors local Chrome Bridge 17381 and restarts its existing Start-Bridge.ps1 when unavailable' -ErrorAction Stop | Out-Null
Write-Output '[REGISTERED] Starts at next user logon. No existing server was terminated or restarted.'
Write-Output ('[REMOVE] powershell.exe -noprofile -executionpolicy bypass -file "' + $PSCommandPath + '" -remove -apply')
