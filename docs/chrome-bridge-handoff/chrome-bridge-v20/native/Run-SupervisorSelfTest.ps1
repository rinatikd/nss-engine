# Local Windows-only supervisor self-test. Does not execute Codex or connect to MCP.
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
if (!(Test-Path -LiteralPath $vcvars)) { throw 'MSVC_VCVARS_MISSING' }
$source = Join-Path $PSScriptRoot 'job-object-supervisor.cpp'
if (!(Test-Path -LiteralPath $source)) { throw 'SOURCE_MISSING' }
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'chrome-bridge-job-object-supervisor'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$exe = Join-Path $out 'job-object-supervisor.exe'
$script = Join-Path $out 'build-supervisor.cmd'
$lines = [string[]]@(
  '@echo off'
  'setlocal'
  ('call "{0}"' -f $vcvars)
  'if errorlevel 1 exit /b 10'
  ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, $source)
  'exit /b %errorlevel%'
)
[System.IO.File]::WriteAllLines($script, $lines, [System.Text.Encoding]::ASCII)
Write-Host 'Building native supervisor selftest...'
& $script
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw "SUPERVISOR_BUILD_FAILED: $LASTEXITCODE" }
Write-Host 'Running supervisor selftest (15s timeout)...'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.Arguments = '--selftest'
$psi.UseShellExecute = $false
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
try {
  if (!$proc.Start()) { throw 'SUPERVISOR_START_FAILED' }
  if (!$proc.WaitForExit(15000)) {
    try { $proc.Kill() } catch {}
    throw 'SUPERVISOR_SELFTEST_TIMEOUT'
  }
  if ($proc.ExitCode -ne 0) { throw "SUPERVISOR_SELFTEST_FAILED: $($proc.ExitCode)" }
  Write-Host 'SUPERVISOR_SELFTEST_PASS (1/1)'
} finally { $proc.Dispose() }
