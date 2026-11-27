# Read-only investigation of the ten whitespace-only candidate worktree changes.
# Never outputs file contents or credential values and does not alter the repository.
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

function RunGitRead([string]$CommandLine){
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
  $outTask=$p.StandardOutput.ReadToEndAsync()
  $errTask=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(15000)){try{$p.Kill()}catch{};throw 'GIT_READ_TIMEOUT'}
  $p.WaitForExit()
  [pscustomobject]@{
    ExitCode=$p.ExitCode
    Output=([string]$outTask.Result).Trim()
    StderrPresent=(![string]::IsNullOrWhiteSpace([string]$errTask.Result))
  }
}
$head=RunGitRead 'rev-parse HEAD'
$status=RunGitRead 'status --porcelain=v1 --untracked-files=all'
$flags=RunGitRead 'ls-files -v'
$attrs=RunGitRead 'check-attr --all -- docs/chrome-bridge-handoff/README.md docs/chrome-bridge-handoff/chrome-bridge-v20/CONTROL_PERMISSIONS.md docs/chrome-bridge-handoff/chrome-bridge-v20/ORCHESTRATOR.md docs/chrome-bridge-handoff/chrome-bridge-v20/README_RU.md docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/controlled-cutover.ps1 docs/chrome-bridge-handoff/chrome-bridge-v20/native/windows-runner-v07/build.ps1 docs/chrome-bridge-handoff/direct-cli-v21/README.md docs/chrome-bridge-handoff/direct-cli-v21/REPORT.md docs/chrome-bridge-handoff/direct-cli-v21/Start-SecureTunnel.ps1 docs/chrome-bridge-handoff/reports/STAGING_HISTORY.md'
$eol=RunGitRead 'config --get core.autocrlf'
$eolSetting=RunGitRead 'config --get core.eol'
$diffNum=RunGitRead 'diff --numstat'
$diffSummary=RunGitRead 'diff --summary'
$cached=RunGitRead 'diff --cached --quiet'
$diffCheck=RunGitRead 'diff --check'
$restoreStatus=RunGitRead 'status --porcelain=v1 --untracked-files=all'
$statusLines=@()
if($status.Output){$statusLines=@($status.Output -split "\r?\n" | Where-Object { $_ })}
$flagLines=@()
if($flags.Output){$flagLines=@($flags.Output -split "\r?\n" | Where-Object { $_ })}
[pscustomobject]@{
 Result='PR132_EOLO_ONLY_DIAGNOSTIC'
 Head=$head.Output
 HeadExit=$head.ExitCode
 StatusLines=$statusLines
 StatusCount=$statusLines.Count
 IndexFlags=$flagLines
 Attributes=$attrs.Output
 AttributesExit=$attrs.ExitCode
 CoreAutoCrlf=$eol.Output
 CoreAutoCrlfExit=$eol.ExitCode
 CoreEol=$eolSetting.Output
 CoreEolExit=$eolSetting.ExitCode
 DiffNumstat=$diffNum.Output
 DiffSummary=$diffSummary.Output
 CachedDiffExit=$cached.ExitCode
 DiffCheck=$diffCheck.Output
 DiffCheckExit=$diffCheck.ExitCode
 StatusAfterReadOnlyCheck=$restoreStatus.Output
 NoWrites=$true
 LabChanged=$false
 ProductionChanged=$false
}|ConvertTo-Json -Depth 5
