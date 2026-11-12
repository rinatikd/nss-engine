# Lab-only real Windows Node <-> native supervisor roundtrip. No Codex, no production services.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$node = Get-Command node.exe -ErrorAction Stop
$vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'MSVC_NOT_INSTALLED' }
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vs) { throw 'MSVC_X64_TOOLSET_MISSING' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('cb-node-native-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$exe = Join-Path $root 'job-object-supervisor.exe'
$build = Join-Path $root 'build.cmd'
$server = Join-Path (Split-Path -Parent $PSScriptRoot) 'server'
try {
    [System.IO.File]::WriteAllLines($build, [string[]]@(
        '@echo off'
        ('call "{0}"' -f $vcvars)
        'if errorlevel 1 exit /b 10'
        ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, (Join-Path $PSScriptRoot 'job-object-supervisor.cpp'))
        'exit /b %errorlevel%'
    ), [System.Text.Encoding]::ASCII)
    & $build
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw "NATIVE_BUILD_FAILED: $LASTEXITCODE" }
    $env:CB_NATIVE_SUPERVISOR_EXE = $exe
    $tests = @(
        (Join-Path $server 'native-broker-protocol.test.mjs'),
        (Join-Path $server 'native-selftest-client.test.mjs'),
        (Join-Path $server 'native-supervisor-failure.test.mjs')
    )
    # Existing failure tests use a different fixed binary path and may skip.
    # The dedicated selftest-client test above MUST execute and pass.
    $capture = Join-Path $root 'node-test-output.txt'
    & $node.Source --test $tests[0] $tests[1] *> $capture
    $exit = $LASTEXITCODE
    $output = Get-Content -LiteralPath $capture -Raw
    Write-Host $output
    if ($exit -ne 0) { throw "NODE_NATIVE_TEST_FAILED: $exit" }
    if ($output -notmatch 'self-only native supervisor returns ready then OS-verified terminated') {
        throw 'NODE_NATIVE_TEST_MISSING_ROUNDTRIP'
    }
    if ($output -match '(?m)^# skipped [1-9]') { throw 'NODE_NATIVE_TEST_SKIPPED' }
    Write-Host 'NODE_NATIVE_ROUNDTRIP_PASS: real Windows supervisor protocol exercised'
    Write-Host 'CODEX_EXECUTION: DISABLED'
    Write-Host 'PRODUCTION_CHANGED: NO'
} finally {
    Remove-Item Env:CB_NATIVE_SUPERVISOR_EXE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
