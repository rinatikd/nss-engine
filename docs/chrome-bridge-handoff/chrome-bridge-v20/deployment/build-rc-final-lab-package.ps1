# Build a disposable RC package from the checked-out PR #99 sources.
# Never overwrites production extension, browser profile, tokens, or existing artifacts.
[CmdletBinding()]
param(
  [string]$BridgeRoot = 'C:\Engineering\chrome-bridge',
  [string]$CandidateRoot = (Join-Path $PSScriptRoot '..'),
  [string]$OutputRoot = 'C:\Engineering\ChromeBridge-RC-Final-Package',
  [string]$CommitSha = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$candidate = [IO.Path]::GetFullPath($CandidateRoot).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
$installed = [IO.Path]::GetFullPath($BridgeRoot).TrimEnd('\')
if ($output -eq $installed -or $output.StartsWith($installed + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $output -eq $candidate -or $output.StartsWith($candidate + '\',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to package inside installed or source directory'
}
if (Test-Path -LiteralPath $output) { throw 'OutputRoot already exists; refusing overwrite' }
$stage = Join-Path $output 'extension'
$zip = Join-Path $output 'chrome-bridge-0.2.0-rc-final-lab.zip'
$evidence = Join-Path $output 'release-evidence.json'
$stageScript = Join-Path $candidate 'deployment\stage-background-lab.ps1'
$verifyScript = Join-Path $candidate 'deployment\verify-adapter-lab.ps1'
$evidenceScript = Join-Path $candidate 'deployment\write-lab-release-manifest.ps1'
foreach ($script in @($stageScript,$verifyScript,$evidenceScript)) {
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw ('Missing source script: '+$script) }
}
# Source identity must be explicit to prevent packaging an unintended checkout.
if ($CommitSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'Supply exact 40-character Git commit SHA (-CommitSha)' }
$git = Get-Command git -ErrorAction Stop
$actualCommit = (& $git.Source -C $candidate rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $CommitSha) {
  throw ('Source checkout SHA mismatch: expected '+$CommitSha+', actual '+$actualCommit)
}
$dirty = & $git.Source -C $candidate status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0 -or @($dirty | Where-Object { $_ }).Count -gt 0) { throw 'Source checkout must be clean' }
New-Item -ItemType Directory -Path $output -ErrorAction Stop | Out-Null
try {
  & $stageScript -BridgeRoot $installed -CandidateRoot $candidate -OutputRoot $stage -Apply
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Staging command failed' }
  & $verifyScript -LabRoot $stage
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Verification command failed' }
  & $evidenceScript -LabRoot $stage -OutputPath $evidence -CommitSha $CommitSha
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Evidence command failed' }
  Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw 'Zip creation failed' }
  Write-Output ('[PACKAGE] '+$zip)
  Write-Output ('[PACKAGE_SHA256] '+(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant())
  Write-Output ('[EVIDENCE] '+$evidence)
  Write-Output '[NO-GO] Disposable lab-only package. Not a production release.'
} catch {
  Write-Output ('[FAILED] '+$_.Exception.Message)
  Write-Output ('[EVIDENCE] Partial output (if any) retained for inspection at '+$output)
  throw
}
