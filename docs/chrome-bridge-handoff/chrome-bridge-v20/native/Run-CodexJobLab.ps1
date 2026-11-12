# Builds and runs the lab-only native Codex --version Job Object proof.
# Never connects to Chrome Bridge or changes production settings.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$identity = Join-Path $PSScriptRoot 'Test-CodexExecutableIdentity.ps1'
& $identity
if ($LASTEXITCODE -ne 0) { throw 'IDENTITY_GATE_FAILED' }
$release = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\packages\standalone\releases\0.166.0-x86_64-pc-windows-msvc\bin\codex.exe'
$vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'MSVC_NOT_INSTALLED' }
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vs) { throw 'MSVC_X64_TOOLSET_MISSING' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$root = Join-Path ([IO.Path]::GetTempPath()) ('cb-codex-job-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$exe = Join-Path $root 'codex-job-lab.exe'
$cmd = Join-Path $root 'build.cmd'
try {
    [IO.File]::WriteAllLines($cmd, [string[]]@(
        '@echo off'
        ('call "{0}"' -f $vcvars)
        'if errorlevel 1 exit /b 10'
        ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}" /link wintrust.lib crypt32.lib bcrypt.lib' -f $exe, (Join-Path $PSScriptRoot 'codex-job-lab.cpp'))
        'exit /b %errorlevel%'
    ), [Text.Encoding]::ASCII)
    & $cmd
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw 'CODEX_JOB_LAB_BUILD_FAILED' }
    & $exe $release
    if ($LASTEXITCODE -ne 0) { throw "CODEX_JOB_LAB_FAILED: $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
