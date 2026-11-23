# Read-only explanation of dirty state in the PR132 release checkout.
# Reports names, hashes/config, and whitespace-only comparisons; never emits diff contents.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$expectedWorkspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$repo=Join-Path $expectedWorkspace 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$git='C:\Program Files\Git\cmd\git.exe'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $expectedWorkspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $repo -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}

function QuoteArg([string]$Value){return '"' + $Value.Replace('"','\"') + '"'}
function InvokeGit([string[]]$Args){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $q=@()
  foreach($a in $Args){$q+=(QuoteArg ([string]$a))}
  $psi.Arguments=[string]::Join(' ',$q)
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
  [pscustomobject]@{ExitCode=$p.ExitCode;Out=([string]$o.Result).Trim();ErrPresent=(![string]::IsNullOrWhiteSpace([string]$e.Result))}
}
$head=InvokeGit @('rev-parse','HEAD')
$branch=InvokeGit @('branch','--show-current')
$gitDir=InvokeGit @('rev-parse','--absolute-git-dir')
$commonDir=InvokeGit @('rev-parse','--git-common-dir')
$autoCrlf=InvokeGit @('config','--get','core.autocrlf')
$eol=InvokeGit @('config','--get','core.eol')
$status=InvokeGit @('status','--porcelain=v1','--untracked-files=all')
$lines=@()
if($status.Out){$lines=@($status.Out -split "\r?\n" | Where-Object { $_ })}
$details=@()
foreach($line in $lines){
  if($line.Length -lt 4){continue}
  $path=$line.Substring(3).Trim()
  $rel=$path.Replace('\','/')
  $ws=InvokeGit @('diff','--quiet','--ignore-space-at-eol','--',$rel)
  $cr=InvokeGit @('diff','--quiet','--ignore-cr-at-eol','--',$rel)
  $num=InvokeGit @('diff','--numstat','HEAD','--',$rel)
  $hash=InvokeGit @('rev-parse','HEAD:'+$rel)
  $working=InvokeGit @('hash-object','--',$rel)
  $attr=InvokeGit @('check-attr','text','eol','filter','--',$rel)
  $details += [pscustomobject]@{
    Status=$line.Substring(0,2)
    Path=$rel
    Numstat=$num.Out
    HeadBlob=$hash.Out
    WorktreeBlob=$working.Out
    IgnoreSpaceAtEolExit=$ws.ExitCode
    IgnoreCrAtEolExit=$cr.ExitCode
    Attributes=$attr.Out
  }
}
[pscustomobject]@{
  Result='PR132_DIRTY_STATE_DIAG_READ_ONLY'
  Head=$head.Out
  HeadExit=$head.ExitCode
  Branch=$branch.Out
  BranchExit=$branch.ExitCode
  GitDir=$gitDir.Out
  GitCommonDir=$commonDir.Out
  CoreAutoCrlf=$autoCrlf.Out
  CoreEol=$eol.Out
  WorktreeStatus=$lines
  Details=$details
  NoWrites=$true
  LabChanged=$false
  ProductionChanged=$false
}|ConvertTo-Json -Depth 5
