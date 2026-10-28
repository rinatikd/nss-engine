param(
    [ValidatePattern('^[a-z0-9_-]{1,32}$')][string]$Agent,
    [switch]$SendTest,
    [string]$Report,
    [ValidateRange(1, 300)][int]$TimeoutSec = 120
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS or newer first.' }
if ($SendTest -and -not $Agent) { throw '-SendTest requires an explicitly chosen -Agent.' }
$nodeArgs = @((Join-Path $PSScriptRoot 'scripts\verify-live.mjs'), '--timeout-sec', "$TimeoutSec")
if ($Agent) { $nodeArgs += @('--agent', $Agent) }
if ($SendTest) {
    Write-Host 'Explicit send test: one harmless generated code prompt will be submitted to the chosen bound chat. No automatic resend.'
    $nodeArgs += '--send-test'
}
if ($Report) { $nodeArgs += @('--report', $Report) }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw 'Local acceptance failed. Inspect the sanitized report. If a send was attempted, inspect the chat before any new test; never automatically resend.' }
