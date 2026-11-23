# Create a new detached, SHA-pinned PR132 staging worktree without modifying the old dirty checkout.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$oldRepo=Join-Path $workspaceExpected 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$newRepo=Join-Path $workspaceExpected 'work\ChromeBridge-PR132-1bd79cafd-release-clean'
$expectedSha='1bd79cafd719323c45fa7fc61a908e09b339509a'
$expectedBranch='feat/chat-approved-session-auth-20261122'
$expectedRemote='github.com/rinatikd/nss-engine'
$git='C:\Program Files\Git\cmd\git.exe'

$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $oldRepo -PathType Container)){throw 'OLD_PINNED_CHECKOUT_NOT_FOUND'}
if(Test-Path -LiteralPath $newRepo){throw 'NEW_PINNED_WORKTREE_ALREADY_EXISTS'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

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
    if(!$proc.WaitForExit(30000)){try{$proc.Kill()}catch{};throw 'GIT_TIMEOUT'}
    $stdout=$outTask.GetAwaiter().GetResult()
    $stderr=$errTask.GetAwaiter().GetResult()
    $code=$proc.ExitCode
  }finally{$proc.Dispose()}
  if($code -ne 0){throw ('GIT_FAILED '+$code+': '+$stderr.Trim())}
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

$remote=InvokeGit $oldRepo @('remote','get-url','origin')
$stored=InvokeGit $oldRepo @('config','--local','--get','remote.origin.url')
if((RemoteIdentity $remote) -cne $expectedRemote -or (RemoteIdentity $stored) -cne $expectedRemote){throw 'OLD_CHECKOUT_REMOTE_MISMATCH'}
$branch=InvokeGit $oldRepo @('branch','--show-current')
if($branch -cne $expectedBranch){throw 'OLD_CHECKOUT_BRANCH_MISMATCH'}
$oldHead=InvokeGit $oldRepo @('rev-parse','HEAD')
$cached=InvokeGit $oldRepo @('diff','--cached','--quiet')
$eolOnly=InvokeGit $oldRepo @('diff','--quiet','--ignore-space-at-eol')
$untracked=InvokeGit $oldRepo @('ls-files','--others','--exclude-standard')
if($cached -ne '' -or $eolOnly -ne '' -or -not [string]::IsNullOrWhiteSpace($untracked)){throw 'OLD_CHECKOUT_HAS_NON_EOL_OR_UNTRACKED_CHANGES'}

New-Item -ItemType Directory -Path (Split-Path -Parent $newRepo) -Force|Out-Null
$null=InvokeGit $oldRepo @('fetch','--no-tags','origin',("refs/heads/{0}:refs/remotes/origin/{0}" -f $expectedBranch))
$remoteHead=InvokeGit $oldRepo @('rev-parse',("refs/remotes/origin/{0}" -f $expectedBranch))
if($remoteHead -cne $expectedSha){throw ('REMOTE_BRANCH_HEAD_MISMATCH: '+$remoteHead)}
$null=InvokeGit $oldRepo @('merge-base','--is-ancestor',$oldHead,$expectedSha)
$null=InvokeGit $oldRepo @('worktree','add','--detach',$newRepo,$expectedSha)
$actualHead=InvokeGit $newRepo @('rev-parse','HEAD')
if($actualHead -cne $expectedSha){throw 'NEW_WORKTREE_HEAD_MISMATCH'}
$actualRemote=InvokeGit $newRepo @('remote','get-url','origin')
if((RemoteIdentity $actualRemote) -cne $expectedRemote){throw 'NEW_WORKTREE_REMOTE_MISMATCH'}

$candidateRoot=Join-Path $newRepo 'docs\chrome-bridge-handoff\chrome-bridge-v20'
if(!(Test-Path -LiteralPath (Join-Path $candidateRoot 'server\bridge.mjs') -PathType Leaf)){throw 'NEW_WORKTREE_SERVER_MISSING'}
if(!(Test-Path -LiteralPath (Join-Path $candidateRoot 'extension\session-authorization.js') -PathType Leaf)){throw 'NEW_WORKTREE_EXTENSION_MISSING'}

. (Join-Path $candidateRoot 'deployment\verify-candidate-source.ps1')
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths @('server','deployment/cutover-health.mjs','deployment/cutover-start.mjs','deployment/process-identity.ps1','deployment/verify-candidate-source.ps1','deployment/upgrade-pr102-lab-server.ps1')
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths @('extension','deployment/verify-candidate-source.ps1','deployment/upgrade-pr102-lab.ps1')
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths @('consilium-control-room','deployment/verify-candidate-source.ps1')

[pscustomobject]@{
  Result='PR132_PINNED_WORKTREE_READY'
  PreviousCheckoutPreserved=$true
  PreviousCheckoutHead=$oldHead
  CandidateBranch=$expectedBranch
  CandidateSha=$actualHead
  RemoteIdentity=$expectedRemote
  NewWorktree=$newRepo
  SourceVerifierServer='PASS'
  SourceVerifierExtension='PASS'
  SourceVerifierControlRoom='PASS'
}|ConvertTo-Json -Depth 4
