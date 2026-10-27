param(
  [Parameter(Mandatory=$true)][string]$WorkerPath,
  [Parameter(Mandatory=$true)][string]$SignerThumbprint,
  [Parameter(Mandatory=$true)][string]$SyntheticCredentialPath,
  [Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$LoopbackPort,
  [Parameter(Mandatory=$true)][switch]$OperatorConfirmedDisposableVm
)
$ErrorActionPreference = 'Stop'
if (-not $OperatorConfirmedDisposableVm) { throw 'BLOCKED: only run in a fresh disposable Windows VM.' }
$root = Split-Path -Parent $PSScriptRoot
$worker = (Resolve-Path -LiteralPath $WorkerPath).Path
$canary = (Resolve-Path -LiteralPath $SyntheticCredentialPath).Path
if ($worker -eq $canary) { throw 'Worker and synthetic credential canary must be distinct files.' }
$signature = Get-AuthenticodeSignature -LiteralPath $worker
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
    $signature.SignerCertificate.Thumbprint -ne $SignerThumbprint.Replace(' ', '').ToUpperInvariant()) {
  throw 'BLOCKED: worker Authenticode signature is not valid for the specified disposable test certificate.'
}
$workerHash = (Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash.ToLowerInvariant()
$certHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($signature.SignerCertificate.RawData)).ToLowerInvariant()
$cppWorker = $worker.Replace('\','\\').Replace('"','\"')
$cppSecret = $canary.Replace('\','\\').Replace('"','\"')
$launcherHeader = @"
#pragma once
namespace v12pins {
inline constexpr wchar_t kWorkerPath[] = L"$cppWorker";
inline constexpr wchar_t kWorkerSha256[] = L"$workerHash";
inline constexpr wchar_t kSignerCertSha256[] = L"$certHash";
}
"@
Set-Content -LiteralPath (Join-Path $root 'native\test_pins.h') -Value $launcherHeader -Encoding utf8
Write-Output "Test pins generated. Worker SHA256=$workerHash; signer cert SHA256=$certHash. No binary was launched."
