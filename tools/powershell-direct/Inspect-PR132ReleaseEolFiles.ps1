# Read-only per-file analysis of EOL-only dirty files in PR132 disposable checkout.
# No writes, staging, restore, checkout, fetch or config changes.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$repo=Join-Path $workspace 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$git='C:\Program Files\Git\cmd\git.exe'
$resolved=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($resolved -ine $workspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $repo -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

function RunGit([string]$CommandLine){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments=$CommandLine
  $psi.WorkingDirectory=$repo
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $p=New-Object System.Diagnostics.Process
  $p.StartInfo=$psi
  if(!$p.Start()){throw 'GIT_PROCESS_START_FAILED'}
  $o=$p.StandardOutput.ReadToEndAsync()
  $e=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(15000)){try{$p.Kill()}catch{};throw 'GIT_READ_TIMEOUT'}
  $p.WaitForExit()
  [pscustomobject]@{ExitCode=$p.ExitCode;Output=[string]$o.Result;Stderr=[string]$e.Result}
}
$status=RunGit 'status --porcelain=v1 --untracked-files=all'
if($status.ExitCode -ne 0){throw 'GIT_STATUS_FAILED'}
$lines=@($status.Output -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$results=@()
foreach($line in $lines){
  if($line.Length -lt 4){throw 'STATUS_LINE_INVALID'}
  $path=$line.Substring(3)
  if($path.Contains([char]32) -or $path.Contains([char]9)){throw 'UNEXPECTED_COMPLEX_PATH'}
  $attr=RunGit ('check-attr text eol filter -- '+$path)
  $eol=RunGit ('ls-files --eol -- '+$path)
  $index=RunGit ('rev-parse :'+$path)
  $head=RunGit ('rev-parse HEAD:'+ $path)
  $cleanHash=RunGit ('hash-object --path='+$path+' -- '+$path)
  $rawHash=RunGit ('hash-object -- '+$path)
  $num=RunGit ('diff --numstat -- '+$path)
  $quiet=RunGit ('diff --quiet --ignore-space-at-eol -- '+$path)
  $results += [pscustomobject]@{
    Status=$line.Substring(0,2)
    Path=$path
    Attributes=$attr.Output.Trim()
    Eol=$eol.Output.Trim()
    IndexBlob=$index.Output.Trim()
    HeadBlob=$head.Output.Trim()
    CleanFilteredWorktreeBlob=$cleanHash.Output.Trim()
    RawWorktreeBlob=$rawHash.Output.Trim()
    Numstat=$num.Output.Trim()
    IgnoreSpaceAtEolExit=$quiet.ExitCode
    GitCommandFailures=(
      $attr.ExitCode -ne 0 -or $eol.ExitCode -ne 0 -or
      $index.ExitCode -ne 0 -or $head.ExitCode -ne 0 -or
      $cleanHash.ExitCode -ne 0 -or $rawHash.ExitCode -ne 0 -or
      $num.ExitCode -ne 0 -or $quiet.ExitCode -gt 1
    )
  }
}
$cached=RunGit 'diff --cached --quiet'
$untracked=RunGit 'ls-files --others --exclude-standard'
[pscustomobject]@{
  Result='PR132_EOL_FILE_DIAGNOSTIC_READ_ONLY'
  Head=(RunGit 'rev-parse HEAD').Output.Trim()
  Branch=(RunGit 'branch --show-current').Output.Trim()
  StatusCount=$lines.Count
  Files=$results
  CachedDiffExit=$cached.ExitCode
  Untracked=$untracked.Output.Trim()
  NoWrites=$true
  LabChanged=$false
  ProductionChanged=$false
}|ConvertTo-Json -Depth 5
