$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS or newer first.' }
& node (Join-Path $PSScriptRoot 'scripts\windows-local.mjs') doctor
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed. Run Setup-Windows.ps1 with the extension ID from chrome://extensions.' }
Write-Host 'Starting local Chrome Bridge. Leave this window open; use Ctrl+C to stop.'
& node (Join-Path $PSScriptRoot 'server\bridge.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Chrome Bridge stopped with an error.' }
