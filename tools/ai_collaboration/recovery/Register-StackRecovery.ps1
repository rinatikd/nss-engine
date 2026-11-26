# Opt-in CURRENT-USER (non-admin) Windows Scheduled Task.
# Default Check does not register anything.
[CmdletBinding()]
param(
  [ValidateSet('Check','Register','Unregister')]
  [string]$Mode = 'Check',
  [switch]$DesktopShortcut
)

$ErrorActionPreference = 'Stop'
$taskName = 'ChromeBridge-Stack-Recovery-User'
$entrypoint = Join-Path $PSScriptRoot 'Invoke-VerifiedRecovery.ps1'
$manualScript = Join-Path $PSScriptRoot 'Restore-StackWithReport.ps1'
$powerShellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf) -or
    -not (Test-Path -LiteralPath $manualScript -PathType Leaf)) {
  throw 'RECOVERY_SCRIPT_NOT_FOUND'
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($Mode -eq 'Check') {
  $taskState = 'NotInstalled'
  if ($null -ne $task) {
    $taskState = [string]$task.State
  }
  [PSCustomObject]@{
    TaskName = $taskName
    Installed = [bool]($null -ne $task)
    State = $taskState
    Script = $entrypoint
  } | ConvertTo-Json
  return
}

if ($Mode -eq 'Unregister') {
  if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  Write-Host 'RECOVERY_TASK_REMOVED'
  return
}

if ($null -ne $task) {
  throw 'TASK_ALREADY_EXISTS_REVIEW_BEFORE_REPLACING'
}

& $entrypoint -Mode Verify | Out-Null

$releaseRoot = [IO.Path]::GetFullPath('C:\Engineering\ChromeBridge-Recovery-Release').TrimEnd([char]92)
$fullScriptRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char]92)
if ($fullScriptRoot -ine $releaseRoot) {
  throw 'INSTALL_ONLY_FROM_REVIEWED_RELEASE_COPY'
}

$actionArguments = '-NoProfile -NonInteractive -File "{0}" -Mode Watchdog' -f $entrypoint
$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $actionArguments
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Restore approved Chrome Bridge lab services at user logon; production untouched' | Out-Null
Write-Host 'RECOVERY_TASK_REGISTERED'

if ($DesktopShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $link = Join-Path $desktop 'Восстановить Chrome Bridge.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = $powerShellExe
  $shortcutArguments = '-NoProfile -Sta -File "{0}"' -f $manualScript
  $shortcut.Arguments = $shortcutArguments
  $shortcut.WorkingDirectory = $PSScriptRoot
  $shortcut.Description = 'One-click restore of approved local Chrome Bridge stack'
  $shortcut.Save()
  Write-Host 'RECOVERY_DESKTOP_SHORTCUT_CREATED'
}
