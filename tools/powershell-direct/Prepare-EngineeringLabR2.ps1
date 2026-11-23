# Create-only isolated R2 staging from Git-tracked source files.
# Never overwrites R1, its supervisor, tunnel, credentials, or production.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Prepare')][string]$Mode='Inspect',
 [string]$ExpectedCommit='',
 [string]$NodeExecutable='C:\Program Files\nodejs\node.exe'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

if($ExpectedCommit -notmatch '^[0-9a-f]{40}$'){throw 'EXPECTED_COMMIT_REQUIRED'}
$expectedCommit=$ExpectedCommit.ToLowerInvariant()
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R2'
$node=$NodeExecutable
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

# Resolve both ordinary checkouts and detached Git worktrees without following
# an untrusted workspace outside this checkout.
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

# Git resolves symbolic HEADs and detached HEADs to the same immutable commit.
$head=(& $git -C $repo rev-parse --verify HEAD 2>$null | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$'){
 throw 'GIT_HEAD_RESOLVE_FAILED'
}
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

$topRaw=(& $git -C $repo rev-parse --show-toplevel 2>$null | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($topRaw)){
 throw 'GIT_TOPLEVEL_QUERY_FAILED'
}
$top=[IO.Path]::GetFullPath($topRaw)
$repoCanonical=[IO.Path]::GetFullPath($repo)
if($top.TrimEnd('\') -ine $repoCanonical.TrimEnd('\')){
 throw 'GIT_TOPLEVEL_MISMATCH'
}
$dirty=@(& $git -C $repo status --porcelain=v1 --untracked-files=all)
if($LASTEXITCODE -ne 0 -or $dirty.Count){throw 'SOURCE_WORKTREE_NOT_CLEAN'}

# Copy only tracked files. Local ignored/private files must never enter R2.
$tracked=@(& $git -C $repo ls-files -- 'tools/powershell-direct' 'tools/ai_collaboration')
if($LASTEXITCODE -ne 0){throw 'GIT_TRACKED_FILE_LIST_FAILED'}
$hashFiles=@($tracked | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
if($hashFiles.Count -lt 17){throw 'TRACKED_SOURCE_INVENTORY_TOO_SMALL'}

foreach($relative in ($required+$tests)){
 if($hashFiles -notcontains $relative){throw ('TRACKED_SOURCE_MISSING_'+($relative -replace '[\\/ ]','_'))}
}
foreach($relative in $hashFiles){
 if($relative -notmatch '^tools/(powershell-direct|ai_collaboration)/[a-zA-Z0-9_./ -]+$'){
  throw 'TRACKED_SOURCE_PATH_UNSAFE'
 }
 if($relative.Split('/') -contains '..' -or $relative.Split('/') -contains '.'){
  throw 'TRACKED_SOURCE_PATH_TRAVERSAL'
 }
 $sourcePath=Join-Path $repo ($relative.Replace('/','\'))
 if(!(Test-Path -LiteralPath $sourcePath -PathType Leaf)){throw 'TRACKED_SOURCE_FILE_MISSING'}
 $sourceItem=Get-Item -LiteralPath $sourcePath -Force
 if($sourceItem.PSIsContainer -or (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){
  throw 'SOURCE_REPARSE_POINT_DENIED'
 }
}

if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Result='R2_CREATE_ONLY_PREFLIGHT'
  CandidateSha=$head
  TargetExists=(Test-Path -LiteralPath $stage)
  RequiredSourceCount=$required.Count
  RegressionTestCount=$tests.Count
  InventoriedFileCount=$hashFiles.Count
  TrackedFilesOnly=$true
  ExistingR1Untouched=$true
  ProductionUntouched=$true
 } | ConvertTo-Json -Compress
 return
}

if(!(Test-Path -LiteralPath $node -PathType Leaf)){throw 'TRUSTED_NODE_MISSING'}
if(Test-Path -LiteralPath $stage){throw 'R2_DESTINATION_EXISTS_NO_OVERWRITE'}

$created=$false
try{
 $null=New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -ErrorAction Stop
 $created=$true
 $rows=@()
 foreach($relative in $hashFiles){
  $sourcePath=Join-Path $repo ($relative.Replace('/','\'))
  $targetPath=Join-Path $stage ($relative.Replace('/','\'))
  $targetDirectory=Split-Path -Parent $targetPath
  if(!(Test-Path -LiteralPath $targetDirectory -PathType Container)){
   $null=New-Item -ItemType Directory -Path $targetDirectory -Force -ErrorAction Stop
  }
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath -ErrorAction Stop
  $sourceHash=(Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
  $targetHash=(Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
  if($sourceHash -cne $targetHash){throw 'R2_SOURCE_HASH_MISMATCH'}
  $rows+= [pscustomobject]@{File=$relative;Sha256=$sourceHash}
 }
 $manifest=Join-Path $stage 'source-hashes.json'
 ConvertTo-Json -InputObject $rows -Depth 4 | Set-Content -LiteralPath $manifest -Encoding UTF8
 if(!(Test-Path -LiteralPath $manifest -PathType Leaf)){throw 'MANIFEST_MISSING'}

 [pscustomobject]@{
  Result='R2_STAGED_UNTESTED'
  Target=$stage
  VerifiedFileCount=$rows.Count
  RuntimeSourceSha=$head
  TrackedFilesOnly=$true
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
