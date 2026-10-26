[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$command = Get-Command codex -ErrorAction SilentlyContinue
if (-not $command) { Write-Output 'BLOCKED: Codex executable not found.'; exit 3 }
$path = (Resolve-Path -LiteralPath $command.Source).Path
$signature = Get-AuthenticodeSignature -LiteralPath $path
$hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output ('Executable present: True')
Write-Output ('SHA256: ' + $hash)
Write-Output ('Signature status: ' + $signature.Status)
if ($signature.SignerCertificate) { Write-Output ('Signer thumbprint: ' + $signature.SignerCertificate.Thumbprint) }
Write-Output 'CLI subcommands run by diagnose.py are read-only: --version, features list, mcp list.'
Write-Output 'Effective tools, managed policy, inherited environment, and Windows sandbox remain UNVERIFIED.'
python (Join-Path $PSScriptRoot 'diagnose.py') --report (Join-Path $PSScriptRoot 'diagnostic-report.json')
exit $LASTEXITCODE
