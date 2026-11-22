$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    node --check .\consilium\event-ledger.mjs
    if ($LASTEXITCODE -ne 0) { throw "event-ledger syntax check failed: $LASTEXITCODE" }
    node --check .\consilium\control-room.mjs
    if ($LASTEXITCODE -ne 0) { throw "control-room syntax check failed: $LASTEXITCODE" }
    node --check .\consilium\web\app.js
    if ($LASTEXITCODE -ne 0) { throw "Control Room UI syntax check failed: $LASTEXITCODE" }
    $testFiles = @(Get-ChildItem -Path .\tests -Filter '*.test.mjs' -File | ForEach-Object { $_.FullName })
    if ($testFiles.Count -eq 0) { throw 'No Control Room test files found.' }
    node --test $testFiles
    if ($LASTEXITCODE -ne 0) { throw "Node test suite failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location }
