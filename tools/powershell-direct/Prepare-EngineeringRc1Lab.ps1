# One-time, fixed-target RC1 checkout provisioning. No production service changes.
[CmdletBinding()]
param([ValidateSet('Inspect','Prepare')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$destination='C:\Engineering\PowerShellDirect-Release-RC1-Lab'
$parent='C:\Engineering'
$remote='https://github.com/rinatikd/nss-engine.git'
$branch='release/engineering-mcp-rc1-20261115'
$expectedCommit='beae503e197847b3b44605b65d6abad3185673c1'
$git='C:\Program Files\Git\cmd\git.exe'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_REQUIRED'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $parent -PathType Container)){throw 'PARENT_NOT_FOUND'}
$resolved=(Resolve-Path -LiteralPath $parent).ProviderPath
if($resolved -ine $parent){throw 'PARENT_REDIRECTED'}
$env:GIT_TERMINAL_PROMPT='0'
$env:GCM_INTERACTIVE='0'
$env:GCM_GUI_PROMPT='0'
$gcm='C:\Program Files\Git\mingw64\bin\git-credential-manager.exe'
if(!(Test-Path -LiteralPath $gcm -PathType Leaf)){throw 'TRUSTED_GCM_NOT_FOUND'}
$env:GIT_CONFIG_GLOBAL='NUL'
$env:GIT_CONFIG_NOSYSTEM='1'
$env:GIT_OPTIONAL_LOCKS='0'
function Verify-Lab {
 if(!(Test-Path -LiteralPath $destination -PathType Container)){throw 'LAB_NOT_FOUND'}
 if((Resolve-Path -LiteralPath $destination).ProviderPath -ine $destination){throw 'LAB_REDIRECTED'}
 if(!(Test-Path -LiteralPath (Join-Path $destination '.git') -PathType Container)){throw 'LAB_GIT_NOT_FOUND'}
 $actualUrl=(& $git -C $destination remote get-url origin | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $actualUrl -cne $remote){throw 'LAB_REMOTE_MISMATCH'}
 $actualBranch=(& $git -C $destination branch --show-current | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $actualBranch -cne $branch){throw 'LAB_BRANCH_MISMATCH'}
 $actualCommit=(& $git -C $destination rev-parse HEAD | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $actualCommit -cne $expectedCommit){throw 'LAB_COMMIT_MISMATCH'}
 $changes=(& $git -C $destination status --porcelain=v1 --untracked-files=all | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $changes){throw 'LAB_DIRTY'}
 return $actualCommit
}
if($Mode -eq 'Prepare'){
 if(Test-Path -LiteralPath $destination){throw 'LAB_EXISTS_NO_OVERWRITE'}
 try{
  $null=Get-Item -LiteralPath $destination -Force -ErrorAction Stop
  throw 'LAB_EXISTS_NO_OVERWRITE'
 }catch [System.Management.Automation.ItemNotFoundException] {}
 & $git -c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never -c credential.helper= -c credential.helper=manager -c credential.interactive=false clone --depth 1 --single-branch --branch $branch --no-tags -- $remote $destination
 if($LASTEXITCODE -ne 0){throw 'LAB_CLONE_FAILED'}
}elseif(!(Test-Path -LiteralPath $destination)){
 [pscustomobject]@{Result='LAB_NOT_PREPARED';Path=$destination;ProductionChanged=$false}|ConvertTo-Json -Compress
 return
}
$head=Verify-Lab
[pscustomobject]@{Result='RC1_LAB_READY';Path=$destination;Commit=$head;ProductionChanged=$false}|ConvertTo-Json -Compress
