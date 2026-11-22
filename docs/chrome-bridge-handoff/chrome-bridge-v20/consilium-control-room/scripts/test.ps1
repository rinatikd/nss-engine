$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    node --check .\consilium\event-ledger.mjs
    node --check .\consilium\control-room.mjs
    node --check .\consilium\web\app.js
    node --test .\tests\*.test.mjs
    if ($LASTEXITCODE -ne 0) { throw "Node test suite failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location }
