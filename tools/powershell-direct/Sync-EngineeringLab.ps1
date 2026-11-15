# Update only the two verified drifted files in the isolated lab.
# No service, tunnel, production file or credential is touched.
[CmdletBinding()]
param([ValidateSet('Inspect','Sync')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$node='C:\Program Files\nodejs\node.exe'
$git='C:\Program Files\Git\cmd\git.exe'
$manifest=Join-Path $stage 'source-hashes.json'
$files=@(
 'tools\ai_collaboration\engineering-mcp.mjs',
 'tools\ai_collaboration\local_job_service.mjs'
)
$checkPaths=@(
 'tools\powershell-direct\service.mjs',
 'tools\powershell-direct\stack-supervisor.mjs',
 'tools\ai_collaboration\engineering-plan.mjs',
 'tools\ai_collaboration\engineering-runner.mjs',
 'tools\ai_collaboration\engineering-mcp.mjs',
 'tools\ai_collaboration\local_job_service.mjs'
)
$tests=@(
 'tools/powershell-direct/tests/engineering.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/local_mcp_dispatch.test.mjs'
)
if(!(Test-Path -LiteralPath $stage -PathType Container)){throw 'STAGE_MISSING'}
if(!(Test-Path -LiteralPath $manifest -PathType Leaf)){throw 'STAGE_MANIFEST_MISSING'}
if(!(Test-Path -LiteralPath $node -PathType Leaf)){throw 'NODE_MISSING'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'GIT_MISSING'}
$branchText=(& $git -C $repo rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branchText)){throw 'GIT_BRANCH_QUERY_FAILED'}
if($branchText -cne 'platform/ai-windows-control-release-20261114'){throw 'UNEXPECTED_BRANCH'}
$changes=@(& $git -C $repo status --porcelain -- tools/powershell-direct tools/ai_collaboration)
if($LASTEXITCODE -ne 0 -or $changes.Count){throw 'SOURCE_DIRTY'}
$drift=@()
foreach($rel in $checkPaths){
  $a=Join-Path $repo $rel
  $b=Join-Path $stage $rel
  if(!(Test-Path -LiteralPath $a -PathType Leaf) -or !(Test-Path -LiteralPath $b -PathType Leaf)){throw ('FILE_MISSING_'+$rel)}
  if((Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $b -Algorithm SHA256).Hash){$drift+= $rel}
}
$unexpected=@($drift | Where-Object {$_ -notin $files})
if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Result='ENGINEERING_STAGE_DRIFT_INSPECTED'
  AllChangedModules=$drift
  ExpectedUpdateFiles=$files
  UnexpectedDrift=$unexpected
  SafeToRunExistingTwoFileSync=($unexpected.Count -eq 0 -and $drift.Count -eq 2)
  ProductionTouched=$false
 }|ConvertTo-Json -Depth 4
 return
}
if($unexpected.Count){throw ('UNEXPECTED_DRIFT_'+($unexpected -join ','))}
if($drift.Count -ne 2){throw 'EXPECTED_TWO_FILE_DRIFT_REQUIRED'}
# Test latest checkout before staging the two files.
Push-Location $repo
try {
 & $node --test @tests
 if($LASTEXITCODE -ne 0){throw 'SOURCE_TESTS_FAILED'}
 & $node 'tools/powershell-direct/tests/engineering-smoke.mjs'
 if($LASTEXITCODE -ne 0){throw 'SOURCE_MCP_SMOKE_FAILED'}
} finally { Pop-Location }
# Keep rollback copies OUTSIDE the staged tools tree.
$backup=Join-Path 'C:\Engineering' ('PowerShellDirect-Engineering-Backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
if(Test-Path -LiteralPath $backup){throw 'BACKUP_COLLISION'}
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach($rel in $files){
  $target=Join-Path $backup $rel
  New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force|Out-Null
  Copy-Item -LiteralPath (Join-Path $stage $rel) -Destination $target -ErrorAction Stop
}
Copy-Item -LiteralPath $manifest -Destination (Join-Path $backup 'source-hashes.json') -ErrorAction Stop
$success=$false
try {
  foreach($rel in $files){
   Copy-Item -LiteralPath (Join-Path $repo $rel) -Destination (Join-Path $stage $rel) -ErrorAction Stop
  }
  # ConvertFrom-Json can emit the JSON array as a single pipeline object
  # in Windows PowerShell. Decode explicitly and normalize without nesting.
  $decoded=ConvertFrom-Json -InputObject (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8)
  $rows=@()
  if($decoded -is [array]){
    foreach($entry in $decoded){$rows+= $entry}
  } elseif($null -ne $decoded) {
    $rows+= $decoded
  }
  if($rows.Count -lt 2){
    throw ('MANIFEST_INVALID_ROW_COUNT_'+$rows.Count)
  }
  foreach($row in $rows){
    if($null -eq $row -or
       !($row.PSObject.Properties.Name -contains 'File') -or
       !($row.PSObject.Properties.Name -contains 'Sha256') -or
       [string]::IsNullOrWhiteSpace([string]$row.File) -or
       [string]$row.Sha256 -notmatch '^[0-9A-Fa-f]{64}$'){
      throw 'MANIFEST_INVALID_ENTRY'
    }
  }
  foreach($rel in $files){
   $native=$rel.Replace('/','\')
   $matches=@($rows | Where-Object {$_.File.Replace('/','\') -ieq $native})
   if($matches.Count -ne 1){throw ('MANIFEST_ENTRY_MISSING_OR_DUPLICATE_'+$rel)}
   $matches[0].Sha256=(Get-FileHash -LiteralPath (Join-Path $stage $rel) -Algorithm SHA256).Hash
  }
  $tmp=Join-Path $stage 'source-hashes.next.json'
  if(Test-Path -LiteralPath $tmp){throw 'MANIFEST_TEMP_EXISTS'}
  # Preserve a proper JSON array regardless of pipeline auto-unrolling.
  ConvertTo-Json -InputObject $rows -Depth 5 |
    Set-Content -LiteralPath $tmp -Encoding UTF8
  $verifyDecoded=ConvertFrom-Json -InputObject (Get-Content -LiteralPath $tmp -Raw -Encoding UTF8)
  if($verifyDecoded -isnot [array] -or $verifyDecoded.Count -ne $rows.Count){
    throw 'MANIFEST_OUTPUT_SHAPE_INVALID'
  }
  Move-Item -LiteralPath $tmp -Destination $manifest -Force
  Push-Location $stage
  try {
   & $node --test @tests
   if($LASTEXITCODE -ne 0){throw 'STAGE_TESTS_FAILED'}
   & $node 'tools/powershell-direct/tests/engineering-smoke.mjs'
   if($LASTEXITCODE -ne 0){throw 'STAGE_MCP_SMOKE_FAILED'}
  } finally {Pop-Location}
  foreach($rel in $checkPaths){
   $a=(Get-FileHash -LiteralPath (Join-Path $repo $rel) -Algorithm SHA256).Hash
   $b=(Get-FileHash -LiteralPath (Join-Path $stage $rel) -Algorithm SHA256).Hash
   if($a -ne $b){throw ('POST_SYNC_HASH_MISMATCH_'+$rel)}
  }
  $success=$true
} finally {
 if(!$success){
  foreach($rel in $files){
   Copy-Item -LiteralPath (Join-Path $backup $rel) -Destination (Join-Path $stage $rel) -Force
  }
  Copy-Item -LiteralPath (Join-Path $backup 'source-hashes.json') -Destination $manifest -Force
 }
}
[pscustomobject]@{
 Result='ENGINEERING_LAB_SYNCED_AND_TESTED'
 UpdatedFiles=$files
 BackupDirectory=$backup
 ProductionPort17486Touched=$false
 TunnelTouched=$false
 ReadyForReadOnlyPreflight=$true
}|ConvertTo-Json -Depth 4
