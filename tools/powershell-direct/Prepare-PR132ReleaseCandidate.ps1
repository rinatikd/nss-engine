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
function WriteCommittedBlob([string]$RelativePath){
  if($RelativePath -notmatch '^(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+$'){
    throw 'CANDIDATE_UNSAFE_RELATIVE_PATH'
  }
  $normalized=$RelativePath.Replace('/','\')
  $fullPath=[IO.Path]::GetFullPath((Join-Path $checkoutRoot $normalized))
  $prefix=[IO.Path]::GetFullPath($checkoutRoot).TrimEnd('\')+'\'
  if(-not $fullPath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){
    throw 'CANDIDATE_PATH_ESCAPES_CHECKOUT'
  }
  $cursor=$checkoutRoot
  foreach($segment in $normalized.Split('\')){
    $cursor=Join-Path $cursor $segment
    if(Test-Path -LiteralPath $cursor){
      $item=Get-Item -LiteralPath $cursor -Force
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){
        throw 'CANDIDATE_REPARSE_POINT_REFUSED'
      }
    }
  }
  if(!(Test-Path -LiteralPath $fullPath -PathType Leaf)){
    throw 'CANDIDATE_DIRTY_FILE_MISSING'
  }

  $tempPath=$fullPath+'.pr132-blobtmp-'+[guid]::NewGuid().ToString('N')
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments='cat-file blob HEAD:'+$RelativePath
  $psi.WorkingDirectory=$checkoutRoot
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $proc=New-Object System.Diagnostics.Process
  $proc.StartInfo=$psi
  if(!$proc.Start()){throw 'GIT_BLOB_PROCESS_START_FAILED'}
  $stderrTask=$proc.StandardError.ReadToEndAsync()
  $stream=$null
  try{
    $stream=[IO.File]::Open($tempPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $proc.StandardOutput.BaseStream.CopyTo($stream)
    $stream.Flush()
  }finally{
    if($stream){$stream.Dispose()}
  }
  if(!$proc.WaitForExit(15000)){
    try{$proc.Kill()}catch{}
    if(Test-Path -LiteralPath $tempPath){Remove-Item -LiteralPath $tempPath -Force}
    throw 'GIT_BLOB_READ_TIMEOUT'
  }
  $proc.WaitForExit()
  $stderr=[string]$stderrTask.Result
  if($proc.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($stderr)){
    if(Test-Path -LiteralPath $tempPath){Remove-Item -LiteralPath $tempPath -Force}
    throw 'GIT_BLOB_READ_FAILED'
  }
  Move-Item -LiteralPath $tempPath -Destination $fullPath -Force
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

# Normalize ONLY proven whitespace-at-EOL changes in this disposable release checkout.
# The index must equal HEAD and there must be no untracked files or meaningful diff.
$status=InvokeGit 'status --porcelain=v1 --untracked-files=all' $checkoutRoot
if($status.ExitCode -ne 0){throw 'CANDIDATE_STATUS_READ_FAILED'}
$normalizationPerformed=$false
if(-not [string]::IsNullOrWhiteSpace($status.Stdout)){
  $cached=InvokeGit 'diff --cached --quiet' $checkoutRoot
  $eolOnly=InvokeGit 'diff --quiet --ignore-space-at-eol' $checkoutRoot
  $untracked=GitOk 'ls-files --others --exclude-standard' $checkoutRoot
  if($cached.ExitCode -ne 0 -or $eolOnly.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($untracked)){
    throw 'CANDIDATE_WORKTREE_HAS_NON_EOL_OR_UNTRACKED_CHANGES'
  }
  $statusLines=@($status.Stdout -split "\r?\n" | Where-Object { $_ })
  foreach($line in $statusLines){
    if($line.Length -lt 4){throw 'CANDIDATE_STATUS_LINE_INVALID'}
    $state=$line.Substring(0,2).Trim()
    if($state -cne 'M'){throw 'CANDIDATE_NON_MODIFIED_STATUS_REFUSED'}
    $relativePath=$line.Substring(3).Trim()
    WriteCommittedBlob $relativePath
  }
  $normalizationPerformed=$true
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
 EolOnlyNormalizationPerformed=$normalizationPerformed
 LabChanged=$false
 ProductionChanged=$false
 CredentialsRead=$false
}|ConvertTo-Json -Depth 4
