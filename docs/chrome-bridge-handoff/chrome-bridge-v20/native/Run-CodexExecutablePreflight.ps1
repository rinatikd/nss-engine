# Windows-only, isolated native executable path preflight. Never runs Codex.
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
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('cb-codex-path-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$exe = Join-Path $root 'codex-executable-preflight.exe'
$cmd = Join-Path $root 'build.cmd'
try {
    [System.IO.File]::WriteAllLines($cmd, [string[]]@(
        '@echo off'
        ('call "{0}"' -f $vcvars)
        'if errorlevel 1 exit /b 10'
        ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, (Join-Path $PSScriptRoot 'codex-executable-preflight.cpp'))
        'exit /b %errorlevel%'
    ), [System.Text.Encoding]::ASCII)
    & $cmd
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw 'CODEX_PREFLIGHT_BUILD_FAILED' }
    $fake = Join-Path $root 'codex.exe'
    [System.IO.File]::WriteAllBytes($fake, [byte[]](77,90,0,0))
    $tests = 0
    & $exe $fake
    if ($LASTEXITCODE -ne 0) { throw 'EXPECTED_REGULAR_FILE_ALLOWED' }
    $tests++
    & $exe (Join-Path $root 'missing\codex.exe')
    if ($LASTEXITCODE -ne 22) { throw 'EXPECTED_MISSING_PATH_DENIED' }
    $tests++
    & $exe (Join-Path $root 'other.exe')
    if ($LASTEXITCODE -ne 21) { throw 'EXPECTED_NAME_DENIED' }
    $tests++
    & $exe '\\server\share\codex.exe'
    if ($LASTEXITCODE -ne 20) { throw 'EXPECTED_UNC_DENIED' }
    $tests++
    $link = Join-Path $root 'redirect'
    try {
        New-Item -ItemType SymbolicLink -Path $link -Target $root -ErrorAction Stop | Out-Null
        & $exe (Join-Path $link 'codex.exe')
        if ($LASTEXITCODE -ne 22) { throw 'EXPECTED_REPARSE_DENIED' }
        $tests++
    } catch [System.UnauthorizedAccessException] {
        Write-Host 'SYMLINK_CASE_SKIPPED: insufficient local privilege'
    }
    Write-Host "CODEX_EXECUTABLE_PREFLIGHT_PASS: $tests cases"
    Write-Host 'NO_EXECUTABLE_ATTESTATION: signature and hash not verified'
    Write-Host 'CODEX_EXECUTION: DISABLED'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
