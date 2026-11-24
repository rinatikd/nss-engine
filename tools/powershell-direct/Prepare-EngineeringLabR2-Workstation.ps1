# Workstation-compatible R2 staging adapter for the pinned PR138 worktree.
# Uses ProcessStartInfo for Git to avoid PowerShell 5.1 native call-operator issues.
# Does not modify the pinned worktree, R1, live supervisors, tunnels or Production.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Prepare')][string]$Mode='Inspect',
 [string]$SourceRoot='C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\PowerShellDirect-PR138-pinned-release-clean',
 [string]$NodeExecutable='C:\Program Files\nodejs\node.exe'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$expectedCommit='5f6837a8f99dd0db23f35ec84e1b4dc8c172886d'
$expectedRemote='github.com/rinatikd/nss-engine'
$expectedSource='C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\PowerShellDirect-PR138-pinned-release-clean'
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R2'
$git='C:\Program Files\Git\cmd\git.exe'
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
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_MISSING'}
if(!(Test-Path -LiteralPath $NodeExecutable -PathType Leaf)){throw 'TRUSTED_NODE_MISSING'}
$source=(Resolve-Path -LiteralPath $SourceRoot).ProviderPath.TrimEnd('\')
if($source -ine $expectedSource){throw 'UNEXPECTED_PINNED_SOURCE_PATH'}
function Quote-GitArgument([string]$Value){
 $builder=New-Object System.Text.StringBuilder
 [void]$builder.Append('"')
 $slashes=0
 foreach($character in $Value.ToCharArray()){
  if($character -eq [char]'\'){$slashes++;continue}
  if($character -eq [char]'"'){
   if($slashes -gt 0){[void]$builder.Append(('\' * ($slashes*2)))}
   [void]$builder.Append('\"');$slashes=0;continue
  }
  if($slashes -gt 0){[void]$builder.Append(('\' * $slashes));$slashes=0}
  [void]$builder.Append($character)
 }
 if($slashes -gt 0){[void]$builder.Append(('\' * ($slashes*2)))}
 [void]$builder.Append('"')
 return $builder.ToString()
}
function Invoke-Git([string]$Root,[string[]]$GitArguments){
 $all=@('-C',$Root)+$GitArguments
 $quoted=@($all|ForEach-Object {Quote-GitArgument ([string]$_)})
 $psi=New-Object System.Diagnostics.ProcessStartInfo
 $psi.FileName=$git
 $psi.WorkingDirectory=$Root
 $psi.Arguments=[string]::Join(' ',$quoted)
 $psi.UseShellExecute=$false
 $psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true
 $psi.RedirectStandardError=$true
 $proc=New-Object System.Diagnostics.Process
 $proc.StartInfo=$psi
 $code=-1
 try{
  if(!$proc.Start()){throw 'GIT_START_FAILED'}
  $outTask=$proc.StandardOutput.ReadToEndAsync()
  $errTask=$proc.StandardError.ReadToEndAsync()
  if(!$proc.WaitForExit(60000)){try{$proc.Kill()}catch{};throw 'GIT_TIMEOUT'}
  $stdout=$outTask.GetAwaiter().GetResult()
  $stderr=$errTask.GetAwaiter().GetResult()
  $code=$proc.ExitCode
 }finally{$proc.Dispose()}
 if($code -ne 0){throw ('GIT_FAILED_'+$code)}
 return ([string]$stdout).Trim()
}
function Get-RemoteIdentity([string]$Value){
 $uri=$null
 if([Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -and $uri.Host){
  $p=$uri.AbsolutePath.Trim('/')
  if($p.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$p=$p.Substring(0,$p.Length-4)}
  return ($uri.Host.ToLowerInvariant()+'/'+$p.ToLowerInvariant())
 }
 if($Value -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
  $p=$Matches.path.Trim('/').TrimEnd('/')
  if($p.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$p=$p.Substring(0,$p.Length-4)}
  return ($Matches.host.ToLowerInvariant()+'/'+$p.ToLowerInvariant())
 }
 return ''
}
$head=Invoke-Git $source @('rev-parse','--verify','HEAD')
if($head -cne $expectedCommit){throw 'UNEXPECTED_CANDIDATE_COMMIT'}
$topRaw=Invoke-Git $source @('rev-parse','--show-toplevel')
$top=[IO.Path]::GetFullPath($topRaw)
if($top.TrimEnd('\') -ine $source.TrimEnd('\')){throw 'GIT_TOPLEVEL_MISMATCH'}
$origin=Invoke-Git $source @('remote','get-url','origin')
if((Get-RemoteIdentity $origin) -cne $expectedRemote){throw 'GIT_REMOTE_MISMATCH'}
$dirty=Invoke-Git $source @('status','--porcelain=v1','--untracked-files=all')
if(-not [string]::IsNullOrWhiteSpace($dirty)){throw 'SOURCE_WORKTREE_NOT_CLEAN'}
$trackedText=Invoke-Git $source @('ls-files','--','tools/powershell-direct','tools/ai_collaboration')
$hashFiles=@($trackedText -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
if($hashFiles.Count -lt 17){throw 'TRACKED_SOURCE_INVENTORY_TOO_SMALL'}
foreach($relative in ($required+$tests)){
 if($hashFiles -notcontains $relative){throw ('TRACKED_SOURCE_MISSING_'+($relative -replace '[\\/ ]','_'))}
}
foreach($relative in $hashFiles){
 if($relative -notmatch '^tools/(powershell-direct|ai_collaboration)/[a-zA-Z0-9_./ -]+$'){throw 'TRACKED_SOURCE_PATH_UNSAFE'}
 if($relative.Split('/') -contains '..' -or $relative.Split('/') -contains '.'){throw 'TRACKED_SOURCE_PATH_TRAVERSAL'}
 $sourcePath=Join-Path $source ($relative.Replace('/','\'))
 if(!(Test-Path -LiteralPath $sourcePath -PathType Leaf)){throw 'TRACKED_SOURCE_FILE_MISSING'}
 $sourceItem=Get-Item -LiteralPath $sourcePath -Force
 if($sourceItem.PSIsContainer -or (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'SOURCE_REPARSE_POINT_DENIED'}
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
 }|ConvertTo-Json -Compress
 return
}
if(Test-Path -LiteralPath $stage){throw 'R2_DESTINATION_EXISTS_NO_OVERWRITE'}
$created=$false
try{
 $null=New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -ErrorAction Stop
 $created=$true
 $rows=@()
 foreach($relative in $hashFiles){
  $from=Join-Path $source ($relative.Replace('/','\'))
  $to=Join-Path $stage ($relative.Replace('/','\'))
  $directory=Split-Path -Parent $to
  if(!(Test-Path -LiteralPath $directory -PathType Container)){
   $null=New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop
  }
  Copy-Item -LiteralPath $from -Destination $to -ErrorAction Stop
  $sourceHash=(Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash
  $targetHash=(Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash
  if($sourceHash -cne $targetHash){throw 'R2_SOURCE_HASH_MISMATCH'}
  $rows+= [pscustomobject]@{File=$relative;Sha256=$sourceHash}
 }
 $manifest=Join-Path $stage 'source-hashes.json'
 ConvertTo-Json -InputObject $rows -Depth 4|Set-Content -LiteralPath $manifest -Encoding UTF8
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
 }|ConvertTo-Json -Compress
}catch{
 if($created){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue}
 throw
}
