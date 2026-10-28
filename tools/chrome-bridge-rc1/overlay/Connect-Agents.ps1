param(
    [ValidateSet('Preview', 'Codex', 'Claude')][string]$Target = 'Preview',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS or newer first.' }
& node (Join-Path $PSScriptRoot 'scripts\windows-local.mjs') doctor
if ($LASTEXITCODE -ne 0) { throw 'Complete local setup before registering agents.' }
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$stdioPath = Join-Path $PSScriptRoot 'server\stdio.mjs'
$stateDir = if ($env:CHROME_BRIDGE_HOME) { [System.IO.Path]::GetFullPath($env:CHROME_BRIDGE_HOME) } else { Join-Path $HOME '.chrome-bridge' }
$port = if ($env:CHROME_BRIDGE_PORT) { $env:CHROME_BRIDGE_PORT } else { '17381' }

# This preview contains paths and non-secret settings only. The stdio proxy reads
# the agent token privately from config.json; credentials never enter CLI args.
$definition = @{
    mcpServers = @{
        'chrome-bridge' = @{
            command = $nodePath
            args = @($stdioPath)
            env = @{ CHROME_BRIDGE_HOME = $stateDir; CHROME_BRIDGE_PORT = $port }
        }
    }
}
Write-Output ($definition | ConvertTo-Json -Depth 6)
if (-not $Apply) {
    Write-Host 'Preview only. No user MCP configuration changed.'
    Write-Host 'To register one client explicitly: .\Connect-Agents.ps1 -Target Codex -Apply (or -Target Claude -Apply).'
    return
}
if ($Target -eq 'Preview') { throw 'Choose -Target Codex or -Target Claude with -Apply.' }
$cli = if ($Target -eq 'Codex') { 'codex' } else { 'claude' }
if (-not (Get-Command $cli -ErrorAction SilentlyContinue)) { throw "Install $Target CLI or use the preview to configure your MCP host manually." }
# Refuse replacement. A successful get indicates an existing registration.
# Suppress get output because other client configuration may contain credentials.
$savedPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    & $cli mcp get chrome-bridge *> $null
    $exists = $LASTEXITCODE -eq 0
} finally { $ErrorActionPreference = $savedPreference }
if ($exists) { throw 'chrome-bridge is already registered. Review it in the client; this helper never replaces an existing registration.' }
if ($Target -eq 'Codex') {
    & $cli mcp add chrome-bridge --env "CHROME_BRIDGE_HOME=$stateDir" --env "CHROME_BRIDGE_PORT=$port" -- $nodePath $stdioPath
} else {
    & $cli mcp add chrome-bridge --transport stdio --scope user --env "CHROME_BRIDGE_HOME=$stateDir" --env "CHROME_BRIDGE_PORT=$port" -- $nodePath $stdioPath
}
if ($LASTEXITCODE -ne 0) { throw "$Target registration failed. Inspect the CLI locally; the preview remains available for manual configuration." }
Write-Host "$Target registered. Start a new agent session. This does not enable the Codex native runner."
if ($Target -eq 'Codex') {
    Write-Host 'Undo this registration with: codex mcp remove chrome-bridge'
} else {
    Write-Host 'Undo this registration with: claude mcp remove --scope user chrome-bridge'
}
