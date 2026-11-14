# One-click Chrome Bridge PR #113 local verification
# Does not stop services, edit production config, access secrets, or install extension.
# Run from a checked-out copy of feature/chrome-bridge-one-click-all-tabs-20261114.
[CmdletBinding()]
param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$EvidenceDirectory = (Join-Path $env:TEMP 'chrome-bridge-pr113-evidence'),
  [switch]$SkipNodeTests
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$evidencePath = Join-Path $EvidenceDirectory "pr113-$stamp.json"
$testsOutput = Join-Path $EvidenceDirectory "pr113-tests-$stamp.txt"
$ports = @(17381,17382,17481,17482,17483,17484,17486,18791)
$portsInfo = @(foreach ($p in $ports) {
  $listener = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  [pscustomobject]@{
    Port = $p
    Listening = [bool]$listener
    PID = if($listener) {$listener.OwningProcess} else {$null}
  }
})
# Process IDs and names only: do not inspect arguments, profiles or secrets.
$tunnels = @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" |
  Select-Object ProcessId,Name)
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeVersion = if ($node) { & $node.Source --version } else { $null }
$tests = [ordered]@{ State='NOT_RUN'; ExitCode=$null; Output=$testsOutput }
$testFile = Join-Path $SourceRoot 'tests\one-click-session.test.mjs'
if (-not $SkipNodeTests) {
  if (-not $node) {
    $tests.State='BLOCKED_NODE_NOT_FOUND'
  } elseif (-not (Test-Path -LiteralPath $testFile -PathType Leaf)) {
    $tests.State='BLOCKED_TEST_FILE_NOT_FOUND'
  } else {
    & $node.Source --test $testFile *> $testsOutput
    $tests.ExitCode = $LASTEXITCODE
    $tests.State = if ($LASTEXITCODE -eq 0) { 'PASS' } else { 'FAIL' }
  }
}
$manifest = Join-Path $SourceRoot 'extension\manifest.json'
$manifestCheck = [ordered]@{Found=$false;Version=$null;OptionalHosts=@();ContainsSourceCredential=$null}
if (Test-Path -LiteralPath $manifest -PathType Leaf) {
  $j = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $manifestCheck.Found=$true
  $manifestCheck.Version=$j.version
  $manifestCheck.OptionalHosts=@($j.optional_host_permissions)
  # Do not print or collect any secret values.
}
$evidence = [ordered]@{
  Stage='PR113_LOCAL_READONLY_DIAGNOSTICS'
  Time=(Get-Date).ToString('o')
  SourceRoot=$SourceRoot
  NodeVersion=$nodeVersion
  Ports=$portsInfo
  TunnelProcesses=$tunnels
  Manifest=$manifestCheck
  UnitTests=$tests
  ProductionChanged=$false
  RealChromeE2E='NOT_RUN'
}
$evidence | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
Write-Host '=== PR113 LAB DIAGNOSTICS ==='
$portsInfo | Format-Table -AutoSize
Write-Host "Tunnel-client processes: $($tunnels.Count)"
Write-Host "Node: $nodeVersion"
Write-Host "Unit tests: $($tests.State)"
Write-Host "Evidence JSON: $evidencePath"
Write-Host "Test output: $testsOutput"
if ($tests.State -eq 'FAIL') { exit 1 }
if ($tests.State -like 'BLOCKED*') { exit 2 }
exit 0
