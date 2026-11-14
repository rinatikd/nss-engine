# Prepare a completely separate PR115 laboratory checkout. Operator bootstrap only.
# Never changes existing production worktrees, services, tunnel, tokens, or ports.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Prepare','Test')][string]$Mode='Inspect'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$destination='C:\Engineering\PowerShellDirect-Approval-Lab-PR115'
$branch='feature/chatgpt-approval-ux-20261115'
$remote='https://github.com/rinatikd/nss-engine.git'
$git='C:\Program Files\Git\cmd\git.exe'
$node='C:\Program Files\nodejs\node.exe'
$testList=@(
 'tools/powershell-direct/tests/chat-approval-ux.test.mjs',
 'tools/powershell-direct/tests/enrolled-approver.test.mjs',
 'tools/powershell-direct/tests/durable-enrolled-approver.test.mjs'
)
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_REQUIRED'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_MISSING'}
if(!(Test-Path -LiteralPath $node -PathType Leaf)){throw 'TRUSTED_NODE_MISSING'}
$parent=Split-Path -Parent $destination
if(!(Test-Path -LiteralPath $parent -PathType Container)){throw 'LAB_PARENT_MISSING'}
$canonicalParent=[IO.Path]::GetFullPath($parent).TrimEnd('\')
if($canonicalParent -ine 'C:\Engineering'){throw 'LAB_PARENT_UNEXPECTED'}
$env:GIT_TERMINAL_PROMPT='0'
$env:GIT_CONFIG_NOSYSTEM='1'
$env:GIT_CONFIG_GLOBAL='NUL'
$env:GIT_OPTIONAL_LOCKS='0'

function Confirm-Lab {
 if(!(Test-Path -LiteralPath $destination -PathType Container)){throw 'LAB_NOT_FOUND'}
 $real=(Resolve-Path -LiteralPath $destination).ProviderPath
 if($real -ine $destination){throw 'LAB_PATH_UNEXPECTED'}
 $gitDir=Join-Path $destination '.git'
 if(!(Test-Path -LiteralPath $gitDir -PathType Container)){throw 'LAB_GIT_NOT_FOUND'}
 $repoUrl=(& $git -C $destination remote get-url origin 2>&1 | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $repoUrl -cne $remote){throw 'LAB_ORIGIN_MISMATCH'}
 $head=(& $git -C $destination rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $head -cne $branch){throw 'LAB_BRANCH_MISMATCH'}
 $dirty=(& $git -C $destination status --porcelain=v1 --untracked-files=all 2>&1 | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $dirty){throw 'LAB_DIRTY'}
 $sha=(& $git -C $destination rev-parse HEAD 2>&1 | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-fA-F0-9]{40}$'){throw 'LAB_HEAD_INVALID'}
 foreach($t in $testList){
  if(!(Test-Path -LiteralPath (Join-Path $destination $t) -PathType Leaf)){throw ('LAB_TEST_MISSING: '+$t)}
 }
 return $sha
}
if($Mode -eq 'Prepare'){
 if(Test-Path -LiteralPath $destination){throw 'LAB_ALREADY_EXISTS_NO_OVERWRITE'}
 # Clone only the fixed known branch from fixed repository into one fixed path.
 # No profile scripts, hooks, arbitrary flags, or remote-provided executable paths.
 & $git -c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never clone --depth 1 --single-branch --branch $branch --no-tags -- $remote $destination
 if($LASTEXITCODE -ne 0){throw 'LAB_CLONE_FAILED'}
}
if($Mode -eq 'Inspect' -and !(Test-Path -LiteralPath $destination)){
 [pscustomobject]@{Result='LAB_NOT_PREPARED';Destination=$destination;ProductionChanged=$false}|ConvertTo-Json -Compress
 return
}
$head=Confirm-Lab
if($Mode -eq 'Test'){
 foreach($t in $testList){
  $absolute=Join-Path $destination $t
  & $node --test $absolute
  if($LASTEXITCODE -ne 0){throw ('LAB_TEST_FAILED: '+$t)}
 }
}
[pscustomobject]@{
 Result=if($Mode -eq 'Test'){'LAB_TESTS_PASSED'}elseif($Mode -eq 'Prepare'){'LAB_PREPARED'}else{'LAB_READY'}
 Destination=$destination;Branch=$branch;Head=$head
 ProductionChanged=$false
}|ConvertTo-Json -Compress
