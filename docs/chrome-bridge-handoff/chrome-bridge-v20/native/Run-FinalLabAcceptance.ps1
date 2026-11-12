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
    # Redirect stdout/stderr to separate lab-only files: expected native stderr
    # must not be promoted to a terminating PowerShell error by 2>&1.
    $captureDir = Join-Path ([System.IO.Path]::GetTempPath()) ('cb-final-capture-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $captureDir -Force | Out-Null
    try {
        $stdout = Join-Path $captureDir 'stdout.txt'
        $stderr = Join-Path $captureDir 'stderr.txt'
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $file)
        ) -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $exit = $proc.ExitCode
        $outText = if (Test-Path $stdout) { Get-Content -LiteralPath $stdout -Raw } else { '' }
        $errText = if (Test-Path $stderr) { Get-Content -LiteralPath $stderr -Raw } else { '' }
        if ($outText) { Write-Host $outText }
        if ($errText) { Write-Host $errText }
        $combined = $outText + [Environment]::NewLine + $errText
    } finally {
        Remove-Item -LiteralPath $captureDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($exit -ne 0) { throw "FINAL_SUITE_FAILED: $($test.Script) exit=$exit" }
    if ($combined -notmatch [regex]::Escape($test.Expected)) {
        throw "FINAL_SUITE_MISSING_PASS_MARKER: $($test.Script)"
    }
    $passed++
}
Write-Host "IPC_FINAL_LAB_ACCEPTANCE_PASS: $passed/4 suites; 19/19 assertions"
Write-Host 'IPC_PRODUCTION_RECOVERY: NOT_AUTHORIZED'
Write-Host 'IPC_STALE_MARKER_AUTO_RELEASE: DISABLED'
