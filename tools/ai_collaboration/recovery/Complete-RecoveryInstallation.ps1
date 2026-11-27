# Explicit operator-initiated one-time installation for the isolated Windows lab.
# Default Preview. Install performs setup, native host registration, logon task
# and a backed-up extension update. No existing dirty worktrees touched.
[CmdletBinding()]
param([ValidateSet('Preview','Install')][string]$Mode='Preview')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$pr113='C:\Engineering\ChromeBridge-PR113-Recovery-Checkout'
$labExtension='C:\Engineering\ChromeBridge-PR113-E2E-Build-v2\extension-17484'
$setup=Join-Path $PSScriptRoot 'Setup-Recovery.ps1'
$workBranch='platform/ai-windows-control-release-20261114'
$nextBranch='feature/chrome-bridge-one-click-all-tabs-20261114'
$current=& git -C $repo branch --show-current
if($LASTEXITCODE -ne 0 -or $current.Trim() -ne $workBranch){
  throw 'WRONG_PLATFORM_BRANCH'
}
$dirty=@(& git -C $repo status --porcelain)
if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0){
  throw 'DIRTY_PLATFORM_CHECKOUT_NO_AUTOMATIC_RESET'
}
if(!(Test-Path -LiteralPath $labExtension -PathType Container)){
  throw 'PR113_LAB_EXTENSION_PATH_NOT_FOUND'
}
if($Mode -eq 'Preview'){
  & $setup -Mode Check
  [PSCustomObject]@{
    Result='PREVIEW_ONLY'
    PlatformCheckout=$repo
    PR113Checkout=$pr113
    LabExtensionPath=$labExtension
    TargetExtensionId='ehmllfabjbfcinaigionjggbgonkokfg'
    Note='No installed processes, tunnels, Chrome profiles or secrets modified'
  }|ConvertTo-Json
  return
}
if(Test-Path -LiteralPath $pr113){throw 'PR113_CHECKOUT_ALREADY_EXISTS_REVIEW_REQUIRED'}
$git='C:\Program Files\Git\cmd\git.exe'
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}
& $git clone --single-branch --branch $nextBranch 'https://github.com/rinatikd/nss-engine.git' $pr113
if($LASTEXITCODE -ne 0){throw 'PR113_CLONE_FAILED'}
$installer=Join-Path $pr113 'docs\chrome-bridge-handoff\chrome-bridge-v20\deployment\Stage-OneClick-RecoveryUpdate.ps1'
if(!(Test-Path -LiteralPath $installer -PathType Leaf)){
  throw 'PR113_STAGE_SCRIPT_NOT_FOUND'
}
& $installer | Out-Host
& $setup -Mode Install
& $installer -Apply
Write-Host 'RECOVERY_INSTALLATION_STAGED_AND_REGISTERED'
Write-Host 'Reload the existing PR113 LAB extension in chrome://extensions.'
Write-Host 'Verify extension ID remains ehmllfabjbfcinaigionjggbgonkokfg.'
Write-Host 'Then press the Windows Recovery button and confirm browser/MCP health.'
