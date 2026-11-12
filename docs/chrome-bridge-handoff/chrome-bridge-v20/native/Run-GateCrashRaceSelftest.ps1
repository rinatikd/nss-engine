# IPC v1.5.3: lab-only race/crash test. No Codex, no production services.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vs) { throw 'MSVC_X64_TOOLSET_MISSING' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('chrome-bridge-ipc153-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$exe = Join-Path $root 'job-object-supervisor.exe'
$marker = Join-Path $root 'unclean.json'
$cmd = Join-Path $root 'build.cmd'
$holder = $null
try {
    [System.IO.File]::WriteAllLines($cmd, [string[]]@(
        '@echo off'
        ('call "{0}"' -f $vcvars)
        'if errorlevel 1 exit /b 10'
        ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, (Join-Path $PSScriptRoot 'job-object-supervisor.cpp'))
        'exit /b %errorlevel%'
    ), [System.Text.Encoding]::ASCII)
    & $cmd
    if ($LASTEXITCODE -ne 0 -or !(Test-Path $exe)) { throw "BUILD_FAILED: $LASTEXITCODE" }
    $env:CB_LAB_GATE_HOLD_MS = '12000'
    $out = Join-Path $root 'holder.out'
    $err = Join-Path $root 'holder.err'
    $holder = Start-Process -FilePath $exe -ArgumentList @('--gated-selftest', ('"{0}"' -f $marker)) -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($holder.HasExited) { throw "HOLDER_EXITED_EARLY: $($holder.ExitCode)" }
        if ((Test-Path $out) -and ((Get-Content $out -Raw) -match 'GATE_HOLD_ACTIVE')) { break }
        Start-Sleep -Milliseconds 50
    }
    if (!(Test-Path $out) -or ((Get-Content $out -Raw) -notmatch 'GATE_HOLD_ACTIVE')) { throw 'HOLDER_NOT_READY' }
    if (!(Test-Path $marker)) { throw 'RESERVATION_NOT_DURABLE' }
    Write-Host 'GATE_RACE_PASS: first supervisor reserved before child completion'
    & $exe --gated-selftest $marker
    if ($LASTEXITCODE -ne 40 -or !(Test-Path $marker)) { throw "CONCURRENT_LAUNCH_NOT_DENIED: $LASTEXITCODE" }
    Write-Host 'GATE_RACE_PASS: concurrent supervisor denied'
    Stop-Process -Id $holder.Id -Force -ErrorAction Stop
    $holder.WaitForExit(5000) | Out-Null
    if (!$holder.HasExited) { throw 'SUPERVISOR_KILL_UNCONFIRMED' }
    if (!(Test-Path $marker)) { throw 'CRASH_MARKER_MISSING' }
    Write-Host 'GATE_CRASH_PASS: durable marker survived supervisor termination'
    & $exe --gated-selftest $marker
    if ($LASTEXITCODE -ne 40 -or !(Test-Path $marker)) { throw "CRASH_RESTART_NOT_DENIED: $LASTEXITCODE" }
    Write-Host 'GATE_CRASH_PASS: restart denied after unverified cleanup'
    Write-Host 'GATE_CRASH_RACE_SELFTEST_PASS: 4/4'
} finally {
    Remove-Item Env:\CB_LAB_GATE_HOLD_MS -ErrorAction SilentlyContinue
    if ($null -ne $holder -and !$holder.HasExited) {
        Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue
        $holder.WaitForExit(5000) | Out-Null
    }
    # Unique disposable lab directory only. Never clear persistent recovery markers.
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
