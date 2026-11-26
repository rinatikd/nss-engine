# Read-only verification of an already-created, isolated PR138 R2 stage.
# Does not start services, open ports, copy files, or change the source/stage trees.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)]
 [ValidatePattern('^[0-9a-fA-F]{40}$')]
 [string]$ExpectedCommit,
 [string]$SourceWorktree='C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\PowerShellDirect-PR138-graceful-drain-20261125',
 [string]$StageDirectory='C:\Engineering\PowerShellDirect-Engineering-Lab-R2-PR138-graceful-drain-20261125',
 [string]$NodeExecutable='C:\Program Files\nodejs\node.exe',
 [string]$GitExecutable='C:\Program Files\Git\cmd\git.exe'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$expected=$ExpectedCommit.ToLowerInvariant()
foreach($exe in @($NodeExecutable,$GitExecutable)){
 if(![IO.Path]::IsPathRooted($exe) -or !(Test-Path -LiteralPath $exe -PathType Leaf)){
  throw 'TRUSTED_EXECUTABLE_MISSING'
 }
}
foreach($directory in @($SourceWorktree,$StageDirectory)){
 if(!(Test-Path -LiteralPath $directory -PathType Container)){throw 'R2_SOURCE_OR_STAGE_MISSING'}
 $item=Get-Item -LiteralPath $directory -Force
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
  throw 'R2_ROOT_REPARSE_POINT_DENIED'
 }
}
$source=(Resolve-Path -LiteralPath $SourceWorktree).ProviderPath.TrimEnd('\')
$stage=(Resolve-Path -LiteralPath $StageDirectory).ProviderPath.TrimEnd('\')
$sourcePrefix=$source+'\'
$stagePrefix=$stage+'\'
if($source -ieq $stage -or
   $stage.StartsWith($sourcePrefix,[StringComparison]::OrdinalIgnoreCase) -or
   $source.StartsWith($stagePrefix,[StringComparison]::OrdinalIgnoreCase)){
 throw 'R2_SOURCE_STAGE_PATH_OVERLAP'
}
if(!$stage.StartsWith('C:\Engineering\',[StringComparison]::OrdinalIgnoreCase)){
 throw 'R2_STAGE_OUTSIDE_ENGINEERING_ROOT'
}
if($stage -ieq 'C:\Engineering\PowerShellDirect-Engineering-Lab-R1' -or
   $stage -ieq 'C:\Engineering\PowerShellDirect-Engineering-Lab-R2' -or
   $stage -ieq 'C:\Engineering\PowerShellDirect-Engineering-Lab-R2-PR138-35e69e7'){
 throw 'R2_STAGE_TARGET_PROTECTED'
}
$head=(& $GitExecutable -C $source rev-parse --verify HEAD 2>$null | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $head -cne $expected){throw 'R2_SOURCE_COMMIT_MISMATCH'}
$origin=(& $GitExecutable -C $source remote get-url origin 2>$null | Out-String).Trim()
if($LASTEXITCODE -ne 0){throw 'R2_SOURCE_REMOTE_QUERY_FAILED'}
$identity=$origin -replace '^(https?|ssh|git)://',''
$identity=$identity -replace '^git@',''
$identity=$identity -replace '^github\.com:','github.com/'
$identity=$identity.TrimEnd('/')
if($identity.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){
 $identity=$identity.Substring(0,$identity.Length-4)
}
if($identity -cne 'github.com/rinatikd/nss-engine'){throw 'R2_SOURCE_REMOTE_MISMATCH'}
$dirty=@(& $GitExecutable -C $source status --porcelain=v1 --untracked-files=all)
if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0){throw 'R2_SOURCE_WORKTREE_NOT_CLEAN'}
$verificationTest=Join-Path $source 'tools\powershell-direct\tests\r2-stage.test.mjs'
if(!(Test-Path -LiteralPath $verificationTest -PathType Leaf)){throw 'R2_VERIFIER_TEST_MISSING'}

$names=@('R2_SOURCE_ROOT','R2_STAGE_ROOT','R2_NODE_EXE','R2_GIT_EXE')
$previous=@{}
foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try{
 $env:R2_SOURCE_ROOT=$source
 $env:R2_STAGE_ROOT=$stage
 $env:R2_NODE_EXE=$NodeExecutable
 $env:R2_GIT_EXE=$GitExecutable
 $output=(& $NodeExecutable --test --test-reporter=tap $verificationTest 2>&1 | Out-String)
 $exit=$LASTEXITCODE
 if($exit -ne 0){
  Write-Output $output
  throw 'R2_STAGE_VERIFICATION_FAILED'
 }
 if($output -notmatch '(?m)^# tests 2\s*$' -or $output -notmatch '(?m)^# pass 2\s*$' -or
    $output -notmatch '(?m)^# fail 0\s*$'){
  Write-Output $output
  throw 'R2_STAGE_VERIFICATION_SUMMARY_INVALID'
 }
 [pscustomobject]@{
  Result='R2_EXISTING_STAGE_VERIFIED'
  RuntimeSourceSha=$head
  SourceWorktree=$source
  StageDirectory=$stage
  Tests=2
  Passed=2
  Failed=0
  SourceClean=$true
  NoSourceOrStageWrites=$true
  NoServiceOrTunnelStarted=$true
  ProductionTouched=$false
 }|ConvertTo-Json -Depth 4
}finally{
 foreach($name in $names){
  [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')
 }
}
