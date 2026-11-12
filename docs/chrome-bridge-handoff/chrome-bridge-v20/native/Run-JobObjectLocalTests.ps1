# Local-only Windows Job Object smoke tests. No Codex, MCP or production changes.
[CmdletBinding()]
param([string]$Source = '',
      [string]$OutputDirectory = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Source)) {
  $Source = Join-Path $PSScriptRoot 'job-object-smoke.cpp'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'chrome-bridge-job-object-smoke'
}
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
if (!(Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Source missing: $Source" }
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'MSVC_NOT_INSTALLED' }
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vs) { throw 'MSVC_X64_TOOLSET_MISSING' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars)) { throw 'MSVC_VCVARS_MISSING' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$outputPath = (Resolve-Path -LiteralPath $OutputDirectory).Path
$exe = Join-Path $outputPath 'job-object-smoke.exe'
$report = Join-Path $outputPath 'results.json'
# Invoke via a batch file to avoid nested cmd /s /c quoting on Windows PowerShell 5.1.
$buildScript = Join-Path $outputPath 'build-job-object-smoke.cmd'
$buildLines = [string[]]@(
  '@echo off'
  'setlocal'
  ('call "{0}"' -f $vcvars)
  'if errorlevel 1 exit /b 10'
  ('cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"{0}" "{1}"' -f $exe, $sourcePath)
  'exit /b %errorlevel%'
)
if ($buildLines.Count -ne 6) { throw "INVALID_BUILD_SCRIPT_LINE_COUNT: $($buildLines.Count)" }
[System.IO.File]::WriteAllLines($buildScript, [string[]]$buildLines, [System.Text.Encoding]::ASCII)
Write-Host 'Building isolated Job Object smoke...'
Write-Host "Build script: $buildScript"
Write-Host ('Build command: ' + $buildLines[4])
& $buildScript
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw "MSVC_BUILD_FAILED: $LASTEXITCODE" }
$cases = @(
  @{ Name = 'normal-exit'; Args = @("$env:WINDIR\System32\cmd.exe") },
  @{ Name = 'kill-on-close'; Args = @('--kill-on-close', ('"' + $exe + '"')) },
  @{ Name = 'pipe-echo'; Args = @('--pipe-echo', ('"' + $exe + '"')) }
)
$results = @()
foreach ($case in $cases) {
  Write-Host "Testing $($case.Name)..."
  # Use .NET Process directly: PowerShell 5.1 Start-Process -PassThru may
  # return an object with a null ExitCode even after WaitForExit.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = [string]::Join(' ', [string[]]$case.Args)
  $psi.UseShellExecute = $false
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  try {
    if (-not $proc.Start()) { throw "PROCESS_START_FAILED: $($case.Name)" }
    $timedOut = -not $proc.WaitForExit(15000)
    if ($timedOut) {
      try { $proc.Kill() } catch { Write-Warning "Kill failed: $_" }
      try { $null = $proc.WaitForExit(5000) } catch {}
    }
    $code = if ($timedOut) { -1 } else { [int]$proc.ExitCode }
    $passed = (!$timedOut -and $code -eq 0)
  } finally {
    $proc.Dispose()
  }
  $results += [pscustomobject]@{ test = $case.Name; passed = $passed; exitCode = $code; timedOut = $timedOut }
  Write-Host "$($case.Name): $(if ($passed) { 'PASS' } else { 'FAIL' }) (exit=$code; timeout=$timedOut)"
}
ConvertTo-Json -InputObject $results -Depth 5 | Set-Content -LiteralPath $report -Encoding UTF8
Write-Host "Report: $report"
if (@($results | Where-Object { -not $_.passed }).Count -gt 0) { throw 'NATIVE_SMOKE_FAILED' }
Write-Host 'NATIVE_SMOKE_PASS (3/3)'
