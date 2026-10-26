[CmdletBinding()]
param(
  [Parameter(Mandatory=$false)] [string]$ClientPath = (Join-Path $PSScriptRoot 'runtime\tunnel-client.exe'),
  [Parameter(Mandatory=$false)] [string]$Profile = 'chatgpt-local-codex',
  [Parameter(Mandatory=$false)] [string]$TunnelId,
  [switch]$Initialize
)
$ErrorActionPreference = 'Stop'
$oldApiKey = $env:CONTROL_PLANE_API_KEY
$oldCodexDisabled = $env:CODEX_DISABLED

if (-not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) {
  throw "tunnel-client binary not found: $ClientPath. Download the Windows build from the official release linked in README.md and verify its checksum/provenance first."
}
if ($Initialize -and [string]::IsNullOrWhiteSpace($TunnelId)) { throw 'Initialize requires a Platform tunnel ID.' }
if ($TunnelId -and ($TunnelId.Length -gt 160 -or $TunnelId -match '[\x00-\x1f\s]')) { throw 'TunnelId contains invalid characters.' }
$node = (Get-Command node -ErrorAction Stop).Source
$server = Join-Path $PSScriptRoot 'src\server.mjs'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw 'Local MCP server source is missing.' }
$profileName = $Profile
$stdioCommand = '"' + $node + '" "' + $server + '"'

$secureKey = Read-Host 'OpenAI tunnel runtime API key (hidden input; not saved by this script)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainKey)) { throw 'Runtime key is empty.' }
  $env:CONTROL_PLANE_API_KEY = $plainKey
  $env:CODEX_DISABLED = '1'

  if ($Initialize) {
    & $ClientPath init --sample sample_mcp_stdio_local --profile $profileName --tunnel-id $TunnelId --mcp-command $stdioCommand --health-listen-addr 127.0.0.1:0
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client init failed with exit code $LASTEXITCODE" }
  }
  & $ClientPath doctor --profile $profileName --explain
  if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed with exit code $LASTEXITCODE" }
  Write-Host 'Starting tunnel. Tool execution remains CODEX_DISABLED. Press Ctrl+C to stop.'
  & $ClientPath run --profile $profileName
  if ($LASTEXITCODE -ne 0) { throw "tunnel-client run exited with code $LASTEXITCODE" }
}
finally {
  $env:CONTROL_PLANE_API_KEY = $oldApiKey
  $env:CODEX_DISABLED = $oldCodexDisabled
  $plainKey = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $secureKey.Dispose()
}



