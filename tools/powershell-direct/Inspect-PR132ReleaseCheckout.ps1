# Read-only inspection of PR132's fresh staging destination.
# Does not write, clean, checkout, fetch or change Git configuration.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$checkoutRoot=Join-Path $workspaceExpected 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$git='C:\Program Files\Git\cmd\git.exe'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

function Git([string[]]$Arguments){
  $global:LASTEXITCODE=0
  $items=@(& $git -c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never @Arguments 2>&1)
  $code=$global:LASTEXITCODE
  $value=[string]::Join([Environment]::NewLine,[string[]]@($items|ForEach-Object {[string]$_})).Trim()
  return [pscustomobject]@{ExitCode=$code;Output=$value}
}
function RemoteIdentity([string]$Value){
  if([string]::IsNullOrWhiteSpace($Value)){return ''}
  $s=$Value.Trim()
  try{
    $u=[Uri]$s
    if($u.IsAbsoluteUri -and $u.Host){
      $path=$u.AbsolutePath.TrimEnd('/')
      if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$path=$path.Substring(0,$path.Length-4)}
      return ($u.Host.ToLowerInvariant()+$path.ToLowerInvariant())
    }
  }catch{}
  if($s -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
    $path=$Matches.path.TrimStart('/').TrimEnd('/')
    if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$path=$path.Substring(0,$path.Length-4)}
    return ($Matches.host.ToLowerInvariant()+'/'+$path.ToLowerInvariant())
  }
  return 'UNPARSEABLE'
}

$exists=Test-Path -LiteralPath $checkoutRoot -PathType Container
$gitPath=Join-Path $checkoutRoot '.git'
$gitItem=if($exists){Get-Item -LiteralPath $gitPath -Force -ErrorAction SilentlyContinue}else{$null}
$gitKind='MISSING'
$gitDir=''
$gitPointer=''
if($gitItem){
  if($gitItem.PSIsContainer){
    $gitKind='DIRECTORY'
    $gitDir=$gitPath
  }else{
    $gitKind='FILE'
    $gitPointer=(Get-Content -LiteralPath $gitPath -TotalCount 1 -ErrorAction SilentlyContinue | Select-Object -First 1)
    if($gitPointer -match '^gitdir:\s*(.+)$'){
      $gitDir=$Matches[1]
      if(!(Split-Path -IsAbsolute $gitDir)){$gitDir=[IO.Path]::GetFullPath((Join-Path $checkoutRoot $gitDir))}
    }
  }
}
$configPath=if($gitDir){Join-Path $gitDir 'config'}else{''}
$stored=''
if($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf)){
  $inOrigin=$false
  foreach($line in (Get-Content -LiteralPath $configPath)){
    if($line -match '^\s*\[remote\s+"origin"\]\s*$'){$inOrigin=$true;continue}
    if($line -match '^\s*\['){$inOrigin=$false}
    if($inOrigin -and $line -match '^\s*url\s*=\s*(.+?)\s*$'){$stored=$Matches[1];break}
  }
}

$root=$branch=$head=$status=$remote=$null
if($exists){
  $root=Git @('-C',$checkoutRoot,'rev-parse','--show-toplevel')
  $branch=Git @('-C',$checkoutRoot,'branch','--show-current')
  $head=Git @('-C',$checkoutRoot,'rev-parse','HEAD')
  $status=Git @('-C',$checkoutRoot,'status','--porcelain=v1','--untracked-files=all')
  $remote=Git @('-C',$checkoutRoot,'remote','get-url','origin')
}
$statusLines=@()
if($status){$statusLines=@($status.Output -split "\r?\n" | Where-Object { $_ })}
$children=@()
if($exists){$children=@(Get-ChildItem -LiteralPath $checkoutRoot -Force | Select-Object -First 20 -ExpandProperty Name)}
[pscustomobject]@{
  Result='PR132_RELEASE_CHECKOUT_INSPECT_READ_ONLY'
  CheckoutExists=$exists
  CheckoutRoot=$checkoutRoot
  GitMetadataKind=$gitKind
  GitPointerIsGitDir=($gitPointer -match '^gitdir:\s*')
  GitDirExists=($gitDir -and (Test-Path -LiteralPath $gitDir -PathType Container))
  ConfigExists=($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf))
  StoredOriginIdentity=(RemoteIdentity $stored)
  EffectiveOriginIdentity=(if($remote){RemoteIdentity $remote.Output}else{''})
  RemoteExitCode=$(if($remote){$remote.ExitCode}else{$null})
  GitTopLevel=$(if($root){$root.Output}else{''})
  GitTopLevelExitCode=$(if($root){$root.ExitCode}else{$null})
  Branch=$(if($branch){$branch.Output}else{''})
  BranchExitCode=$(if($branch){$branch.ExitCode}else{$null})
  Head=$(if($head){$head.Output}else{''})
  HeadExitCode=$(if($head){$head.ExitCode}else{$null})
  WorktreeStatusLines=$statusLines
  WorktreeClean=($statusLines.Count -eq 0 -and $null -ne $status)
  TopLevelNames=$children
  NoWrites=$true
  LabChanged=$false
  ProductionChanged=$false
  CredentialsEmitted=$false
}|ConvertTo-Json -Depth 4
