$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'test.ps1')
if ($LASTEXITCODE -ne 0) { throw "Control Room checks failed with exit code $LASTEXITCODE" }
