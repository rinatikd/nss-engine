# Create a separate, pinned PR #132 source checkout for PR102 Lab release work.
# Does not modify the current checkout, installed Lab, Production or credentials.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$expectedWorkspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$expectedCommit='47fa8f35cb2bd53e2d5906d70969ac43bfe3bd75'
$remote='https://github.com/rinatikd/nss-engine.git'
$branch='feat/chat-approved-session-auth-20261122'
$git='C:\Program Files\Git\cmd\git.exe'

$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $expectedWorkspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

$workRoot=Join-Path $workspace 'work'
$checkoutRoot=Join-Path $workRoot 'ChromeBridge-PR132-47fa8f35'
$candidateRoot=Join-Path $checkoutRoot 'docs\chrome-bridge-handoff\chrome-bridge-v20'
if(!(Test-Path -LiteralPath $workRoot -PathType Container)){
  New-Item -ItemType Directory -Path $workRoot -ErrorAction Stop|Out-Null
}
if((Resolve-Path -LiteralPath $workRoot).ProviderPath -ine $workRoot){throw 'WORK_ROOT_REDIRECTED'}

function Git([string[]]$Arguments){
  $output=@(& $git -c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never @Arguments 2>&1)
  if($LASTEXITCODE -ne 0){throw ('GIT_OPERATION_FAILED: '+(($output|Out-String).Trim()))}
  return $output
}
if(!(Test-Path -LiteralPath (Join-Path $checkoutRoot '.git') -PathType Container)){
  if(Test-Path -LiteralPath $checkoutRoot){throw 'CANDIDATE_DESTINATION_EXISTS_NOT_A_VERIFIED_CLONE'}
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
    Git @('clone','--depth','1','--single-branch','--branch',$branch,'--no-tags','--',$remote,$checkoutRoot)|Out-Null
  }finally{
    foreach($name in $old.Keys){[Environment]::SetEnvironmentVariable($name,$old[$name],'Process')}
  }
}else{
  if((Resolve-Path -LiteralPath $checkoutRoot).ProviderPath -ine $checkoutRoot){throw 'CANDIDATE_PATH_REDIRECTED'}
  if((Git @('-C',$checkoutRoot,'remote','get-url','origin')|Out-String).Trim() -cne $remote){throw 'CANDIDATE_REMOTE_MISMATCH'}
  if((Git @('-C',$checkoutRoot,'branch','--show-current')|Out-String).Trim() -cne $branch){throw 'CANDIDATE_BRANCH_MISMATCH'}
}
$actual=(Git @('-C',$checkoutRoot,'rev-parse','HEAD')|Out-String).Trim()
if($actual -cne $expectedCommit){throw ('CANDIDATE_COMMIT_MISMATCH: '+$actual)}
$changes=@(Git @('-C',$checkoutRoot,'status','--porcelain=v1','--untracked-files=all'))
if($changes.Count -gt 0){throw 'CANDIDATE_WORKTREE_NOT_CLEAN'}
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
 CandidateRoot=$candidateRoot
 Branch=$branch
 CommitSha=$actual
 WorktreeClean=$true
 LabChanged=$false
 ProductionChanged=$false
 CredentialsRead=$false
}|ConvertTo-Json -Depth 4
