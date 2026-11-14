# Optional one-time setup entrypoint. There are no mutations in Check mode.
# Install requires explicit local invocation from a CLEAN platform branch.
# Existing production services, tunnels and Chrome profiles are never restarted.
[CmdletBinding()]
param([ValidateSet('Check','Install','Uninstall')][string]$Mode='Check')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$release='C:\Engineering\ChromeBridge-Recovery-Release'
$register=Join-Path $release 'Register-StackRecovery.ps1'
$verify=Join-Path $release 'Invoke-VerifiedRecovery.ps1'
$credPath=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$native=Join-Path $PSScriptRoot 'Install-RecoveryNativeHost.ps1'
if($Mode -eq 'Check') {
  $task='NotInstalled'
  if(Test-Path -LiteralPath $register -PathType Leaf) {
    try {
      $state=& $register -Mode Check | ConvertFrom-Json
      $task=if($state.Installed){'Installed'}else{'NotInstalled'}
    }catch{$task='Unknown'}
  }
  $hostStatus=& $native -Mode Check | ConvertFrom-Json
  [PSCustomObject]@{
    ReleasePresent=(Test-Path -LiteralPath $verify -PathType Leaf)
    TaskStatus=$task
    NativeHostInstalled=[bool]$hostStatus.Installed
    DpapiCredentialPresent=(Test-Path -LiteralPath $credPath -PathType Leaf)
    Note='STATUS_ONLY_NO_MUTATION'
  }|ConvertTo-Json
  return
}
if($Mode -eq 'Uninstall') {
  if(Test-Path -LiteralPath $register -PathType Leaf) {
    & $register -Mode Unregister
  }
  & $native -Mode Uninstall
  Write-Host 'RECOVERY_AUTOSTART_AND_NATIVE_HOST_UNREGISTERED'
  Write-Host 'Encrypted credential and release files retained for reviewed manual removal.'
  return
}
if(Test-Path -LiteralPath $release) {
  throw 'RELEASE_ALREADY_EXISTS_REVIEW_BEFORE_INSTALL'
}
# Verify this EXACT source folder is tracked and clean.
$changes=@(& git -C $repo status --porcelain -- tools/ai_collaboration/recovery)
if($LASTEXITCODE -ne 0 -or $changes.Count -gt 0) {
  throw 'RECOVERY_SOURCE_NOT_CLEAN'
}
$node='C:\Program Files\nodejs\node.exe'
if(!(Test-Path -LiteralPath $node -PathType Leaf)){throw 'NODE_NOT_FOUND'}
$tests=@(
  'tools/ai_collaboration/recovery/recovery-plan.test.mjs',
  'tools/ai_collaboration/recovery/recovery-runtime.test.mjs',
  'tools/ai_collaboration/recovery/recovery-journal.test.mjs',
  'tools/ai_collaboration/recovery/windows-recovery-contract.test.mjs',
  'tools/ai_collaboration/recovery/native-host-contract.test.mjs'
)
& $node --test @tests
if($LASTEXITCODE -ne 0){throw 'RECOVERY_TESTS_NOT_PASSING'}
$prepare=Join-Path $PSScriptRoot 'Prepare-RecoveryRelease.ps1'
& $prepare -RepositoryRoot $repo -Destination $release | Out-Null
if(!(Test-Path -LiteralPath $verify -PathType Leaf)){throw 'STAGED_ENTRYPOINT_MISSING'}
& $verify -Mode Verify | Out-Null
# Read-only inspection before any installation or process launch.
& $verify -Mode Status
# Optional credential enrollment is an explicit hidden prompt and may be
# skipped; tunnel restoration remains blocked until the key is configured.
if(!(Test-Path -LiteralPath $credPath -PathType Leaf)) {
  $answer=Read-Host 'Enable tunnel recovery by storing Control Plane key in current-user DPAPI? [yes/no]'
  if($answer -eq 'yes'){
    & (Join-Path $release 'Save-RecoveryCredential.ps1')
  }
}
& $native -Mode Install
& $register -Mode Register -DesktopShortcut
Write-Host 'RECOVERY_INSTALLED_NO_REBOOT_NO_SERVICE_RESTART'
Write-Host 'Reload the existing approved PR113 extension and inspect the recovery button.'
