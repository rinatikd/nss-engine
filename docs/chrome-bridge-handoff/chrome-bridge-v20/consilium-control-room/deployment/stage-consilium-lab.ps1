# Build and test a disposable Consilium Control Room Lab package.
# No provider messages, real credentials, persistent user data or Production access.
[CmdletBinding()]
param(
  [string]$CandidateRoot = (Join-Path $PSScriptRoot '..'),
  [string]$OutputRoot = 'C:\Engineering\Consilium-Control-Room-Lab-Package',
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$CommitSha
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$candidate=[IO.Path]::GetFullPath($CandidateRoot).TrimEnd('\')
$output=[IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
if ($output -eq $candidate -or $output.StartsWith($candidate+'\',[StringComparison]::OrdinalIgnoreCase) -or
    $candidate.StartsWith($output+'\',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputRoot must be outside the source checkout'
}
if (Test-Path -LiteralPath $output) { throw 'OutputRoot already exists; refusing overwrite' }
$git=Get-Command git -ErrorAction Stop
$actual=(& $git.Source -C $candidate rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne $CommitSha.ToLowerInvariant()) {
  throw ('Source SHA mismatch: expected '+$CommitSha+', actual '+$actual)
}
$repoRoot=(& $git.Source -C $candidate rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw 'Could not resolve repository root' }
$candidateRelative=$candidate.Substring($repoRoot.Length).TrimStart('\').Replace('\','/')
$permissionSource=Join-Path (Split-Path $candidate -Parent) 'extension\permissions.js'
$cryptoSource=Join-Path (Split-Path $candidate -Parent) 'server\provider-transport-crypto.mjs'
if (-not (Test-Path -LiteralPath $permissionSource -PathType Leaf)) { throw 'ProviderTransport dependency extension/permissions.js missing' }
if (-not (Test-Path -LiteralPath $cryptoSource -PathType Leaf)) { throw 'ProviderTransport dependency server/provider-transport-crypto.mjs missing' }
$critical=@(
  ($candidateRelative+'/consilium'),($candidateRelative+'/tests'),($candidateRelative+'/scripts'),
  ($candidateRelative+'/deployment'),'docs/chrome-bridge-handoff/chrome-bridge-v20/extension/permissions.js',
  'docs/chrome-bridge-handoff/chrome-bridge-v20/server/provider-transport-crypto.mjs'
)
& $git.Source -C $repoRoot diff --quiet HEAD -- $critical
if ($LASTEXITCODE -ne 0) { throw 'Consilium package source differs from committed content' }
& $git.Source -C $repoRoot diff --cached --quiet HEAD -- $critical
if ($LASTEXITCODE -ne 0) { throw 'Staged changes detected in Consilium package source' }
$untracked=@(& $git.Source -C $repoRoot ls-files --others --exclude-standard -- $critical)
if ($LASTEXITCODE -ne 0 -or @($untracked | Where-Object {$_}).Count -gt 0) {
  throw 'Untracked Consilium package input detected'
}
foreach($required in @('consilium/control-room.mjs','consilium/event-ledger.mjs','consilium/provider-transport-v1.mjs',
  'consilium/web/index.html','consilium/web/app.js','consilium/web/style.css','deployment/consilium-lab-smoke.mjs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $candidate $required) -PathType Leaf)) {
    throw ('Required Consilium source missing: '+$required)
  }
}
$node=Get-Command node -ErrorAction Stop
$temp=$output+'-tmp-'+[guid]::NewGuid().ToString('N')
$done=$false
try {
  New-Item -ItemType Directory -Path $temp -ErrorAction Stop | Out-Null
  # Preserve the original chrome-bridge-v20 layout: extension/ is a sibling of consilium-control-room/.
  $projectRoot=Join-Path $temp 'consilium-control-room'
  New-Item -ItemType Directory -Path $projectRoot -Force | Out-Null
  foreach($dir in @('consilium','tests','scripts','deployment')) {
    Copy-Item -LiteralPath (Join-Path $candidate $dir) -Destination $projectRoot -Recurse -Force
  }
  $extensionDir=Join-Path $temp 'extension'
  New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null
  Copy-Item -LiteralPath $permissionSource -Destination (Join-Path $extensionDir 'permissions.js') -Force
  $serverDir=Join-Path $temp 'server'
  New-Item -ItemType Directory -Path $serverDir -Force | Out-Null
  Copy-Item -LiteralPath $cryptoSource -Destination (Join-Path $serverDir 'provider-transport-crypto.mjs') -Force
  $files=@(Get-ChildItem -LiteralPath $temp -Recurse -File | Sort-Object FullName)
  if ($files.Count -lt 15) { throw 'Consilium Lab package appears incomplete' }
  foreach($file in $files) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Reparse point refused: '+$file.FullName) }
    if ($file.Name -match '^(config|secrets?|credentials?|events)\.(json|jsonl|ndjson|ya?ml|txt)$' -or
        $file.Extension -in @('.pem','.pfx','.p12','.key','.log')) {
      throw ('Runtime data or credential-shaped input refused: '+$file.Name)
    }
    if ($file.Extension -in @('.mjs','.js')) {
      & $node.Source --check $file.FullName
      if ($LASTEXITCODE -ne 0) { throw ('Node syntax check failed: '+$file.FullName) }
    }
  }
  $testFiles=@(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -Filter '*.test.mjs' -File | ForEach-Object {$_.FullName})
  if ($testFiles.Count -lt 4) { throw 'Expected Control Room regression suite missing' }
  & $node.Source --test $testFiles
  if ($LASTEXITCODE -ne 0) { throw 'Consilium Node regression suite failed' }
  & $node.Source (Join-Path $projectRoot 'deployment/consilium-lab-smoke.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Consilium disposable Lab API/role smoke failed' }

  $entries=@(foreach($file in $files) {
    $rel=$file.FullName.Substring($temp.Length+1).Replace('\','/')
    [ordered]@{path=$rel;bytes=[int64]$file.Length;
      sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  })
  $manifest=[ordered]@{
    schema='consilium-control-room-lab-package-v1'
    target='DISPOSABLE_LAB_ONLY'
    sourceCommit=$actual
    runtime='Node.js'
    smoke='LOOPBACK_AUTH_AND_ROLE_BOUNDARIES_PASS'
    actorCount=8
    providerDispatch=$false
    production=$false
    realSecrets=$false
    files=$entries
  }
  $manifestPath=Join-Path $temp 'consilium-release-manifest.json'
  [IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 12)+[Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temp -Destination $output
  $done=$true
  $zip=$output+'.zip'
  Compress-Archive -Path (Join-Path $output '*') -DestinationPath $zip -CompressionLevel Optimal -ErrorAction Stop
  Write-Output ('[STAGED] '+$output)
  Write-Output ('[SOURCE_SHA] '+$actual)
  Write-Output ('[FILES] '+$files.Count)
  Write-Output '[SMOKE] LOOPBACK_AUTH_AND_ROLE_BOUNDARIES_PASS'
  Write-Output ('[MANIFEST_SHA256] '+(Get-FileHash -LiteralPath (Join-Path $output 'consilium-release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant())
  Write-Output ('[ZIP_SHA256] '+(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant())
  Write-Output '[LIMIT] Package-only smoke. No provider task or persistent Lab deployment was performed.'
}finally{
  if(-not $done -and (Test-Path -LiteralPath $temp)){Remove-Item -LiteralPath $temp -Recurse -Force}
}
