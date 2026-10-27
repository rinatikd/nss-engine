# Opt-in, one-shot mock invocation. Does not call any model or post to GitHub.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = (Get-Command py -ErrorAction SilentlyContinue)
if ($python) {
  & py -3 worker.py --queue "$PSScriptRoot\queue" --db "$PSScriptRoot\ledger.db" --max-tasks 5
} else {
  & python worker.py --queue "$PSScriptRoot\queue" --db "$PSScriptRoot\ledger.db" --max-tasks 5
}
if ($LASTEXITCODE -ne 0) { throw "Worker failed with exit code $LASTEXITCODE" }
