# Opt-in CURRENT-USER (non-admin) Windows Scheduled Task.
# Default Check does not register anything.
[CmdletBinding()]
param([ValidateSet('Check','Register','Unregister')][string]$Mode='Check',[switch]$DesktopShortcut)
$ErrorActionPreference='Stop'
$taskName='ChromeBridge-Stack-Recovery-User'
$script=Join-Path $PSScriptRoot 'Recovery-Watchdog.ps1'
$manualScript=Join-Path $PSScriptRoot 'Restore-LocalStack.ps1'
$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
if(!(Test-Path -LiteralPath $script -PathType Leaf) -or !(Test-Path -LiteralPath $manualScript -PathType Leaf)) {throw 'RECOVERY_SCRIPT_NOT_FOUND'}
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($Mode -eq 'Check'){
  [PSCustomObject]@{
    TaskName=$taskName
    Installed=[bool]$task
    State=if($task){[string]$task.State}else{'NotInstalled'}
    Script=$script
  } | ConvertTo-Json
  return
}
if($Mode -eq 'Unregister'){
  if($task){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
  Write-Host 'RECOVERY_TASK_REMOVED'
  return
}
if($task){throw 'TASK_ALREADY_EXISTS_REVIEW_BEFORE_REPLACING'}
if($PSScriptRoot -notlike 'C:\Engineering\ChromeBridge-Recovery-Release*') {
  throw 'INSTALL_ONLY_FROM_REVIEWED_RELEASE_COPY'
}
$action=New-ScheduledTaskAction -Execute $ps -Argument (
  '-NoProfile -NonInteractive -File "'+$script+'" -Attempts 4 -IntervalSeconds 20'
)
$userId=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal=New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Restore approved Chrome Bridge lab services at user logon; production untouched' | Out-Null
Write-Host 'RECOVERY_TASK_REGISTERED'
if($DesktopShortcut) {
  $desktop=[Environment]::GetFolderPath('Desktop')
  $link=Join-Path $desktop 'Восстановить Chrome Bridge.lnk'
  $shell=New-Object -ComObject WScript.Shell
  $shortcut=$shell.CreateShortcut($link)
  $shortcut.TargetPath=$ps
  $shortcut.Arguments='-NoProfile -NonInteractive -File "'+$manualScript+'" -Mode Restore'
  $shortcut.WorkingDirectory=$PSScriptRoot
  $shortcut.Description='One-click restore of approved local Chrome Bridge stack'
  $shortcut.Save()
  Write-Host 'RECOVERY_DESKTOP_SHORTCUT_CREATED'
}
