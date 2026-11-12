# IPC v1.6: lab-only negative recovery tests. No recovery unlock implemented.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vs) { throw 'MSVC_X64_TOOLSET_MISSING' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('cb-ipc16-negative-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$exe = Join-Path $root 'job-object-supervisor.exe'
$build = Join-Path $root 'build.cmd'
try {
    [System.IO.File]::WriteAllLines($build, [string[]]@(
        '@echo off'
        ('call "{0}"' -f $vcvars)
        'if errorlevel 1 exit /b 10'
        ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, (Join-Path $PSScriptRoot 'job-object-supervisor.cpp'))
        'exit /b %errorlevel%'
    ), [System.Text.Encoding]::ASCII)
    & $build
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw 'BUILD_FAILED' }
    $cases = @(
        @{ Name='corrupt-json'; Content='{not-json' },
        @{ Name='truncated'; Content='{"schema":1' },
        @{ Name='unknown-version'; Content='{"schema":999,"state":"unclean"}' },
        @{ Name='empty-marker'; Content='' },
        @{ Name='apparently-clean'; Content='{"schema":1,"state":"clean"}' }
    )
    $count = 0
    foreach ($case in $cases) {
        $marker = Join-Path $root ($case.Name + '.json')
        [System.IO.File]::WriteAllText($marker, $case.Content)
        $before = [System.IO.File]::ReadAllBytes($marker)
        & $exe --gated-selftest $marker 2>$null
        $exit = $LASTEXITCODE
        $after = [System.IO.File]::ReadAllBytes($marker)
        if ($exit -ne 40 -or !(Test-Path -LiteralPath $marker) -or
            ![System.Linq.Enumerable]::SequenceEqual([byte[]]$before, [byte[]]$after)) {
            throw "FAIL_CLOSED_VIOLATION: $($case.Name), exit=$exit"
        }
        $count++
        Write-Host "RECOVERY_NEGATIVE_PASS: $($case.Name) denied and marker preserved"
    }
    Write-Host "RECOVERY_NEGATIVE_SELFTEST_PASS: $count/5"
    Write-Host 'RECOVERY_AUTO_UNLOCK: NOT_IMPLEMENTED'
} finally {
    # Remove only this uniquely generated disposable lab fixture.
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
