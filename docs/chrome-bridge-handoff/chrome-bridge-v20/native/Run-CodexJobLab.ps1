# Builds and runs the lab-only native Codex --version Job Object proof.
# Never connects to Chrome Bridge or changes production settings.
[CmdletBinding()]
param([switch]$ExecLab, [switch]$NegativeTests, [switch]$ExternalCancelTest, [switch]$JobLifecycleTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$identity = Join-Path $PSScriptRoot 'Test-CodexExecutableIdentity.ps1'
# PowerShell scripts do not necessarily set LASTEXITCODE. Under StrictMode,
# an unset LASTEXITCODE raises VariableIsUndefined even when the gate passed.
# The identity script throws on failure; a normal return means success.
& $identity
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
    if ($JobLifecycleTest) {
        if ($ExecLab -or $NegativeTests -or $ExternalCancelTest) { throw 'TEST_MODES_MUTUALLY_EXCLUSIVE' }
        # Single-session, in-memory job registry; no persistent broker or Chrome Bridge integration.
        $jobs = @{}
        $jobId = [guid]::NewGuid().ToString('N')
        $eventName = 'Local\CB_CodexLabCancel_' + $jobId
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $exe
        $psi.Arguments = '--selftest-external-cancel ' + $eventName
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        if (!$proc.Start()) { throw 'JOB_START_FAILED' }
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $signal = $null
        $jobs[$jobId] = @{ Process = $proc; State = 'STARTING'; Event = $eventName }
        try {
            Write-Host "CODEX_JOB_ID: $jobId"
            Write-Host "CODEX_JOB_START: STARTING"
            for ($i = 0; $i -lt 100; $i++) {
                try { $signal = [Threading.EventWaitHandle]::OpenExisting($eventName); break }
                catch [Threading.WaitHandleCannotBeOpenedException] {
                    if ($proc.HasExited) { throw 'JOB_EXITED_BEFORE_READY' }
                    Start-Sleep -Milliseconds 50
                }
            }
            if (!$signal) { throw 'JOB_READY_TIMEOUT' }
            $jobs[$jobId].State = 'RUNNING'
            Write-Host "CODEX_JOB_STATUS: $($jobs[$jobId].State)"
            if (!$jobs.ContainsKey($jobId)) { throw 'JOB_ID_NOT_FOUND' }
            [void]$signal.Set()
            $jobs[$jobId].State = 'CANCELLING'
            Write-Host "CODEX_JOB_CANCEL: SIGNAL_SENT"
            if (!$proc.WaitForExit(10000)) { throw 'JOB_CANCEL_TIMEOUT' }
            $proc.WaitForExit()
            $outputText = $outTask.GetAwaiter().GetResult()
            $errorText = $errTask.GetAwaiter().GetResult()
            if ($errorText) { Write-Host $errorText }
            if ($proc.ExitCode -ne 0) { throw "JOB_EXIT_NONZERO: $($proc.ExitCode)" }
            if (!$outputText.Contains('CODEX_JOB_EXTERNAL_CANCEL_CLEANUP_PASS')) { throw 'JOB_CLEANUP_MARKER_MISSING' }
            $jobs[$jobId].State = 'CANCELLED'
            Write-Host "CODEX_JOB_STATUS: $($jobs[$jobId].State)"
            Write-Host 'CODEX_JOB_LIFECYCLE_TEST_PASS'
            Write-Host 'CODEX_NOT_INVOKED'
        } finally {
            if ($signal) { $signal.Dispose() }
            if (!$proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
            $proc.Dispose()
        }
    } elseif ($ExternalCancelTest) {
        if ($ExecLab -or $NegativeTests) { throw 'TEST_MODES_MUTUALLY_EXCLUSIVE' }
        $eventName = 'Local\CB_CodexLabCancel_' + [guid]::NewGuid().ToString('N')
        $stdout = Join-Path $root 'external-cancel.stdout.txt'
        $stderr = Join-Path $root 'external-cancel.stderr.txt'
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $exe
        $psi.Arguments = '--selftest-external-cancel ' + $eventName
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        if (!$proc.Start()) { throw 'EXTERNAL_CANCEL_PROCESS_START_FAILED' }
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $signal = $null
        try {
            for ($i = 0; $i -lt 100; $i++) {
                try { $signal = [Threading.EventWaitHandle]::OpenExisting($eventName); break }
                catch [Threading.WaitHandleCannotBeOpenedException] {
                    if ($proc.HasExited) { throw 'EXTERNAL_CANCEL_CHILD_EXITED_BEFORE_SIGNAL' }
                    Start-Sleep -Milliseconds 50
                }
            }
            if (!$signal) { throw 'EXTERNAL_CANCEL_EVENT_NOT_FOUND' }
            [void]$signal.Set()
            if (!$proc.WaitForExit(10000)) { throw 'EXTERNAL_CANCEL_PROCESS_TIMEOUT' }
            $proc.WaitForExit()
            $outputText = $outTask.GetAwaiter().GetResult()
            $errorText = $errTask.GetAwaiter().GetResult()
            [IO.File]::WriteAllText($stdout, $outputText, [Text.Encoding]::UTF8)
            [IO.File]::WriteAllText($stderr, $errorText, [Text.Encoding]::UTF8)
            Write-Host $outputText
            if ($errorText) { Write-Host $errorText }
            $exitCode = [int]$proc.ExitCode
            Write-Host "CODEX_EXTERNAL_CANCEL_EXIT_CODE: $exitCode"
            if ($exitCode -ne 0) { throw "EXTERNAL_CANCEL_FAILED: $exitCode" }
            if (!$outputText.Contains('CODEX_JOB_EXTERNAL_CANCEL_CLEANUP_PASS')) { throw 'EXTERNAL_CANCEL_PASS_MARKER_MISSING' }
            Write-Host 'CODEX_EXTERNAL_CANCEL_TEST_PASS'
        } finally {
            if ($signal) { $signal.Dispose() }
            if (!$proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
            $proc.Dispose()
        }
    } elseif ($NegativeTests) {
        if ($ExecLab) { throw 'NEGATIVE_TESTS_AND_EXEC_LAB_MUTUALLY_EXCLUSIVE' }
        & $exe '--selftest-timeout'
        if ($LASTEXITCODE -ne 0) { throw "TIMEOUT_NEGATIVE_TEST_FAILED: $LASTEXITCODE" }
        & $exe '--selftest-cancel'
        if ($LASTEXITCODE -ne 0) { throw "CANCEL_NEGATIVE_TEST_FAILED: $LASTEXITCODE" }
        Write-Host 'CODEX_JOB_NEGATIVE_TESTS_PASS'
    } elseif ($ExecLab) {
        $labDir = Join-Path $root 'empty-workspace'
        New-Item -ItemType Directory -Path $labDir -Force | Out-Null
        Write-Host 'CODEX_EXEC_LAB_MODE: FIXED_PROMPT_READ_ONLY'
        & $exe $release '--exec-lab' $labDir
    } else {
        & $exe $release
    }
    if (!$NegativeTests -and !$ExternalCancelTest -and !$JobLifecycleTest -and $LASTEXITCODE -ne 0) { throw "CODEX_JOB_LAB_FAILED: $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
