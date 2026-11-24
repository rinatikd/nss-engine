# Create a separate detached, SHA-pinned PR138 worktree.
# Fetches only the named branch; never switches or rewrites the primary checkout.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Prepare')][string]$Mode='Inspect',
 [Parameter(Mandatory=$true)]
 [ValidatePattern('^[0-9a-fA-F]{40}$')]
 [string]$CandidateCommit,
 [string]$RepositoryRoot='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$expectedBase='f58f44a52c569a4a45e3ffe025dc6d1f62beff58'
$candidateSha=$CandidateCommit.ToLowerInvariant()
if($candidateSha -ceq $expectedBase){throw 'CANDIDATE_SHA_MUST_ADVANCE_BASE'}'
$expectedBranch='feat/psdirect-per-job-workspace-approval-20261123'
$expectedRemote='github.com/rinatikd/nss-engine'
$oldRepo=$workspaceExpected
$workRoot=Join-Path $workspaceExpected 'work'
$newRepo=Join-Path $workRoot 'PowerShellDirect-PR138-pinned-release-clean'
$git='C:\Program Files\Git\cmd\git.exe'

$workspace=(Resolve-Path -LiteralPath $RepositoryRoot).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}
if(!(Test-Path -LiteralPath (Join-Path $oldRepo '.git') -PathType Container)){throw 'PRIMARY_GIT_DIRECTORY_MISSING'}

function QuoteGitArgument([string]$Value){
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
function InvokeGit([string]$Root,[string[]]$GitArgList){
  $all=@('-C',$Root)+$GitArgList
  $quoted=@($all|ForEach-Object {QuoteGitArgument ([string]$_)})
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
function RemoteIdentity([string]$Value){
  $uri=$null
  if([Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -and $uri.Host){
    $p=$uri.AbsolutePath.TrimEnd('/')
    if($p.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$p=$p.Substring(0,$p.Length-4)}
    return ($uri.Host.ToLowerInvariant()+$p.ToLowerInvariant())
  }
  if($Value -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
    $p=$Matches.path.TrimStart('/').TrimEnd('/')
    if($p.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$p=$p.Substring(0,$p.Length-4)}
    return ($Matches.host.ToLowerInvariant()+'/'+$p.ToLowerInvariant())
  }
  return ''
}
function AssertPrimaryCheckout {
  $branch=InvokeGit $oldRepo @('branch','--show-current')
  if($branch -cne 'platform/ai-windows-control-release-20261114'){throw 'PRIMARY_BRANCH_MISMATCH'}
  $head=InvokeGit $oldRepo @('rev-parse','HEAD')
  # Preserve the user's current branch. Accept only a clean checkout whose
  # HEAD and pinned base lie on the same ancestor chain; the detached target
  # is still the immutable PR138 runtime SHA and is created separately.
  $mergeBase=InvokeGit $oldRepo @('merge-base',$expectedBase,$head)
  if($mergeBase -cne $expectedBase -and $mergeBase -cne $head){
    throw 'PRIMARY_HISTORY_MISMATCH'
  }
  $remote=InvokeGit $oldRepo @('remote','get-url','origin')
  if((RemoteIdentity $remote) -cne $expectedRemote){throw 'PRIMARY_REMOTE_MISMATCH'}
  $status=InvokeGit $oldRepo @('status','--porcelain=v1','--untracked-files=all')
  if(-not [string]::IsNullOrWhiteSpace($status)){throw 'PRIMARY_WORKTREE_NOT_CLEAN'}
  return $head
}
$primaryHead=AssertPrimaryCheckout
if($Mode -eq 'Inspect'){
  [pscustomobject]@{
    Result='PR138_WORKTREE_PREFLIGHT'
    PrimaryHead=$primaryHead
    CandidateCommit=$candidateSha
    CandidateBranch=$expectedBranch
    Destination=$newRepo
    DestinationExists=(Test-Path -LiteralPath $newRepo)
    FetchPerformed=$false
    WorktreeCreated=$false
    ProductionChanged=$false
  }|ConvertTo-Json -Depth 4
  return
}
if(Test-Path -LiteralPath $newRepo){throw 'PR138_WORKTREE_DESTINATION_EXISTS'}
if(!(Test-Path -LiteralPath $workRoot -PathType Container)){
  New-Item -ItemType Directory -Path $workRoot -ErrorAction Stop|Out-Null
}
$remoteRef='refs/heads/'+$expectedBranch
$trackingRef='refs/remotes/origin/'+$expectedBranch
$null=InvokeGit $oldRepo @('fetch','--no-tags','origin',($remoteRef+':'+$trackingRef))
$remoteHead=InvokeGit $oldRepo @('rev-parse',$trackingRef)
# Stage only the exact caller-supplied immutable runtime commit. It must be
# a descendant of the protected base and an ancestor of the fetched feature
# branch head; never resolve a moving branch name into the runtime worktree.
$null=InvokeGit $oldRepo @('merge-base','--is-ancestor',$candidateSha,$remoteHead)
$null=InvokeGit $oldRepo @('merge-base','--is-ancestor',$expectedBase,$candidateSha)
$null=InvokeGit $oldRepo @('worktree','add','--detach',$newRepo,$candidateSha)
$actualHead=InvokeGit $newRepo @('rev-parse','HEAD')
if($actualHead -cne $candidateSha){throw 'PR138_WORKTREE_HEAD_MISMATCH'}
$actualRemote=InvokeGit $newRepo @('remote','get-url','origin')
if((RemoteIdentity $actualRemote) -cne $expectedRemote){throw 'PR138_WORKTREE_REMOTE_MISMATCH'}
$required=@(
 'tools\ai_collaboration\workspace-policy.mjs',
 'tools\ai_collaboration\workspace-policy.test.mjs',
 'tools\ai_collaboration\engineering-plan.mjs',
 'tools\ai_collaboration\engineering-runner.mjs',
 'tools\powershell-direct\stack-supervisor.mjs',
 'tools\powershell-direct\Prepare-EngineeringLabR2.ps1'
)
foreach($relative in $required){
 if(!(Test-Path -LiteralPath (Join-Path $newRepo $relative) -PathType Leaf)){
  throw ('PR138_REQUIRED_FILE_MISSING_'+($relative -replace '[\\/ ]','_'))
 }
}
$status=InvokeGit $newRepo @('status','--porcelain=v1','--untracked-files=all')
if(-not [string]::IsNullOrWhiteSpace($status)){throw 'PR138_WORKTREE_NOT_CLEAN'}
[pscustomobject]@{
  Result='PR138_PINNED_WORKTREE_READY'
  PrimaryCheckoutPreserved=$true
  PrimaryHead=$primaryHead
  CandidateBranch=$expectedBranch
  CandidateSha=$actualHead
  RemoteIdentity=$expectedRemote
  Worktree=$newRepo
  WorktreeClean=$true
  ProductionChanged=$false
}|ConvertTo-Json -Depth 4
