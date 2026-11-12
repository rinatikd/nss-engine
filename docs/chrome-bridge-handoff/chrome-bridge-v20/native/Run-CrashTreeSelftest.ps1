# IPC v1.5.5: isolated controller-crash tree cleanup and fail-closed marker.
# No Codex, network, elevation, or production state.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vs) { throw 'MSVC_X64_TOOLSET_MISSING' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('chrome-bridge-ipc155-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$exe = Join-Path $root 'job-object-tree-smoke.exe'
$supervisorExe = Join-Path $root 'job-object-supervisor.exe'
$marker = Join-Path $root 'unclean.json'
$cmd = Join-Path $root 'build.cmd'
$controller = $null
$members = @()
try {
    [System.IO.File]::WriteAllLines($cmd, [string[]]@(
        '@echo off'
        ('call "{0}"' -f $vcvars)
        'if errorlevel 1 exit /b 10'
        ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, (Join-Path $PSScriptRoot 'job-object-tree-smoke.cpp'))
        'if errorlevel 1 exit /b 11'
        ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $supervisorExe, (Join-Path $PSScriptRoot 'job-object-supervisor.cpp'))
        'exit /b %errorlevel%'
    ), [System.Text.Encoding]::ASCII)
    & $cmd
    if ($LASTEXITCODE -ne 0 -or !(Test-Path $exe) -or !(Test-Path $supervisorExe)) { throw "CRASH_TREE_BUILD_FAILED: $LASTEXITCODE" }

    # Unique disposable marker stands in for an unclean reservation; never auto-clear it.
    [System.IO.File]::WriteAllText($marker, '{"state":"unclean","schema":1}')
    $stdout = Join-Path $root 'controller.out'
    $stderr = Join-Path $root 'controller.err'
    $controller = Start-Process -FilePath $exe -ArgumentList '--crash-controller' -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $output = ''
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($controller.HasExited) { throw "CRASH_CONTROLLER_EARLY_EXIT: $($controller.ExitCode)" }
        if (Test-Path $stdout) { $output = Get-Content -LiteralPath $stdout -Raw }
        if ($output -match 'CRASH_CONTROLLER_READY') { break }
        Start-Sleep -Milliseconds 50
    }
    if ($output -notmatch 'CRASH_CONTROLLER_READY') { throw "CRASH_CONTROLLER_NOT_READY: $output" }
    $pids = @([regex]::Matches($output, 'CRASH_MEMBER_PID=(\d+)') | ForEach-Object { [int]$_.Groups[1].Value })
    $childMatch = [regex]::Match($output, 'CRASH_CHILD_PID=(\d+)')
    $grandMatch = [regex]::Match($output, 'CRASH_GRANDCHILD_PID=(\d+)')
    if (!$childMatch.Success -or !$grandMatch.Success -or $pids.Count -lt 2) { throw "INCOMPLETE_MEMBER_SNAPSHOT: $output" }
    $childPid = [int]$childMatch.Groups[1].Value
    $grandPid = [int]$grandMatch.Groups[1].Value
    if ($pids -notcontains $childPid -or $pids -notcontains $grandPid) { throw 'CHILD_NOT_IN_JOB_SNAPSHOT' }
    if (@($pids | Select-Object -Unique).Count -ne $pids.Count) { throw 'DUPLICATE_MEMBER_PIDS' }

    # Retain Windows process handles before killing the controller to prevent PID reuse ambiguity.
    foreach ($memberPid in $pids) {
        $p = Get-Process -Id $memberPid -ErrorAction Stop
        if ($p.HasExited) { throw "MEMBER_EXITED_BEFORE_CRASH: $memberPid" }
        $members += $p
    }
    Write-Host "CRASH_TREE_PASS: captured $($members.Count) live Job Object member handles"
    Stop-Process -Id $controller.Id -Force -ErrorAction Stop
    if (!$controller.WaitForExit(5000)) { throw 'CONTROLLER_TERMINATION_UNCONFIRMED' }
    Write-Host 'CRASH_TREE_PASS: controller terminated'
    foreach ($p in $members) {
        if (!$p.WaitForExit(5000)) { throw "JOB_MEMBER_SURVIVED_CRASH: $($p.Id)" }
    }
    Write-Host "CRASH_TREE_PASS: all $($members.Count) captured Job Object members terminated"
    if (!(Test-Path -LiteralPath $marker)) { throw 'UNCLEAN_MARKER_MISSING' }
    & $supervisorExe --gated-selftest $marker
    if ($LASTEXITCODE -ne 40 -or !(Test-Path -LiteralPath $marker)) { throw "UNVERIFIED_RESTART_NOT_DENIED: $LASTEXITCODE" }
    Write-Host 'CRASH_TREE_PASS: persistent marker still denies restart'
    Write-Host 'CRASH_TREE_SELFTEST_PASS: 4/4'
} finally {
    if ($null -ne $controller -and !$controller.HasExited) {
        Stop-Process -Id $controller.Id -Force -ErrorAction SilentlyContinue
        $controller.WaitForExit(5000) | Out-Null
    }
    foreach ($p in $members) { $p.Dispose() }
    # Only delete this unique temporary fixture, not an actual recovery marker.
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
