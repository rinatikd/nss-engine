# Read-only inspection of PR132's fresh staging destination.
# No fetch, checkout, cleanup, config changes or file writes.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$checkoutRoot=Join-Path $workspaceExpected 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$git='C:\Program Files\Git\cmd\git.exe'
$expectedBranch='feat/chat-approved-session-auth-20261122'
$expectedHead='fb2c27a843d04e08b97dae876226751d9f3685fd'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $checkoutRoot -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}

function Quote-GitArgument([string]$Value){
  return '"' + $Value.Replace('"','\"') + '"'
}
function Invoke-GitRead([string[]]$GitArguments){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $quoted=@()
  foreach($arg in $GitArguments){$quoted += (Quote-GitArgument ([string]$arg))}
  $psi.Arguments=[string]::Join(' ',$quoted)
  $psi.WorkingDirectory=$checkoutRoot
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$psi
  if(!$process.Start()){throw 'GIT_PROCESS_START_FAILED'}
  $stdoutTask=$process.StandardOutput.ReadToEndAsync()
  $stderrTask=$process.StandardError.ReadToEndAsync()
  if(!$process.WaitForExit(15000)){
    try{$process.Kill()}catch{}
    throw 'GIT_READ_TIMEOUT'
  }
  $process.WaitForExit()
  return [pscustomobject]@{
    ExitCode=$process.ExitCode
    Stdout=([string]$stdoutTask.Result).Trim()
    Stderr=([string]$stderrTask.Result).Trim()
  }
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

$dotGit=Join-Path $checkoutRoot '.git'
$dotGitItem=Get-Item -LiteralPath $dotGit -Force -ErrorAction SilentlyContinue
$gitKind='MISSING'
$gitDir=''
$gitPointer=''
if($dotGitItem){
  if($dotGitItem.PSIsContainer){
    $gitKind='DIRECTORY'
    $gitDir=$dotGit
  }else{
    $gitKind='FILE'
    $pointerLines=@(Get-Content -LiteralPath $dotGit -TotalCount 1 -ErrorAction SilentlyContinue)
    if($pointerLines.Count -gt 0){$gitPointer=[string]$pointerLines[0]}
    if($gitPointer -match '^gitdir:\s*(.+)$'){
      $gitDir=$Matches[1]
      if(!(Split-Path -IsAbsolute $gitDir)){$gitDir=[IO.Path]::GetFullPath((Join-Path $checkoutRoot $gitDir))}
    }
  }
}
$root=Invoke-GitRead @('-c','core.hooksPath=NUL','-c','protocol.ext.allow=never','-c','protocol.file.allow=never','rev-parse','--show-toplevel')
$branch=Invoke-GitRead @('-c','core.hooksPath=NUL','-c','protocol.ext.allow=never','-c','protocol.file.allow=never','branch','--show-current')
$head=Invoke-GitRead @('-c','core.hooksPath=NUL','-c','protocol.ext.allow=never','-c','protocol.file.allow=never','rev-parse','HEAD')
$status=Invoke-GitRead @('-c','core.hooksPath=NUL','-c','protocol.ext.allow=never','-c','protocol.file.allow=never','status','--porcelain=v1','--untracked-files=all')
$remote=Invoke-GitRead @('-c','core.hooksPath=NUL','-c','protocol.ext.allow=never','-c','protocol.file.allow=never','remote','get-url','origin')

$statusLines=@()
if($status.Stdout){$statusLines=@($status.Stdout -split "\r?\n" | Where-Object { $_ })}
$topLevelNames=@(Get-ChildItem -LiteralPath $checkoutRoot -Force | Select-Object -First 20 -ExpandProperty Name)
$configPath=''
if($gitDir){$configPath=Join-Path $gitDir 'config'}
$configRemote=''
if($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf)){
  $inOrigin=$false
  foreach($line in (Get-Content -LiteralPath $configPath)){
    if($line -match '^\s*\[remote\s+"origin"\]\s*$'){$inOrigin=$true;continue}
    if($line -match '^\s*\['){$inOrigin=$false}
    if($inOrigin -and $line -match '^\s*url\s*=\s*(.+?)\s*$'){$configRemote=$Matches[1];break}
  }
}
$gitDirExists=$false
if($gitDir){$gitDirExists=Test-Path -LiteralPath $gitDir -PathType Container}
$configExists=$false
if($configPath){$configExists=Test-Path -LiteralPath $configPath -PathType Leaf}
[pscustomobject]@{
  Result='PR132_RELEASE_CHECKOUT_INSPECT_READ_ONLY'
  CheckoutExists=$true
  CheckoutRoot=$checkoutRoot
  GitMetadataKind=$gitKind
  GitDirExists=$gitDirExists
  ConfigExists=$configExists
  StoredOriginIdentity=(RemoteIdentity $configRemote)
  EffectiveOriginIdentity=(RemoteIdentity $remote.Stdout)
  RemoteExitCode=$remote.ExitCode
  GitTopLevel=$root.Stdout
  GitTopLevelExitCode=$root.ExitCode
  Branch=$branch.Stdout
  BranchExitCode=$branch.ExitCode
  BranchMatchesExpected=($branch.ExitCode -eq 0 -and $branch.Stdout -ceq $expectedBranch)
  Head=$head.Stdout
  HeadExitCode=$head.ExitCode
  HeadMatchesExpected=($head.ExitCode -eq 0 -and $head.Stdout -ceq $expectedHead)
  WorktreeStatusLines=$statusLines
  WorktreeClean=($status.ExitCode -eq 0 -and $statusLines.Count -eq 0)
  TopLevelNames=$topLevelNames
  NoWrites=$true
  LabChanged=$false
  ProductionChanged=$false
  CredentialsEmitted=$false
}|ConvertTo-Json -Depth 4
