param([switch]$Live)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS or newer first.' }
$nodeArgs = @((Join-Path $PSScriptRoot 'scripts\windows-local.mjs'), 'doctor')
if ($Live) { $nodeArgs += '--live' }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw 'Chrome Bridge doctor found an incomplete setup. See the messages above.' }
