# IPC v1.5.2 Windows native-supervisor lab test; self-only, no Codex.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'MSVC_NOT_INSTALLED' }
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vs) { throw 'MSVC_X64_TOOLSET_MISSING' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('chrome-bridge-ipc152-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$exe = Join-Path $root 'job-object-supervisor.exe'
$marker = Join-Path $root 'unclean.json'
$cmd = Join-Path $root 'build.cmd'
try {
    [System.IO.File]::WriteAllLines($cmd, [string[]]@(
        '@echo off'
        ('call "{0}"' -f $vcvars)
        'if errorlevel 1 exit /b 10'
        ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, (Join-Path $PSScriptRoot 'job-object-supervisor.cpp'))
        'exit /b %errorlevel%'
    ), [System.Text.Encoding]::ASCII)
    & $cmd
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw "GATED_SUPERVISOR_BUILD_FAILED: $LASTEXITCODE" }
    # Existing marker must prevent any process creation and remain untouched.
    [System.IO.File]::WriteAllText($marker, '{"state":"unclean"}')
    & $exe --gated-selftest $marker
    if ($LASTEXITCODE -ne 40) { throw "EXPECTED_GATE_DENIED: $LASTEXITCODE" }
    if (!(Test-Path -LiteralPath $marker)) { throw 'DENIED_GATE_MARKER_LOST' }
    Write-Host 'GATED_SUPERVISOR_PASS: existing marker denies launch'
    Remove-Item -LiteralPath $marker -Force # Only this isolated test fixture is reset.
    & $exe --gated-selftest $marker
    if ($LASTEXITCODE -ne 0) { throw "GATED_SUPERVISOR_RUN_FAILED: $LASTEXITCODE" }
    if (Test-Path -LiteralPath $marker) { throw 'VERIFIED_CLEANUP_DID_NOT_RELEASE' }
    Write-Host 'GATED_SUPERVISOR_PASS: native OS-verified cleanup released marker'
    & $exe --gated-selftest $marker
    if ($LASTEXITCODE -ne 0) { throw "GATED_SUPERVISOR_RESTART_FAILED: $LASTEXITCODE" }
    Write-Host 'GATED_SUPERVISOR_PASS: next self-only launch permitted'
    Write-Host 'GATED_SUPERVISOR_SELFTEST_PASS: 3/3'
} finally {
    # Unique lab fixture only; never clear production or unknown recovery markers.
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
