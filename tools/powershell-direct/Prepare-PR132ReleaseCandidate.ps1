# Create/validate a separate, pinned PR #132 source checkout for PR102 Lab release work.
# Preserves any existing local checkout; does not modify installed Lab, Production or credentials.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$expectedWorkspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$expectedCommit='fb2c27a843d04e08b97dae876226751d9f3685fd'
$remote='https://github.com/rinatikd/nss-engine.git'
$branch='feat/chat-approved-session-auth-20261122'
$git='C:\Program Files\Git\cmd\git.exe'

$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $expectedWorkspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

$workRoot=Join-Path $workspace 'work'
$priorCheckoutRoot=Join-Path $workRoot 'ChromeBridge-PR132-fb2c27a8'
$checkoutRoot=Join-Path $workRoot 'ChromeBridge-PR132-fb2c27a8-release-clean'
$candidateRoot=Join-Path $checkoutRoot 'docs\chrome-bridge-handoff\chrome-bridge-v20'
if(!(Test-Path -LiteralPath $workRoot -PathType Container)){
  New-Item -ItemType Directory -Path $workRoot -ErrorAction Stop|Out-Null
}
if((Resolve-Path -LiteralPath $workRoot).ProviderPath -ine $workRoot){throw 'WORK_ROOT_REDIRECTED'}

function InvokeGit([string]$CommandLine,[string]$WorkingDirectory){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments=$CommandLine
  $psi.WorkingDirectory=$WorkingDirectory
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$psi
  if(!$process.Start()){throw 'GIT_PROCESS_START_FAILED'}
  $stdoutTask=$process.StandardOutput.ReadToEndAsync()
  $stderrTask=$process.StandardError.ReadToEndAsync()
  if(!$process.WaitForExit(30000)){
    try{$process.Kill()}catch{}
    throw 'GIT_OPERATION_TIMEOUT'
  }
  $process.WaitForExit()
  return [pscustomobject]@{
    ExitCode=$process.ExitCode
    Stdout=([string]$stdoutTask.Result).Trim()
    Stderr=([string]$stderrTask.Result).Trim()
  }
}
function GitOk([string]$CommandLine,[string]$WorkingDirectory){
  $result=InvokeGit $CommandLine $WorkingDirectory
  if($result.ExitCode -ne 0){
    throw ('GIT_OPERATION_FAILED ('+$result.ExitCode+'): '+$result.Stderr)
  }
  return $result.Stdout
}
function RemoteIdentity([string]$Value){
  if([string]::IsNullOrWhiteSpace($Value)){return ''}
  $s=$Value.Trim()
  try{
    $u=[Uri]$s
    if($u.IsAbsoluteUri -and $u.Host){
      $path=$u.AbsolutePath.TrimEnd('/')
      if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){
        $path=$path.Substring(0,$path.Length-4)
      }
      return ($u.Host.ToLowerInvariant()+$path.ToLowerInvariant())
    }
  }catch{}
  if($s -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
    $path=$Matches.path.TrimStart('/').TrimEnd('/')
    if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){
      $path=$path.Substring(0,$path.Length-4)
    }
    return ($Matches.host.ToLowerInvariant()+'/'+$path.ToLowerInvariant())
  }
  return ''
}

