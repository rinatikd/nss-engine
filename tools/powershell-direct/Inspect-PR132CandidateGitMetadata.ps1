# Read-only PR132 candidate Git metadata inspection using a separate Git process.
# Never emits URL userinfo, query strings, fragments or credential-like values.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$expectedWorkspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$checkoutRoot=Join-Path $expectedWorkspace 'work\ChromeBridge-PR132-fb2c27a8'
$git='C:\Program Files\Git\cmd\git.exe'
$expectedRemote='https://github.com/rinatikd/nss-engine'

$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $expectedWorkspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $checkoutRoot -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

function SafeRemote([string]$Remote){
  if([string]::IsNullOrWhiteSpace($Remote)){return ''}
  $s=$Remote.Trim()
  # Parse URI schemes first so https:// is never mistaken for SCP-style SSH syntax.
  try{
    $u=[Uri]$s
    if($u.IsAbsoluteUri -and $u.Host){
      $path=$u.AbsolutePath.TrimEnd('/')
      if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$path=$path.Substring(0,$path.Length-4)}
      return ($u.Scheme.ToLowerInvariant()+'://'+$u.Host.ToLowerInvariant()+$path)
    }
  }catch{}
  # SCP-style SSH URL: git@github.com:owner/repo(.git)
  if($s -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)
function RunGit([string]$Arguments){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments=$Arguments
  $psi.WorkingDirectory=$checkoutRoot
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $p=New-Object System.Diagnostics.Process
  $p.StartInfo=$psi
  if(!$p.Start()){throw 'GIT_PROCESS_START_FAILED'}
  $outTask=$p.StandardOutput.ReadToEndAsync()
  $errTask=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(15000)){
    try{$p.Kill()}catch{}
    throw 'GIT_READ_TIMEOUT'
  }
  $p.WaitForExit()
  return [pscustomobject]@{
    ExitCode=$p.ExitCode
    Stdout=([string]$outTask.Result).Trim()
    Stderr=([string]$errTask.Result).Trim()
  }
}

$dotGit=Join-Path $checkoutRoot '.git'
$dotGitItem=Get-Item -LiteralPath $dotGit -Force -ErrorAction SilentlyContinue
$configPath=$null
if($dotGitItem -and $dotGitItem.PSIsContainer){$configPath=Join-Path $dotGit 'config'}
elseif($dotGitItem -and !$dotGitItem.PSIsContainer){
  $gitDirLine=Get-Content -LiteralPath $dotGit -TotalCount 1
  if($gitDirLine -match '^gitdir:\s*(.+)$'){
    $gitDir=$Matches[1]
    if(!(Split-Path -IsAbsolute $gitDir)){$gitDir=Join-Path $checkoutRoot $gitDir}
    $configPath=Join-Path $gitDir 'config'
  }
}
$configRemote=''
if($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf)){
  $lines=Get-Content -LiteralPath $configPath
  $inOrigin=$false
  foreach($line in $lines){
    if($line -match '^\s*\[remote\s+"origin"\]\s*$'){$inOrigin=$true;continue}
    if($line -match '^\s*\['){$inOrigin=$false}
    if($inOrigin -and $line -match '^\s*url\s*=\s*(.+?)\s*$'){$configRemote=$Matches[1];break}
  }
}
$effective=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never remote get-url origin'
$root=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never rev-parse --show-toplevel'
$branch=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never branch --show-current'
$head=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never rev-parse HEAD'
$status=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never status --porcelain=v1 --untracked-files=all'

