# Read-only inspection of PR102 lab server extension-origin pin.
# Never display config.json contents, browserToken or agentToken.
[CmdletBinding()]
param(
  [string]$LabState = 'C:\Engineering\ChromeBridge-PR102-17484-State'
)
$ErrorActionPreference='Stop'
$file=Join-Path $LabState 'config.json'
if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
  Write-Host "CONFIG_FOUND: false"
  Write-Host "LAB_STATE: $LabState"
  exit 2
}
$config=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
$id=[string]$config.extensionId
Write-Host 'CONFIG_FOUND: true'
Write-Host 'PIN_PRESENT:' ([bool]$id)
if ($id -match '^[a-p]{32}$') {
  Write-Host "EXPECTED_EXTENSION_ID: $id"
} else {
  Write-Host 'EXPECTED_EXTENSION_ID: not set or invalid'
}
Write-Host 'No credentials displayed.'
