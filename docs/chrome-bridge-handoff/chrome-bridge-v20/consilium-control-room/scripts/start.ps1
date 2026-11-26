$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not $env:CONSILIUM_OWNER_TOKEN -or -not $env:CONSILIUM_CHATGPT_TOKEN -or -not $env:CONSILIUM_CLAUDE_TOKEN) {
        throw 'Set unique CONSILIUM_OWNER_TOKEN, CONSILIUM_CHATGPT_TOKEN and CONSILIUM_CLAUDE_TOKEN in this PowerShell session first.'
    }
    node .\consilium\control-room.mjs
    if ($LASTEXITCODE -ne 0) { throw "Control Room exited with code $LASTEXITCODE" }
}
finally { Pop-Location }
