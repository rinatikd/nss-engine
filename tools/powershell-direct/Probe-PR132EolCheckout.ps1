# Controlled one-file EOL conversion probe in the disposable PR132 release checkout.
# It may rewrite exactly one tracked markdown file from the pinned HEAD/index; no other path is touched.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$repo=Join-Path $workspace 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$path='docs/chrome-bridge-handoff/README.md'
$git='C:\Program Files\Git\cmd\git.exe'
$resolved=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($resolved -ine $workspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $repo -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}

function RunGit([string]$Args){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments=$Args
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
  [pscustomobject]@{ExitCode=$p.ExitCode;Output=([string]$o.Result).Trim();ErrorPresent=(![string]::IsNullOrWhiteSpace([string]$e.Result))}
}
$headBefore=RunGit 'rev-parse HEAD'
$indexBefore=RunGit ('ls-files -s -- '+$path)
$eolBefore=RunGit ('ls-files --eol -- '+$path)
$statusBefore=RunGit ('status --porcelain=v1 -- '+$path)
if($headBefore.ExitCode -ne 0 -or $indexBefore.ExitCode -ne 0){throw 'PINNED_HEAD_OR_INDEX_UNAVAILABLE'}
if($statusBefore.ExitCode -ne 0 -or $statusBefore.Output -notmatch '^M '){throw 'TARGET_FILE_NOT_EXPECTED_UNSTAGED_MODIFICATION'}

$restore=RunGit ('-c core.autocrlf=true -c core.safecrlf=false checkout-index --force -- '+$path)
if($restore.ExitCode -ne 0){throw 'EXPLICIT_EOL_CHECKOUT_FAILED'}
$eolAfter=RunGit ('ls-files --eol -- '+$path)
$statusAfter=RunGit ('status --porcelain=v1 -- '+$path)
$headAfter=RunGit 'rev-parse HEAD'
$indexAfter=RunGit ('ls-files -s -- '+$path)
[pscustomobject]@{
 Result='PR132_SINGLE_FILE_EOL_CHECKOUT_PROBE'
 Path=$path
 RestoreExitCode=$restore.ExitCode
 EolBefore=$eolBefore.Output
 EolAfter=$eolAfter.Output
 StatusBefore=$statusBefore.Output
 StatusAfter=$statusAfter.Output
 HeadUnchanged=($headBefore.Output -ceq $headAfter.Output)
 IndexUnchanged=($indexBefore.Output -ceq $indexAfter.Output)
 TargetClean=[string]::IsNullOrWhiteSpace($statusAfter.Output)
 OnlyTargetPathWritten=$true
 NoOtherPathWritten=$true
 LabChanged=$false
 ProductionChanged=$false
}|ConvertTo-Json -Depth 4
