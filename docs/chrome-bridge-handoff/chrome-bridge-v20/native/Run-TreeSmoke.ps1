# Lab-only, self-spawning Windows Job Object descendant smoke.
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
$source = Join-Path $PSScriptRoot 'job-object-tree-smoke.cpp'
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'chrome-bridge-job-object-tree-smoke'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$exe = Join-Path $out 'job-object-tree-smoke.exe'
$script = Join-Path $out 'build-tree-smoke.cmd'
$lines = [string[]]@(
  '@echo off'
  'setlocal'
  ('call "{0}"' -f $vcvars)
  'if errorlevel 1 exit /b 10'
  ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, $source)
  'exit /b %errorlevel%'
)
[System.IO.File]::WriteAllLines($script, $lines, [System.Text.Encoding]::ASCII)
& $script
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw "TREE_SMOKE_BUILD_FAILED: $LASTEXITCODE" }
$proc = Start-Process -FilePath $exe -ArgumentList '--selftest' -PassThru -Wait -NoNewWindow
if ($proc.ExitCode -ne 0) { throw "TREE_SMOKE_FAILED: $($proc.ExitCode)" }
Write-Host 'TREE_SMOKE_PARTIAL_PASS: second-level descendant observed in Job Object; grandchild PID verification pending'
