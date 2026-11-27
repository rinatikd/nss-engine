# Read-only diagnosis of the existing pinned PR #132 checkout remote.
# Outputs URL identity only; never emits URL userinfo, query, fragment or credentials.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$expectedWorkspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$checkoutRoot=Join-Path $expectedWorkspace 'work\ChromeBridge-PR132-fb2c27a8'
$expectedCommit='fb2c27a843d04e08b97dae876226751d9f3685fd'
$expectedBranch='feat/chat-approved-session-auth-20261122'
$expectedHost='github.com'
$expectedPath='/rinatikd/nss-engine'

$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $expectedWorkspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $checkoutRoot -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}
$git='C:\Program Files\Git\cmd\git.exe'
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}
if(!(Test-Path -LiteralPath (Join-Path $checkoutRoot '.git'))){throw 'GIT_METADATA_NOT_FOUND'}

function Git([string[]]$Arguments){
  $global:LASTEXITCODE=0
  $lines=@(& $git -c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never @Arguments 2>&1)
  $code=$global:LASTEXITCODE
  if($code -ne 0){throw ('GIT_READ_FAILED ('+$code+')')}
  return [string]::Join([Environment]::NewLine,[string[]]@($lines|ForEach-Object {[string]$_})).Trim()
}
function SafeRemote([string]$Remote){
  if([string]::IsNullOrWhiteSpace($Remote)){return ''}
  $s=$Remote.Trim()
  # SCP-style SSH URL: git@github.com:owner/repo(.git)
  if($s -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
    return ('ssh://'+$Matches.host.ToLowerInvariant()+'/'+$Matches.path.TrimStart('/').TrimEnd('/').TrimEnd('.git'))
  }
  try{
    $u=[Uri]$s
    if(!$u.IsAbsoluteUri){return 'UNPARSEABLE_REMOTE'}
    $host=$u.Host.ToLowerInvariant()
    $path=$u.AbsolutePath.TrimEnd('/')
    if($host -eq 'github.com' -and $path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){
      $path=$path.Substring(0,$path.Length-4)
    }
    return ($u.Scheme.ToLowerInvariant()+'://'+$host+$path)
  }catch{return 'UNPARSEABLE_REMOTE'}
}

$stored=Git -Arguments @('-C',$checkoutRoot,'config','--local','--get','remote.origin.url')
$effective=Git -Arguments @('-C',$checkoutRoot,'remote','get-url','origin')
$branch=Git -Arguments @('-C',$checkoutRoot,'branch','--show-current')
$head=Git -Arguments @('-C',$checkoutRoot,'rev-parse','HEAD')
$top=Git -Arguments @('-C',$checkoutRoot,'rev-parse','--show-toplevel')
$status=Git -Arguments @('-C',$checkoutRoot,'status','--porcelain=v1','--untracked-files=all')

$storedSafe=SafeRemote $stored
$effectiveSafe=SafeRemote $effective
$expectedSafe='https://github.com/rinatikd/nss-engine'
$effectiveIsExpected=($effectiveSafe -ieq $expectedSafe) -or ($effectiveSafe -ieq 'ssh://github.com/rinatikd/nss-engine')
$clean=[string]::IsNullOrWhiteSpace($status)
[pscustomobject]@{
  Result='PR132_REMOTE_DIAGNOSTIC_READ_ONLY'
  CheckoutRoot=$checkoutRoot
  GitTopLevel=$top
  StoredRemoteIdentity=$storedSafe
  EffectiveRemoteIdentity=$effectiveSafe
  RemoteIdentityMatchesExpected=$effectiveIsExpected
  Branch=$branch
  ExpectedBranch=$expectedBranch
  BranchMatchesExpected=($branch -ceq $expectedBranch)
  Head=$head
  ExpectedHead=$expectedCommit
  HeadMatchesExpected=($head -ceq $expectedCommit)
  WorktreeClean=$clean
  WorktreeStatusPresent=(!$clean)
  NoGitWrites=$true
  LabChanged=$false
  ProductionChanged=$false
  CredentialsEmitted=$false
}|ConvertTo-Json -Depth 4
