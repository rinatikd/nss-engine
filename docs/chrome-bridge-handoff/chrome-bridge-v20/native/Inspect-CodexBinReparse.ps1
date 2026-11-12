# Read-only inspection of the known Codex bin reparse point. No execution.
[CmdletBinding()]
param(
    [string]$BinPath = "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin"
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
$item = Get-Item -LiteralPath $BinPath -Force -ErrorAction Stop
if (-not $item.PSIsContainer) { throw 'CODEX_BIN_NOT_DIRECTORY' }
$reparse = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
Write-Host "BIN_PATH: $($item.FullName)"
Write-Host "REPARSE_POINT: $reparse"
Write-Host "LINK_TYPE: $($item.LinkType)"
Write-Host "TARGET: $($item.Target -join '; ')"
if ($reparse) {
    Write-Host '=== Windows reparse metadata ==='
    & fsutil reparsepoint query $item.FullName
    if ($LASTEXITCODE -ne 0) { throw 'REPARSE_QUERY_FAILED' }
}
Write-Host '=== Resolved executable ==='
$resolved = (Resolve-Path -LiteralPath (Join-Path $BinPath 'codex.exe') -ErrorAction Stop).ProviderPath
Write-Host "RESOLVED_PATH: $resolved"
$exe = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
Write-Host "EXECUTABLE_ATTRIBUTES: $($exe.Attributes)"
Write-Host "EXECUTABLE_SIZE_BYTES: $($exe.Length)"
$hash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
Write-Host "SHA256: $hash"
$sig = Get-AuthenticodeSignature -LiteralPath $resolved
Write-Host "SIGNATURE_STATUS: $($sig.Status)"
Write-Host "SIGNER: $($sig.SignerCertificate.Subject)"
Write-Host 'CODEX_EXECUTION: DISABLED'
