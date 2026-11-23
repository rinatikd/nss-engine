# Stage and verify the MCP server source as a disposable Lab package.
# Does NOT stop, replace, or connect to any installed Bridge server or Chrome profile.
[CmdletBinding()]
param(
  [string]$CandidateRoot = (Join-Path $PSScriptRoot '..'),
  [string]$OutputRoot = 'C:\Engineering\ChromeBridge-PR132-Server-Lab-Package',
  [string]$BridgeRoot = 'C:\Engineering\chrome-bridge',
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$CommitSha
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$candidate = [IO.Path]::GetFullPath($CandidateRoot).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
$installed = [IO.Path]::GetFullPath($BridgeRoot).TrimEnd('\')
$serverSource = Join-Path $candidate 'server'
$healthSource = Join-Path $candidate 'deployment\cutover-health.mjs'
$required = @(
  'bridge.mjs', 'tools.mjs', 'schema.mjs', 'secrets.mjs',
  'send-journal.mjs', 'send-outcome.mjs', 'provider-journal.mjs',
  'provider-transport-crypto.mjs'
)
if ($output -eq $installed -or $output.StartsWith($installed + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $output -eq $candidate -or $output.StartsWith($candidate + '\',[StringComparison]::OrdinalIgnoreCase) -or
    $candidate.StartsWith($output + '\',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputRoot must be a new directory outside the installed BridgeRoot and source checkout'
}
if (Test-Path -LiteralPath $output) { throw 'OutputRoot already exists; refusing overwrite' }
if (-not (Test-Path -LiteralPath $serverSource -PathType Container)) { throw 'Candidate server directory missing' }
if (-not (Test-Path -LiteralPath $healthSource -PathType Leaf)) { throw 'Isolated cutover health probe missing' }
foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $serverSource $name) -PathType Leaf)) {
    throw ('Required server module missing: ' + $name)
  }
}

$git = Get-Command git -ErrorAction Stop
$actualCommit = (& $git.Source -C $candidate rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $CommitSha.ToLowerInvariant()) {
  throw ('Source SHA mismatch: expected ' + $CommitSha + ', actual ' + $actualCommit)
}
$critical = @('server','deployment/cutover-health.mjs','deployment/stage-server-lab.ps1')
& $git.Source -C $candidate diff --quiet HEAD -- $critical
if ($LASTEXITCODE -ne 0) { throw 'Server package inputs differ from committed source' }
& $git.Source -C $candidate diff --cached --quiet HEAD -- $critical
if ($LASTEXITCODE -ne 0) { throw 'Staged changes detected in server package inputs' }
$untracked = @(& $git.Source -C $candidate ls-files --others --exclude-standard -- $critical)
if ($LASTEXITCODE -ne 0 -or @($untracked | Where-Object { $_ }).Count -gt 0) {
  throw 'Untracked server package input detected'
}

$node = Get-Command node -ErrorAction Stop
$temp = $output + '-tmp-' + [guid]::NewGuid().ToString('N')
$completed = $false
try {
  New-Item -ItemType Directory -Path $temp -ErrorAction Stop | Out-Null
  $stagedServer = Join-Path $temp 'server'
  $deployment = Join-Path $temp 'deployment'
  New-Item -ItemType Directory -Path $deployment -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $serverSource -Destination $stagedServer -Recurse -Force
  Copy-Item -LiteralPath $healthSource -Destination (Join-Path $deployment 'cutover-health.mjs') -Force

  $files = @(Get-ChildItem -LiteralPath $stagedServer -Recurse -File | Sort-Object FullName)
  if ($files.Count -lt $required.Count) { throw 'Staged server tree is unexpectedly small' }
  foreach ($file in $files) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw ('Reparse point in server source: ' + $file.FullName)
    }
    if ($file.Name -match '^(config|secrets?|credentials?)\.(json|ya?ml|txt)$' -or
        $file.Extension -in @('.pem','.pfx','.p12','.key','.log')) {
      throw ('Credential/state-shaped file refused: ' + $file.Name)
    }
    if ($file.Extension -eq '.mjs') {
      & $node.Source --check $file.FullName
      if ($LASTEXITCODE -ne 0) { throw ('Node syntax check failed: ' + $file.FullName) }
    }
  }

  $expected = Join-Path $temp 'expected-tools.json'
  $registryScript = "import fs from 'node:fs'; import { tools } from './server/tools.mjs'; fs.writeFileSync(process.argv[1], JSON.stringify({result:{tools:tools.map(({kind,...tool})=>tool)}}));"
  Push-Location $temp
  try {
    & $node.Source --input-type=module -e $registryScript $expected
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $expected -PathType Leaf)) {
      throw 'Could not materialize expected MCP registry'
    }
    $job = Join-Path $temp 'health-job.json'
    $jobData = [ordered]@{ mode='isolated'; source=$temp; port=0; expected=$expected }
    [IO.File]::WriteAllText($job, ($jobData | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
      (New-Object System.Text.UTF8Encoding($false)))
    & $node.Source (Join-Path $deployment 'cutover-health.mjs') $job
    if ($LASTEXITCODE -ne 0) { throw 'Isolated MCP registry/initialize/browser_status health test failed' }
  } finally {
    Pop-Location
  }

  $registry = Get-Content -LiteralPath $expected -Raw -Encoding UTF8 | ConvertFrom-Json
  $requiredTools = @(
    'session_request','session_authorize','session_status','session_revoke',
    'provider_prepare','provider_commit','provider_status','provider_stop','provider_revoke','provider_events'
  )
  $actualToolNames = @($registry.result.tools | ForEach-Object { $_.name })
  foreach ($name in $requiredTools) {
    if ($actualToolNames -notcontains $name) { throw ('Required MCP tool missing from source registry: ' + $name) }
  }
  $entries = @(
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($stagedServer.Length + 1).Replace('\','/')
      [ordered]@{
        path = $relative
        bytes = [int64]$file.Length
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  )
  $manifest = [ordered]@{
    schema = 'chrome-bridge-server-lab-package-v1'
    target = 'DISPOSABLE_LAB_ONLY'
    sourceCommit = $actualCommit
    createdUtc = [DateTime]::UtcNow.ToString('o')
    runtime = 'Node.js'
    health = 'ISOLATED_MCP_TOOLS_LIST_INITIALIZE_BROWSER_STATUS_PASS'
    toolCount = @($registry.result.tools).Count
    requiredTools = @(
      'session_request','session_authorize','session_status','session_revoke',
      'provider_prepare','provider_commit','provider_status','provider_stop','provider_revoke','provider_events'
    )
    files = $entries
    exclusions = @('No live Bridge process stopped or replaced','No existing credentials/config copied',
      'No Chrome profile or extension changed','No Production port, tunnel or autostart touched')
  }
  $manifestPath = Join-Path $temp 'server-release-manifest.json'
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 16) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false)))

  Move-Item -LiteralPath $temp -Destination $output
  $completed = $true
  Write-Output ('[STAGED] ' + $output)
  Write-Output ('[SOURCE_SHA] ' + $actualCommit)
  Write-Output ('[SERVER_FILES] ' + $files.Count)
  Write-Output ('[MCP_TOOLS] ' + @($registry.result.tools).Count)
  Write-Output ('[MANIFEST_SHA256] ' + (Get-FileHash -LiteralPath (Join-Path $output 'server-release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant())
  Write-Output '[LIMIT] Package validation only. No persistent Lab server was started and no live MCP connector was retargeted.'
} finally {
  if (-not $completed -and (Test-Path -LiteralPath $temp)) {
    Remove-Item -LiteralPath $temp -Recurse -Force
  }
}
