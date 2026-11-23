# Create a separate, pinned PR #132 source checkout for PR102 Lab release work.
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

function Git([string[]]$Arguments){
  $global:LASTEXITCODE=0
  $gitLines=@(& $git -c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never @Arguments 2>&1)
  $exitCode=$global:LASTEXITCODE
  if($exitCode -ne 0){throw ('GIT_OPERATION_FAILED ('+$exitCode+'): '+(($gitLines|Out-String).Trim()))}
  $gitText=[string]::Join([Environment]::NewLine,[string[]]@($gitLines|ForEach-Object {[string]$_}))
  return $gitText
}

function RemoteIdentity([string]$Value){
  if([string]::IsNullOrWhiteSpace($Value)){return ''}
  $s=$Value.Trim()
  # Parse URI schemes first: HTTPS must not be mistaken for SCP-style SSH syntax.
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
  # SCP-style SSH URL: git@github.com:owner/repo(.git)
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
  foreach($name in @('GIT_TERMINAL_PROMPT','GCM_INTERACTIVE','GCM_GUI_PROMPT','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_OPTIONAL_LOCKS')){
    $old[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
  }
  try{
    $env:GIT_TERMINAL_PROMPT='0'
    $env:GCM_INTERACTIVE='0'
    $env:GCM_GUI_PROMPT='0'
    $env:GIT_CONFIG_GLOBAL='NUL'
    $env:GIT_CONFIG_NOSYSTEM='1'
    $env:GIT_OPTIONAL_LOCKS='0'
    Git -Arguments @('clone','--depth','1','--single-branch','--branch',$branch,'--no-tags','--',$remote,$checkoutRoot)|Out-Null
  }finally{
    foreach($name in $old.Keys){
      [Environment]::SetEnvironmentVariable($name,$old[$name],'Process')
    }
  }
}
if(!(Test-Path -LiteralPath (Join-Path $checkoutRoot '.git') -PathType Container)){
  throw 'CANDIDATE_CLONE_METADATA_MISSING'
}

$currentRemote=(Git -Arguments @('-C',$checkoutRoot,'remote','get-url','origin')|Out-String).Trim()
if((RemoteIdentity $currentRemote) -cne (RemoteIdentity $remote)){
  throw 'CANDIDATE_REMOTE_MISMATCH'
}
$currentBranch=(Git -Arguments @('-C',$checkoutRoot,'branch','--show-current')|Out-String).Trim()
if($currentBranch -cne $branch){throw 'CANDIDATE_BRANCH_MISMATCH'}
$actual=(Git -Arguments @('-C',$checkoutRoot,'rev-parse','HEAD')|Out-String).Trim()
if($actual -cne $expectedCommit){throw ('CANDIDATE_COMMIT_MISMATCH: '+$actual)}
$changes=Git -Arguments @('-C',$checkoutRoot,'status','--porcelain=v1','--untracked-files=all')
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
 LabChanged=$false
 ProductionChanged=$false
 CredentialsRead=$false
}|ConvertTo-Json -Depth 4
