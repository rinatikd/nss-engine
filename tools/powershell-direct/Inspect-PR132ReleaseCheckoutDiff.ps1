# Read-only diagnosis of the PR132 release checkout's dirty state.
# No file writes, fetch, checkout, staging, cleanup or Git configuration changes.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$repo=Join-Path $workspaceExpected 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$git='C:\Program Files\Git\cmd\git.exe'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $repo -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

function InvokeGitRead([string]$Arguments){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments=$Arguments
  $psi.WorkingDirectory=$repo
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $p=New-Object System.Diagnostics.Process
  $p.StartInfo=$psi
  if(!$p.Start()){throw 'GIT_PROCESS_START_FAILED'}
  $outTask=$p.StandardOutput.ReadToEndAsync()
  $errTask=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(15000)){try{$p.Kill()}catch{};throw 'GIT_READ_TIMEOUT'}
  $p.WaitForExit()
  [pscustomobject]@{
    ExitCode=$p.ExitCode
    Stdout=([string]$outTask.Result).Trim()
    StderrPresent=(![string]::IsNullOrWhiteSpace([string]$errTask.Result))
  }
}
$head=InvokeGitRead 'rev-parse HEAD'
$branch=InvokeGitRead 'branch --show-current'
$gitDir=InvokeGitRead 'rev-parse --absolute-git-dir'
$commonDir=InvokeGitRead 'rev-parse --git-common-dir'
$autoCrlf=InvokeGitRead 'config --get core.autocrlf'
$coreEol=InvokeGitRead 'config --get core.eol'
$status=InvokeGitRead 'status --porcelain=v1 --untracked-files=all'
$diffStat=InvokeGitRead 'diff --stat'
$diffIgnoreEol=InvokeGitRead 'diff --quiet --ignore-space-at-eol'
$diffIgnoreCr=InvokeGitRead 'diff --quiet --ignore-cr-at-eol'
$cachedDiff=InvokeGitRead 'diff --cached --quiet'
$statusLines=@()
if($status.Stdout){$statusLines=@($status.Stdout -split "\r?\n" | Where-Object { $_ })}
[pscustomobject]@{
  Result='PR132_DIRTY_STATE_DIAG_READ_ONLY'
  Head=$head.Stdout
  HeadExit=$head.ExitCode
  Branch=$branch.Stdout
  BranchExit=$branch.ExitCode
  GitDir=$gitDir.Stdout
  GitDirExit=$gitDir.ExitCode
  GitCommonDir=$commonDir.Stdout
  GitCommonDirExit=$commonDir.ExitCode
  CoreAutoCrlf=$autoCrlf.Stdout
  CoreAutoCrlfExit=$autoCrlf.ExitCode
  CoreEol=$coreEol.Stdout
  CoreEolExit=$coreEol.ExitCode
  WorktreeStatusLines=$statusLines
  WorktreeStatusCount=$statusLines.Count
  DiffStat=$diffStat.Stdout
  DiffExitIgnoringSpaceAtEol=$diffIgnoreEol.ExitCode
  DiffExitIgnoringCrAtEol=$diffIgnoreCr.ExitCode
  CachedDiffExit=$cachedDiff.ExitCode
  CommandsHadStderr=($head.StderrPresent -or $branch.StderrPresent -or $gitDir.StderrPresent -or $commonDir.StderrPresent -or $status.StderrPresent)
  NoWrites=$true
  LabChanged=$false
  ProductionChanged=$false
}|ConvertTo-Json -Depth 4
