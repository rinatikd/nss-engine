param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [switch]$CopyBrowserToken
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS or newer, then run this script again.' }
$nodeArgs = @((Join-Path $PSScriptRoot 'scripts\windows-local.mjs'), 'setup')
if ($ExtensionId) { $nodeArgs += @('--extension-id', $ExtensionId) }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw 'Configuration setup failed. No agent registration was performed.' }
if ($CopyBrowserToken) {
    if (-not (Get-Command Set-Clipboard -ErrorAction SilentlyContinue)) { throw 'Set-Clipboard is unavailable. Configuration is ready; open config.json privately to copy the browserToken.' }
    $stateDir = if ($env:CHROME_BRIDGE_HOME) { $env:CHROME_BRIDGE_HOME } else { Join-Path $HOME '.chrome-bridge' }
    $config = Get-Content -LiteralPath (Join-Path $stateDir 'config.json') -Raw | ConvertFrom-Json
    Set-Clipboard -Value $config.browserToken
    Remove-Variable config
    Write-Host 'Browser token copied to clipboard. Paste ONLY into the Chrome Bridge control window, then clear the clipboard and clipboard history.'
}
Write-Host 'Next: .\Start-Bridge.ps1, connect the extension control window, then .\Doctor-Bridge.ps1 -Live.'
Write-Host 'Preview local agent registration with .\Connect-Agents.ps1. Tokens are never printed.'
