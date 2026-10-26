param(
  [Parameter(Mandatory=$true)][string]$SyntheticCredentialPath,
  [Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$LoopbackPort,
  [Parameter(Mandatory=$true)][switch]$OperatorConfirmedDisposableVm
)
$ErrorActionPreference = 'Stop'
if (-not $OperatorConfirmedDisposableVm) { throw 'BLOCKED: only run in a fresh disposable Windows VM.' }
$canary = (Resolve-Path -LiteralPath $SyntheticCredentialPath).Path
if ($canary -match '(?i)(\\\.codex\\|\\AppData\\Roaming\\OpenAI\\|CODEX_HOME)') {
  throw 'Refusing a path that resembles a real Codex profile. Use a trial-unique synthetic file.'
}
$cppSecret = $canary.Replace('\','\\').Replace('"','\"')
$header = @"
#pragma once
#define CB_V12_LOOPBACK_PORT $LoopbackPort
#define CB_V12_SYNTHETIC_CREDENTIAL_PATH L"$cppSecret"
"@
$root = Split-Path -Parent $PSScriptRoot
Set-Content -LiteralPath (Join-Path $root 'native\worker_test_pins.h') -Value $header -Encoding utf8
Write-Output 'Synthetic worker compile-time probes pinned. No binary was built or launched.'
