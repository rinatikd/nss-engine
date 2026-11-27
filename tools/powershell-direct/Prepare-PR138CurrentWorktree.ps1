# Create a separate detached worktree at the CURRENT PR138 head.
# Leaves the primary checkout and the older pinned worktree untouched.
[CmdletBinding()]
param([ValidateSet('Inspect','Prepare')][string]$Mode='Inspect')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$minimumPrimary='64a24ca8f395b1c7944f9136c6fc3fb30ca86545'
$expectedBase='f58f44a52c569a4a45e3ffe025dc6d1f62beff58'
$expectedCandidate='35e69e7e58c7e1b054a0771cabce07cc0c4108df'
$branch='feat/psdirect-per-job-workspace-approval-20261123'
$remoteIdentity='github.com/rinatikd/nss-engine'
$destination=Join-Path $root 'work\PowerShellDirect-PR138-current-release-clean'
$git='C:\Program Files\Git\cmd\git.exe'
function Quote-Argument([string]$Value){
 $builder=New-Object System.Text.StringBuilder
 [void]$builder.Append('"');$slashes=0
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
function Git([string]$Directory,[string[]]$Arguments){
 $all=@('-C',$Directory)+$Arguments
 $quoted=@($all|ForEach-Object {Quote-Argument ([string]$_)})
 $psi=New-Object System.Diagnostics.ProcessStartInfo
 $psi.FileName=$git;$psi.WorkingDirectory=$Directory
 $psi.Arguments=[string]::Join(' ',$quoted)
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=New-Object System.Diagnostics.Process;$p.StartInfo=$psi;$code=-1
 try{
  if(!$p.Start()){throw 'GIT_START_FAILED'}
  $out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(60000)){try{$p.Kill()}catch{};throw 'GIT_TIMEOUT'}
  $stdout=$out.GetAwaiter().GetResult();$stderr=$err.GetAwaiter().GetResult();$code=$p.ExitCode
 }finally{$p.Dispose()}
 if($code -ne 0){throw ('GIT_FAILED_'+$code)}
 return ([string]$stdout).Trim()
}
function RemoteIdentity([string]$Value){
 $uri=$null
 if([Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -and $uri.Host){
  $path=$uri.AbsolutePath.Trim('/')
  if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$path=$path.Substring(0,$path.Length-4)}
  return ($uri.Host.ToLowerInvariant()+'/'+$path.ToLowerInvariant())
 }
 if($Value -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
  $path=$Matches.path.Trim('/').TrimEnd('/')
  if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$path=$path.Substring(0,$path.Length-4)}
  return ($Matches.host.ToLowerInvariant()+'/'+$path.ToLowerInvariant())
 }
 return ''
}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_MISSING'}
if(!(Test-Path -LiteralPath (Join-Path $root '.git'))){throw 'PRIMARY_REPOSITORY_MISSING'}
$primary=(Resolve-Path -LiteralPath $root).ProviderPath.TrimEnd('\')
if($primary -ine $root){throw 'UNEXPECTED_PRIMARY_ROOT'}
$primaryHead=Git $root @('rev-parse','--verify','HEAD')
$null=Git $root @('merge-base','--is-ancestor',$minimumPrimary,$primaryHead)
$primaryBranch=Git $root @('branch','--show-current')
if($primaryBranch -cne 'platform/ai-windows-control-release-20261114'){throw 'PRIMARY_BRANCH_MISMATCH'}
$origin=Git $root @('remote','get-url','origin')
if((RemoteIdentity $origin) -cne $remoteIdentity){throw 'PRIMARY_REMOTE_MISMATCH'}
$dirty=Git $root @('status','--porcelain=v1','--untracked-files=all')
if(![string]::IsNullOrWhiteSpace($dirty)){throw 'PRIMARY_WORKTREE_NOT_CLEAN'}
if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Result='PR138_CURRENT_WORKTREE_PREFLIGHT'
  PrimaryHead=$primaryHead
  CandidateBranch=$branch
  CandidateSha=$expectedCandidate
  Destination=$destination
  DestinationExists=(Test-Path -LiteralPath $destination)
  PrimaryCheckoutPreserved=$true
  ProductionChanged=$false
 }|ConvertTo-Json -Compress
 return
}
if(Test-Path -LiteralPath $destination){throw 'CURRENT_WORKTREE_EXISTS_NO_OVERWRITE'}
$workRoot=Split-Path -Parent $destination
if(!(Test-Path -LiteralPath $workRoot -PathType Container)){
 $null=New-Item -ItemType Directory -Path $workRoot -ErrorAction Stop
}
$remoteRef='refs/heads/'+$branch
$trackingRef='refs/remotes/origin/'+$branch
$null=Git $root @('fetch','--no-tags','origin',($remoteRef+':'+$trackingRef))
$remoteHead=Git $root @('rev-parse',$trackingRef)
$null=Git $root @('merge-base','--is-ancestor',$expectedCandidate,$remoteHead)
$null=Git $root @('merge-base','--is-ancestor',$expectedBase,$expectedCandidate)
$null=Git $root @('worktree','add','--detach',$destination,$expectedCandidate)
$actual=Git $destination @('rev-parse','--verify','HEAD')
if($actual -cne $expectedCandidate){throw 'CURRENT_WORKTREE_HEAD_MISMATCH'}
$actualOrigin=Git $destination @('remote','get-url','origin')
if((RemoteIdentity $actualOrigin) -cne $remoteIdentity){throw 'CURRENT_WORKTREE_REMOTE_MISMATCH'}
$workDirty=Git $destination @('status','--porcelain=v1','--untracked-files=all')
if(![string]::IsNullOrWhiteSpace($workDirty)){throw 'CURRENT_WORKTREE_NOT_CLEAN'}
foreach($relative in @(
 'tools\powershell-direct\Prepare-EngineeringLabR2.ps1',
 'tools\powershell-direct\service.mjs',
 'tools\powershell-direct\stack-supervisor.mjs',
 'tools\ai_collaboration\engineering-plan.mjs',
 'tools\ai_collaboration\local_job_service.mjs',
 'tools\powershell-direct\tests\r2-stage.test.mjs'
)){
 if(!(Test-Path -LiteralPath (Join-Path $destination $relative) -PathType Leaf)){
  throw ('CURRENT_WORKTREE_REQUIRED_FILE_MISSING_'+($relative -replace '[\\/ ]','_'))
 }
}
[pscustomobject]@{
 Result='PR138_CURRENT_WORKTREE_READY'
 PrimaryCheckoutPreserved=$true
 CandidateBranch=$branch
 CandidateSha=$actual
 RemoteIdentity=$remoteIdentity
 Worktree=$destination
 WorktreeClean=$true
 ProductionChanged=$false
}|ConvertTo-Json -Compress
