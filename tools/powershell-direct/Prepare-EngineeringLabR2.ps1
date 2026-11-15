# Create-only isolated R2 staging. Never overwrites the live R1 service, tunnel, or credentials.
[CmdletBinding()]
param([ValidateSet('Inspect','Prepare')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R2'
$git='C:\Program Files\Git\cmd\git.exe'
$node='C:\Program Files\nodejs\node.exe'
$branch='platform/ai-windows-control-release-20261114'
$tests=@(
 'tools/powershell-direct/tests/engineering.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/local_mcp_dispatch.test.mjs',
 'tools/powershell-direct/tests/service.test.mjs',
 'tools/powershell-direct/tests/chat-approval-config.test.mjs',
 'tools/ai_collaboration/chat-approval-attestation.test.mjs',
 'tools/ai_collaboration/chat-approval-redemption.test.mjs',
 'tools/ai_collaboration/chat-approval-replay-store.test.mjs',
 'tools/ai_collaboration/chat-approval-service.test.mjs'
)
$required=@(
 'tools/powershell-direct/service.mjs',
 'tools/powershell-direct/stack-supervisor.mjs',
 'tools/ai_collaboration/engineering-plan.mjs',
 'tools/ai_collaboration/engineering-runner.mjs',
 'tools/ai_collaboration/engineering-mcp.mjs',
 'tools/ai_collaboration/local_job_service.mjs',
 'tools/powershell-direct/tests/engineering-smoke.mjs'
)
foreach($exe in @($git,$node)){
 if(!(Test-Path -LiteralPath $exe -PathType Leaf)){throw 'TRUSTED_BINARY_MISSING'}
}
$actualBranch=(& $git -C $repo rev-parse --abbrev-ref HEAD | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $actualBranch -cne $branch){throw 'UNEXPECTED_BRANCH'}
$dirty=(& $git -C $repo status --porcelain=v1 --untracked-files=all | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $dirty){throw 'SOURCE_NOT_CLEAN'}
foreach($rel in ($required+$tests)){
 if(!(Test-Path -LiteralPath (Join-Path $repo $rel) -PathType Leaf)){throw ('SOURCE_MISSING_'+$rel)}
}
if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Result='R2_CREATE_ONLY_PREFLIGHT'
  Branch=$actualBranch
  TargetExists=(Test-Path -LiteralPath $stage)
  ExistingR1Untouched=$true
  ProductionUntouched=$true
 } | ConvertTo-Json -Compress
 return
}
if(Test-Path -LiteralPath $stage){throw 'R2_DESTINATION_EXISTS_NO_OVERWRITE'}
# Verify source BEFORE writing any staged files.
Push-Location -LiteralPath $repo
try {
 & $node --test @tests
 if($LASTEXITCODE -ne 0){throw 'SOURCE_TESTS_FAILED'}
 & $node 'tools/powershell-direct/tests/engineering-smoke.mjs'
 if($LASTEXITCODE -ne 0){throw 'SOURCE_SMOKE_FAILED'}
}finally{Pop-Location}
if(Test-Path -LiteralPath $stage){throw 'R2_DESTINATION_COLLISION'}
$created=$false
try{
 $null=New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -ErrorAction Stop
 $created=$true
 Copy-Item -LiteralPath (Join-Path $repo 'tools\powershell-direct') -Destination (Join-Path $stage 'tools\powershell-direct') -Recurse -ErrorAction Stop
 Copy-Item -LiteralPath (Join-Path $repo 'tools\ai_collaboration') -Destination (Join-Path $stage 'tools\ai_collaboration') -Recurse -ErrorAction Stop
 $rows=@()
 foreach($rel in $required){
  $src=Join-Path $repo $rel
  $dest=Join-Path $stage $rel
  $sourceHash=(Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
  if($sourceHash -cne (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash){throw ('HASH_MISMATCH_'+$rel)}
  $rows+= [pscustomobject]@{File=$rel;Sha256=$sourceHash}
  & $node --check $dest
  if($LASTEXITCODE -ne 0){throw ('SYNTAX_FAILED_'+$rel)}
 }
 Push-Location -LiteralPath $stage
 try{
  & $node --test @tests
  if($LASTEXITCODE -ne 0){throw 'STAGE_TESTS_FAILED'}
  & $node 'tools/powershell-direct/tests/engineering-smoke.mjs'
  if($LASTEXITCODE -ne 0){throw 'STAGE_SMOKE_FAILED'}
 }finally{Pop-Location}
 # Manifest is written only after hashes and tests pass.
 $manifest=Join-Path $stage 'source-hashes.json'
 ConvertTo-Json -InputObject $rows -Depth 4 | Set-Content -LiteralPath $manifest -Encoding UTF8
 if(!(Test-Path -LiteralPath $manifest -PathType Leaf)){throw 'MANIFEST_MISSING'}
 [pscustomobject]@{
  Result='R2_STAGED_AND_TESTED'
  Target=$stage
  VerifiedModuleCount=$rows.Count
  LiveR1Restarted=$false
  ProductionTouched=$false
  TunnelTouched=$false
  CutoverPerformed=$false
 } | ConvertTo-Json -Compress
}catch{
 # Remove only the new, isolated R2 directory created by THIS invocation.
 if($created){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue}
 throw
}
