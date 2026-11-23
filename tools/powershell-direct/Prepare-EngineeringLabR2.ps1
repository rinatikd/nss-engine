# Create-only isolated R2 staging. Never overwrites the live R1 service, tunnel, or credentials.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Prepare')][string]$Mode='Inspect',
 [string]$ExpectedCommit=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

if($ExpectedCommit -notmatch '^[0-9a-f]{40}$'){throw 'EXPECTED_COMMIT_REQUIRED'}
$expectedCommit=$ExpectedCommit.ToLowerInvariant()
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R2'
$node='C:\Program Files\nodejs\node.exe'
$git='C:\Program Files\Git\cmd\git.exe'
$expectedRemote='github.com/rinatikd/nss-engine'

$tests=@(
 'tools/ai_collaboration/workspace-policy.test.mjs',
 'tools/ai_collaboration/local_test_runner.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/powershell-direct/tests/service.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/powershell-direct/tests/engineering.test.mjs'
)
$required=@(
 'tools/powershell-direct/service.mjs',
 'tools/powershell-direct/stack-supervisor.mjs',
 'tools/powershell-direct/runner.mjs',
 'tools/ai_collaboration/engineering-plan.mjs',
 'tools/ai_collaboration/engineering-runner.mjs',
 'tools/ai_collaboration/engineering-mcp.mjs',
 'tools/ai_collaboration/local_job_service.mjs',
 'tools/ai_collaboration/local_test_runner.mjs',
 'tools/ai_collaboration/workspace-policy.mjs',
 'tools/powershell-direct/tests/engineering-smoke.mjs'
)

function Get-RemoteIdentity([string]$Value){
 if($Value -imatch '^(https?|ssh|git)://'){
  $uri=$null
  if([Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -and $uri.Host){
   $remotePath=$uri.AbsolutePath.Trim('/')
   if($remotePath.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){
    $remotePath=$remotePath.Substring(0,$remotePath.Length-4)
   }
   return ($uri.Host.ToLowerInvariant()+'/'+$remotePath.ToLowerInvariant())
  }
 }
 if($Value -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
  $remotePath=$Matches.path.Trim('/').TrimEnd('/')
  if($remotePath.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){
   $remotePath=$remotePath.Substring(0,$remotePath.Length-4)
  }
  return ($Matches.host.ToLowerInvariant()+'/'+$remotePath.ToLowerInvariant())
 }
 return ''
}

if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_MISSING'}
if(!(Test-Path -LiteralPath $node -PathType Leaf)){throw 'TRUSTED_NODE_MISSING'}

$dotGit=Join-Path $repo '.git'
if(!(Test-Path -LiteralPath $dotGit)){throw 'GIT_METADATA_MISSING'}
if(Test-Path -LiteralPath $dotGit -PathType Container){
 $gitDir=$dotGit
 $commonDir=$dotGit
}else{
 $pointer=(Get-Content -LiteralPath $dotGit -Raw).Trim()
 if($pointer -notmatch '^gitdir:\s*(.+)$'){throw 'GIT_POINTER_INVALID'}
 $gitDir=$Matches[1]
 if(![IO.Path]::IsPathRooted($gitDir)){
  $gitDir=[IO.Path]::GetFullPath((Join-Path $repo $gitDir))
 }
 $commonFile=Join-Path $gitDir 'commondir'
 if(Test-Path -LiteralPath $commonFile -PathType Leaf){
  $commonValue=(Get-Content -LiteralPath $commonFile -Raw).Trim()
  if(![IO.Path]::IsPathRooted($commonValue)){
   $commonValue=[IO.Path]::GetFullPath((Join-Path $gitDir $commonValue))
  }
  $commonDir=$commonValue
 }else{
  $commonDir=$gitDir
 }
}

$headFile=Join-Path $gitDir 'HEAD'
if(!(Test-Path -LiteralPath $headFile -PathType Leaf)){throw 'GIT_HEAD_MISSING'}
$head=(Get-Content -LiteralPath $headFile -Raw).Trim()
if($head -cne $expectedCommit){throw 'UNEXPECTED_CANDIDATE_COMMIT'}

$config=Join-Path $commonDir 'config'
if(!(Test-Path -LiteralPath $config -PathType Leaf)){throw 'GIT_CONFIG_MISSING'}
$origin=''
$inOrigin=$false
foreach($line in (Get-Content -LiteralPath $config)){
 if($line -match '^\s*\[remote\s+"origin"\]\s*$'){
  $inOrigin=$true
  continue
 }
 if($line -match '^\s*\['){$inOrigin=$false}
 if($inOrigin -and $line -match '^\s*url\s*=\s*(.+?)\s*$'){
  $origin=$Matches[1]
  break
 }
}
if((Get-RemoteIdentity $origin) -cne $expectedRemote){throw 'GIT_REMOTE_MISMATCH'}

$top=(& $git -C $repo rev-parse --show-toplevel 2>$null | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $top -ine $repo){throw 'GIT_TOPLEVEL_MISMATCH'}
$dirty=@(& $git -C $repo status --porcelain=v1 --untracked-files=all)
if($LASTEXITCODE -ne 0 -or $dirty.Count){throw 'SOURCE_WORKTREE_NOT_CLEAN'}

foreach($rel in ($required+$tests)){
 if(!(Test-Path -LiteralPath (Join-Path $repo $rel) -PathType Leaf)){
  throw ('SOURCE_MISSING_'+$rel)
 }
}

if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Result='R2_CREATE_ONLY_PREFLIGHT'
  CandidateSha=$head
  TargetExists=(Test-Path -LiteralPath $stage)
  RequiredSourceCount=$required.Count
  RegressionTestCount=$tests.Count
  ExistingR1Untouched=$true
  ProductionUntouched=$true
 } | ConvertTo-Json -Compress
 return
}

if(Test-Path -LiteralPath $stage){throw 'R2_DESTINATION_EXISTS_NO_OVERWRITE'}

$created=$false
try{
 $null=New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -ErrorAction Stop
 $created=$true
 Copy-Item -LiteralPath (Join-Path $repo 'tools\powershell-direct') -Destination (Join-Path $stage 'tools\powershell-direct') -Recurse -ErrorAction Stop
 Copy-Item -LiteralPath (Join-Path $repo 'tools\ai_collaboration') -Destination (Join-Path $stage 'tools\ai_collaboration') -Recurse -ErrorAction Stop

 $hashFiles=@($required+$tests | Select-Object -Unique)
 $rows=@()
 foreach($rel in $hashFiles){
  $src=Join-Path $repo $rel
  $dest=Join-Path $stage $rel
  $sourceHash=(Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
  if($sourceHash -cne (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash){
   throw ('HASH_MISMATCH_'+$rel)
  }
  $rows+= [pscustomobject]@{File=$rel;Sha256=$sourceHash}
 }
 $manifest=Join-Path $stage 'source-hashes.json'
 ConvertTo-Json -InputObject $rows -Depth 4 | Set-Content -LiteralPath $manifest -Encoding UTF8
 if(!(Test-Path -LiteralPath $manifest -PathType Leaf)){throw 'MANIFEST_MISSING'}

 [pscustomobject]@{
  Result='R2_STAGED_UNTESTED'
  Target=$stage
  VerifiedFileCount=$rows.Count
  RuntimeSourceSha=$head
  LiveR1Restarted=$false
  ProductionTouched=$false
  TunnelTouched=$false
  CutoverPerformed=$false
  TestsPending=$true
 } | ConvertTo-Json -Compress
}catch{
 # Remove only the new, isolated R2 directory created by THIS invocation.
 if($created){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue}
 throw
}