$effectiveId=SafeRemote $effective.Stdout
$expectedMatch=($effectiveId -ieq $expectedRemote) -or ($effectiveId -ieq 'ssh://github.com/rinatikd/nss-engine')
[pscustomobject]@{
  Result='PR132_GIT_METADATA_DIAGNOSTIC_READ_ONLY'
  CheckoutExists=$true
  DotGitExists=($null -ne $dotGitItem)
  DotGitIsDirectory=($dotGitItem -and $dotGitItem.PSIsContainer)
  ConfigFileExists=($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf))
  StoredOriginIdentity=(SafeRemote $configRemote)
  EffectiveOriginIdentity=$effectiveId
  EffectiveOriginExitCode=$effective.ExitCode
  EffectiveOriginStderrPresent=(![string]::IsNullOrWhiteSpace($effective.Stderr))
  ExpectedRemoteMatches=$expectedMatch
  GitTopLevel=$root.Stdout
  GitTopLevelExitCode=$root.ExitCode
  Branch=$branch.Stdout
  BranchExitCode=$branch.ExitCode
  Head=$head.Stdout
  HeadExitCode=$head.ExitCode
  WorktreeClean=([string]::IsNullOrWhiteSpace($status.Stdout))
  WorktreeStatusLineCount=@($status.Stdout -split "`r?`n" | Where-Object { $_ }).Count
  WorktreeStatusLines=@($status.Stdout -split "`r?`n" | Where-Object { $_ } | ForEach-Object { $_.Trim() })
  StatusExitCode=$status.ExitCode
  GitCommandsTimedOut=$false
  NoGitWrites=$true
  LabChanged=$false
  ProductionChanged=$false
  CredentialsEmitted=$false
}|ConvertTo-Json -Depth 4
){
    $p=$Matches.path.TrimStart('/').TrimEnd('/')
    if($p.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$p=$p.Substring(0,$p.Length-4)}
    return ('ssh://'+$Matches.host.ToLowerInvariant()+'/'+$p)
  }
  return 'UNPARSEABLE_REMOTE'
}
function RunGit([string]$Arguments){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments=$Arguments
  $psi.WorkingDirectory=$checkoutRoot
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $p=New-Object System.Diagnostics.Process
  $p.StartInfo=$psi
  if(!$p.Start()){throw 'GIT_PROCESS_START_FAILED'}
  $outTask=$p.StandardOutput.ReadToEndAsync()
  $errTask=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(15000)){
    try{$p.Kill()}catch{}
    throw 'GIT_READ_TIMEOUT'
  }
  $p.WaitForExit()
  return [pscustomobject]@{
    ExitCode=$p.ExitCode
    Stdout=([string]$outTask.Result).Trim()
    Stderr=([string]$errTask.Result).Trim()
  }
}

$dotGit=Join-Path $checkoutRoot '.git'
$dotGitItem=Get-Item -LiteralPath $dotGit -Force -ErrorAction SilentlyContinue
$configPath=$null
if($dotGitItem -and $dotGitItem.PSIsContainer){$configPath=Join-Path $dotGit 'config'}
elseif($dotGitItem -and !$dotGitItem.PSIsContainer){
  $gitDirLine=Get-Content -LiteralPath $dotGit -TotalCount 1
  if($gitDirLine -match '^gitdir:\s*(.+)$'){
    $gitDir=$Matches[1]
    if(!(Split-Path -IsAbsolute $gitDir)){$gitDir=Join-Path $checkoutRoot $gitDir}
    $configPath=Join-Path $gitDir 'config'
  }
}
$configRemote=''
if($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf)){
  $lines=Get-Content -LiteralPath $configPath
  $inOrigin=$false
  foreach($line in $lines){
    if($line -match '^\s*\[remote\s+"origin"\]\s*$'){$inOrigin=$true;continue}
    if($line -match '^\s*\['){$inOrigin=$false}
    if($inOrigin -and $line -match '^\s*url\s*=\s*(.+?)\s*$'){$configRemote=$Matches[1];break}
  }
}
$effective=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never remote get-url origin'
$root=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never rev-parse --show-toplevel'
$branch=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never branch --show-current'
$head=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never rev-parse HEAD'
$status=RunGit '-c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never status --porcelain=v1 --untracked-files=all'

$effectiveId=SafeRemote $effective.Stdout
$expectedMatch=($effectiveId -ieq $expectedRemote) -or ($effectiveId -ieq 'ssh://github.com/rinatikd/nss-engine')
[pscustomobject]@{
  Result='PR132_GIT_METADATA_DIAGNOSTIC_READ_ONLY'
  CheckoutExists=$true
  DotGitExists=($null -ne $dotGitItem)
  DotGitIsDirectory=($dotGitItem -and $dotGitItem.PSIsContainer)
  ConfigFileExists=($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf))
  StoredOriginIdentity=(SafeRemote $configRemote)
  EffectiveOriginIdentity=$effectiveId
  EffectiveOriginExitCode=$effective.ExitCode
  EffectiveOriginStderrPresent=(![string]::IsNullOrWhiteSpace($effective.Stderr))
  ExpectedRemoteMatches=$expectedMatch
  GitTopLevel=$root.Stdout
  GitTopLevelExitCode=$root.ExitCode
  Branch=$branch.Stdout
  BranchExitCode=$branch.ExitCode
  Head=$head.Stdout
  HeadExitCode=$head.ExitCode
  WorktreeClean=([string]::IsNullOrWhiteSpace($status.Stdout))
  StatusExitCode=$status.ExitCode
  GitCommandsTimedOut=$false
  NoGitWrites=$true
  LabChanged=$false
  ProductionChanged=$false
  CredentialsEmitted=$false
}|ConvertTo-Json -Depth 4
