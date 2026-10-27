[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Status', 'Remove')]
    [string]$Mode,
    [string]$ConfirmInstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'NSS-Codex-GitHub-Inbox-0057A'

if ($Mode -eq 'Status') {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        [pscustomobject]@{ TaskName = $taskName; Installed = $false; State = 'NOT_INSTALLED' } |
            ConvertTo-Json -Compress
        exit 0
    }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    [pscustomobject]@{
        TaskName = $taskName
        Installed = $true
        State = [string]$task.State
        LastRunTime = $info.LastRunTime
        LastTaskResult = $info.LastTaskResult
        NextRunTime = $info.NextRunTime
        Actions = @($task.Actions | ForEach-Object { $_.Execute })
    } | ConvertTo-Json -Compress
    exit 0
}

if ($Mode -eq 'Remove') {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    [pscustomobject]@{ TaskName = $taskName; Removed = $true } | ConvertTo-Json -Compress
    exit 0
}

if ($ConfirmInstall -cne 'INSTALL READ-ONLY INBOX 0057A') {
    throw "Install requires -ConfirmInstall 'INSTALL READ-ONLY INBOX 0057A'. No task was registered."
}
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw "Task '$taskName' already exists; use Status or explicitly Remove it before installing. No task was changed."
}

$python = (Get-Command python.exe -ErrorAction Stop).Source
$python = [System.IO.Path]::GetFullPath($python)
$scriptPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'inbox.py'))
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable for this user; no task was registered.' }
$dbPath = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NSSCodexInbox0057A\inbox.sqlite3'))
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Inbox source is missing: $scriptPath"
}

$arguments = '"{0}" scan-once --db "{1}"' -f $scriptPath, $dbPath
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory (Split-Path -Parent $scriptPath)
$startup = New-ScheduledTaskTrigger -AtStartup
$interval = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited
$description = 'Read-only public GitHub inbox for NSS Engine Issues 54 and 57; never launches Codex.'

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($startup, $interval) `
    -Settings $settings -Principal $principal -Description $description | Out-Null
Start-ScheduledTask -TaskName $taskName
[pscustomobject]@{ TaskName = $taskName; Installed = $true; State = 'REGISTERED_AND_STARTED' } |
    ConvertTo-Json -Compress
