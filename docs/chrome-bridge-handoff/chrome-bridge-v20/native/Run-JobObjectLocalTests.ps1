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
$buildCommand = 'call "' + $vcvars + '" && cl /nologo /std:c++17 /EHsc /W4 /WX /Fe:"' + $exe + '" "' + $sourcePath + '"'
Write-Host 'Building isolated Job Object smoke...'
& cmd.exe /d /s /c ('"' + $buildCommand + '"')
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw "MSVC_BUILD_FAILED: $LASTEXITCODE" }
$cases = @(
  @{ Name = 'normal-exit'; Args = @("$env:WINDIR\System32\cmd.exe") },
  @{ Name = 'kill-on-close'; Args = @('--kill-on-close', ('"' + $exe + '"')) },
  @{ Name = 'pipe-echo'; Args = @('--pipe-echo', ('"' + $exe + '"')) }
)
$results = @()
foreach ($case in $cases) {
  Write-Host "Testing $($case.Name)..."
  $proc = Start-Process -FilePath $exe -ArgumentList $case.Args -PassThru -NoNewWindow
  $timedOut = -not $proc.WaitForExit(15000)
  if ($timedOut) {
    try { $proc.Kill($true) } catch { Write-Warning "Kill failed: $_" }
    try { $null = $proc.WaitForExit(5000) } catch {}
  }
  $code = if ($timedOut) { -1 } else { $proc.ExitCode }
  $passed = !$timedOut -and $code -eq 0
  $results += [pscustomobject]@{ test = $case.Name; passed = $passed; exitCode = $code; timedOut = $timedOut }
  Write-Host "$($case.Name): $(if ($passed) { 'PASS' } else { 'FAIL' })"
}
ConvertTo-Json -InputObject $results -Depth 5 | Set-Content -LiteralPath $report -Encoding UTF8
Write-Host "Report: $report"
if (@($results | Where-Object { -not $_.passed }).Count -gt 0) { throw 'NATIVE_SMOKE_FAILED' }
Write-Host 'NATIVE_SMOKE_PASS (3/3)'
