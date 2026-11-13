[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Doctor','Run')][string]$Mode,
    [string]$ExtensionId
)
$ErrorActionPreference = 'Stop'
$port = 17485
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$server = Join-Path $root 'server\bridge.mjs'
$state = 'C:\Engineering\ChromeBridge-Main-17485-State'

if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
    throw 'BRIDGE_SERVER_SOURCE_MISSING'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'NODE_NOT_FOUND'
}
$existing = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) { throw 'STAGING_PORT_17485_OCCUPIED' }
if ((Test-Path -LiteralPath $state -PathType Container) -and
    ((Get-Item -LiteralPath $state).LinkType)) {
    throw 'STAGING_STATE_MUST_NOT_BE_SYMLINK'
}
if ($Mode -eq 'Doctor') {
    Write-Host 'MAIN_CHROME_STAGE_DOCTOR: PASS'
    Write-Host "Port $port is free. Server source exists. Isolated state directory: $state"
    Write-Host 'Nothing started, created, installed, or modified.'
    exit 0
}
if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
    throw 'EXPLICIT_MAIN_CHROME_EXTENSION_ID_REQUIRED'
}
if (-not (Test-Path -LiteralPath $state)) {
    New-Item -ItemType Directory -Path $state -Force | Out-Null
}
$configPath = Join-Path $state 'config.json'
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.extensionId -and $config.extensionId -cne $ExtensionId) {
        throw 'STATE_BOUND_TO_DIFFERENT_EXTENSION_ID'
    }
}
# Environment changes are scoped to this PowerShell process and its child Node.
# No production env vars, files, processes or tunnels are modified.
$env:CHROME_BRIDGE_PORT = [string]$port
$env:CHROME_BRIDGE_HOME = $state
$env:CHROME_BRIDGE_EXTENSION_ID = $ExtensionId
$env:CHROME_BRIDGE_READ_ONLY = '1'
Remove-Item Env:CHROME_BRIDGE_CODEX_POLICY -ErrorAction SilentlyContinue
Write-Host 'STARTING_READ_ONLY_MAIN_CHROME_STAGE_ON_127.0.0.1:17485'
Write-Host 'A dedicated config.json will be generated under the isolated state directory.'
Write-Host 'Do not print or share browserToken/agentToken. Local Chrome UI still requires authorization.'
& node $server
if ($LASTEXITCODE -ne 0) { throw "STAGING_NODE_EXIT_$LASTEXITCODE" }
