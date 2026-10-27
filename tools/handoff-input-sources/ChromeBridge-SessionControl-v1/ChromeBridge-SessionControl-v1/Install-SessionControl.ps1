param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$root = 'C:\Engineering\chrome-bridge'
$entry = Join-Path $PSScriptRoot 'Install-SessionControl.mjs'
$argsList = @($entry, $root)
if ($VerifyOnly) { $argsList += '--verify' }
& node @argsList
if ($LASTEXITCODE -ne 0) { throw 'SessionControl installer failed' }
