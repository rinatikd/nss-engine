# IPC v1.5.6 final lab acceptance (Windows, self-only).
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$tests = @(
    @{ Name = 'Restart gate model'; Script = 'Run-RestartGateSelftest.ps1'; Expected = 'RESTART_GATE_MODEL_PASS: 7/7' }
    @{ Name = 'Native verified release'; Script = 'Run-GatedSupervisorSelftest.ps1'; Expected = 'GATED_SUPERVISOR_SELFTEST_PASS: 3/3' }
    @{ Name = 'Concurrent launch and crash'; Script = 'Run-GateCrashRaceSelftest.ps1'; Expected = 'GATE_CRASH_RACE_SELFTEST_PASS: 5/5' }
    @{ Name = 'Crash tree cleanup'; Script = 'Run-CrashTreeSelftest.ps1'; Expected = 'CRASH_TREE_SELFTEST_PASS: 4/4' }
)
$passed = 0
foreach ($test in $tests) {
    Write-Host "=== IPC FINAL: $($test.Name) ==="
    $file = Join-Path $PSScriptRoot $test.Script
    if (!(Test-Path -LiteralPath $file)) { throw "TEST_MISSING: $file" }
    $lines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file 2>&1)
    $exit = $LASTEXITCODE
    foreach ($line in $lines) { Write-Host $line }
    if ($exit -ne 0) { throw "FINAL_SUITE_FAILED: $($test.Script) exit=$exit" }
    if (($lines -join [Environment]::NewLine) -notmatch [regex]::Escape($test.Expected)) {
        throw "FINAL_SUITE_MISSING_PASS_MARKER: $($test.Script)"
    }
    $passed++
}
Write-Host "IPC_FINAL_LAB_ACCEPTANCE_PASS: $passed/4 suites; 19/19 assertions"
Write-Host 'IPC_PRODUCTION_RECOVERY: NOT_AUTHORIZED'
Write-Host 'IPC_STALE_MARKER_AUTO_RELEASE: DISABLED'