if(Test-Path -LiteralPath $checkoutRoot){
  if(!(Test-Path -LiteralPath (Join-Path $checkoutRoot '.git') -PathType Container)){
    throw 'CANDIDATE_DESTINATION_EXISTS_NOT_A_VERIFIED_CLONE'
  }
  if((Resolve-Path -LiteralPath $checkoutRoot).ProviderPath -ine $checkoutRoot){
    throw 'CANDIDATE_PATH_REDIRECTED'
  }
}else{
  $old=@{}
  foreach($name in @('GIT_TERMINAL_PROMPT','GCM_INTERACTIVE','GCM_GUI_PROMPT','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_OPTIONAL_LOCKS','GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE')){
    $old[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
  }
  try{
    $env:GIT_TERMINAL_PROMPT='0'
    $env:GCM_INTERACTIVE='0'
    $env:GCM_GUI_PROMPT='0'
    $env:GIT_CONFIG_GLOBAL='NUL'
    $env:GIT_CONFIG_NOSYSTEM='1'
    $env:GIT_OPTIONAL_LOCKS='0'
    [Environment]::SetEnvironmentVariable('GIT_DIR',$null,'Process')
    [Environment]::SetEnvironmentVariable('GIT_WORK_TREE',$null,'Process')
    [Environment]::SetEnvironmentVariable('GIT_INDEX_FILE',$null,'Process')
    $cloneArgs='clone --depth 1 --single-branch --branch '+$branch+' --no-tags -- '+$remote+' "'+$checkoutRoot+'"'
    $null=GitOk $cloneArgs $workRoot
  }finally{
    foreach($name in $old.Keys){
      [Environment]::SetEnvironmentVariable($name,$old[$name],'Process')
    }
  }
}
if(!(Test-Path -LiteralPath (Join-Path $checkoutRoot '.git') -PathType Container)){
  throw 'CANDIDATE_CLONE_METADATA_MISSING'
}

$currentRemote=GitOk 'remote get-url origin' $checkoutRoot
if((RemoteIdentity $currentRemote) -cne (RemoteIdentity $remote)){
  throw 'CANDIDATE_REMOTE_MISMATCH'
}
$currentBranch=GitOk 'branch --show-current' $checkoutRoot
if($currentBranch -cne $branch){throw 'CANDIDATE_BRANCH_MISMATCH'}
$actual=GitOk 'rev-parse HEAD' $checkoutRoot
if($actual -cne $expectedCommit){throw ('CANDIDATE_COMMIT_MISMATCH: '+$actual)}

# A first checkout on some Windows hosts can differ only in trailing end-of-line
# whitespace. Normalize ONLY this disposable release checkout, and only after
# proving: no staged changes, no untracked files, and no meaningful diff.
$status=InvokeGit 'status --porcelain=v1 --untracked-files=all' $checkoutRoot
if($status.ExitCode -ne 0){throw 'CANDIDATE_STATUS_READ_FAILED'}
if(-not [string]::IsNullOrWhiteSpace($status.Stdout)){
  $cached=InvokeGit 'diff --cached --quiet' $checkoutRoot
  $eolOnly=InvokeGit 'diff --quiet --ignore-space-at-eol' $checkoutRoot
  $untracked=GitOk 'ls-files --others --exclude-standard' $checkoutRoot
  if($cached.ExitCode -ne 0 -or $eolOnly.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($untracked)){
    throw 'CANDIDATE_WORKTREE_HAS_NON_EOL_OR_UNTRACKED_CHANGES'
  }
  $null=GitOk 'restore --worktree -- .' $checkoutRoot
}
$changes=GitOk 'status --porcelain=v1 --untracked-files=all' $checkoutRoot
if(-not [string]::IsNullOrWhiteSpace($changes)){throw 'CANDIDATE_WORKTREE_NOT_CLEAN'}

foreach($required in @(
 'server\bridge.mjs',
 'server\tools.mjs',
 'deployment\process-identity.ps1',
 'deployment\upgrade-pr102-lab-server.ps1',
 'deployment\stage-server-lab.ps1',
 'deployment\CHAT_APPROVAL_LAB_CUTOVER.md',
 'extension\session-authorization.js'
)){
 if(!(Test-Path -LiteralPath (Join-Path $candidateRoot $required) -PathType Leaf)){
   throw ('PINNED_CANDIDATE_FILE_MISSING: '+$required)
 }
}
[pscustomobject]@{
 Result='PR132_PINNED_SOURCE_READY'
 Workspace=$workspace
 CheckoutRoot=$checkoutRoot
 PreservedPriorCheckoutRoot=$priorCheckoutRoot
 PriorCheckoutPreserved=(Test-Path -LiteralPath $priorCheckoutRoot -PathType Container)
 CandidateRoot=$candidateRoot
 Branch=$branch
 CommitSha=$actual
 WorktreeClean=$true
EolOnlyNormalizationPerformed=(![string]::IsNullOrWhiteSpace($status.Stdout))
 LabChanged=$false
 ProductionChanged=$false
 CredentialsRead=$false
}|ConvertTo-Json -Depth 4
