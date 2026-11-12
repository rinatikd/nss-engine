# Lab-only, cross-invocation Start/Status/Cancel for an INTERNAL sleeping child.
# Does not launch Codex CLI, open a network listener, or touch Chrome Bridge production.
[CmdletBinding(DefaultParameterSetName='Status')]
param(
    [Parameter(Mandatory,ParameterSetName='Start')][switch]$Start,
    [Parameter(Mandatory,ParameterSetName='Status')][switch]$Status,
    [Parameter(Mandatory,ParameterSetName='Cancel')][switch]$Cancel,
    [Parameter(ParameterSetName='Status')][Parameter(ParameterSetName='Cancel')][string]$JobId,
    [Parameter(ParameterSetName='Start')][switch]$Build
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$base=Join-Path $env:LOCALAPPDATA 'ChromeBridge-CodexJob-Lab'
$jobsDir=Join-Path $base 'jobs'
$binDir=Join-Path $base 'bin'
$exe=Join-Path $binDir 'codex-job-lab.exe'
[IO.Directory]::CreateDirectory($jobsDir) | Out-Null
[IO.Directory]::CreateDirectory($binDir) | Out-Null
function Get-Record([string]$id) {
    if ($id -notmatch '^[0-9a-f]{32}$') { throw 'INVALID_JOB_ID' }
    $file=Join-Path $jobsDir ($id+'.json')
    if (!(Test-Path -LiteralPath $file)) { throw 'JOB_ID_NOT_FOUND' }
    return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json)
}
function Save-Record($rec) {
    $file=Join-Path $jobsDir ($rec.id+'.json')
    $tmp=Join-Path $jobsDir ($rec.id+'.'+[guid]::NewGuid().ToString('N')+'.tmp')
    try {
        [IO.File]::WriteAllText($tmp,($rec | ConvertTo-Json -Depth 5),[Text.Encoding]::UTF8)
        Move-Item -LiteralPath $tmp -Destination $file -Force
    } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
function Get-LiveProcess($rec) {
    try {
        $p=[Diagnostics.Process]::GetProcessById([int]$rec.pid)
        if ($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks -ne [long]$rec.startTicksUtc) { $p.Dispose(); return $null }
        return $p
    } catch { return $null }
}
function Get-JobState($rec) {
    $p=Get-LiveProcess $rec
    if ($null -ne $p) { $p.Dispose(); return 'RUNNING' }
    $output=''
    if (Test-Path -LiteralPath $rec.stdout) { $output=Get-Content -LiteralPath $rec.stdout -Raw }
    if ($output.Contains('CODEX_JOB_EXTERNAL_CANCEL_CLEANUP_PASS')) { return 'CANCELLED' }
    return 'EXITED_UNVERIFIED'
}
if ($Start) {
    if ($Build -or !(Test-Path -LiteralPath $exe)) {
        # Build into a persistent, per-user lab directory; no model invocation.
        $vswhere=Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (!(Test-Path -LiteralPath $vswhere)) { throw 'MSVC_NOT_INSTALLED' }
        $vs=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
        if (!$vs) { throw 'MSVC_X64_TOOLSET_MISSING' }
        $vcvars=Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
        $buildCmd=Join-Path $binDir 'build.cmd'
        [IO.File]::WriteAllLines($buildCmd,[string[]]@(
            '@echo off',
            ('call "{0}"' -f $vcvars),
            'if errorlevel 1 exit /b 10',
            ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}" /link wintrust.lib crypt32.lib bcrypt.lib' -f $exe,(Join-Path $PSScriptRoot 'codex-job-lab.cpp')),
            'exit /b %errorlevel%'
        ),[Text.Encoding]::ASCII)
        & $buildCmd
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw 'LAB_BUILD_FAILED' }
    }
    $id=[guid]::NewGuid().ToString('N')
    $eventName='Local\CB_CodexLabCancel_'+$id
    $stdout=Join-Path $jobsDir ($id+'.stdout.txt')
    $stderr=Join-Path $jobsDir ($id+'.stderr.txt')
    $proc=Start-Process -FilePath $exe -ArgumentList @('--selftest-external-cancel',$eventName) -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden
    $signal=$null
    try {
        for ($i=0;$i -lt 100;$i++) {
            try { $signal=[Threading.EventWaitHandle]::OpenExisting($eventName); break }
            catch [Threading.WaitHandleCannotBeOpenedException] {
                if ($proc.HasExited) { throw 'JOB_EXITED_BEFORE_READY' }
                Start-Sleep -Milliseconds 50
            }
        }
        if (!$signal) { throw 'JOB_READY_TIMEOUT' }
        $rec=[pscustomobject]@{
            id=$id; pid=$proc.Id; startTicksUtc=$proc.StartTime.ToUniversalTime().Ticks
            eventName=$eventName; stdout=$stdout; stderr=$stderr
            createdUtc=[DateTime]::UtcNow.ToString('o'); mode='INTERNAL_SELFTEST_ONLY'
        }
        Save-Record $rec
        Write-Host "CODEX_JOB_ID: $id"
        Write-Host 'CODEX_JOB_STATUS: RUNNING'
        Write-Host 'CODEX_NOT_INVOKED'
    } finally {
        if ($signal) { $signal.Dispose() }
        $proc.Dispose()
    }
} elseif ($Cancel) {
    $rec=Get-Record $JobId
    $state=Get-JobState $rec
    if ($state -ne 'RUNNING') { Write-Host "CODEX_JOB_STATUS: $state"; return }
    $p=Get-LiveProcess $rec
    if (!$p) { Write-Host 'CODEX_JOB_STATUS: EXITED_UNVERIFIED'; return }
    $p.Dispose()
    try { $signal=[Threading.EventWaitHandle]::OpenExisting([string]$rec.eventName) }
    catch [Threading.WaitHandleCannotBeOpenedException] { throw 'CANCEL_EVENT_NOT_FOUND' }
    try { [void]$signal.Set(); Write-Host 'CODEX_JOB_CANCEL: SIGNAL_SENT' }
    finally { $signal.Dispose() }
} else {
    $rec=Get-Record $JobId
    Write-Host "CODEX_JOB_ID: $($rec.id)"
    Write-Host "CODEX_JOB_STATUS: $(Get-JobState $rec)"
    Write-Host 'CODEX_NOT_INVOKED'
}
