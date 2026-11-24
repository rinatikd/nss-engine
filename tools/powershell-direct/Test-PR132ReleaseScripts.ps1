# Static Windows PowerShell 5.1 parser gate for PR132 Lab release scripts.
# Reads files only; it does not execute any updater or change the Lab.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}

$candidateRoot=Join-Path $workspaceExpected 'work\ChromeBridge-PR145-754b8f5f-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
$targets=@(
  (Join-Path $PSScriptRoot 'Refresh-PR132PinnedWorktree.ps1'),
  (Join-Path $PSScriptRoot 'Run-PR132LabPreflight.ps1'),
  (Join-Path $PSScriptRoot 'Prepare-PR145LabPort17485.ps1'),
  (Join-Path $PSScriptRoot 'Apply-PR132LabRelease.ps1'),
  (Join-Path $PSScriptRoot 'Create-PR132LabRestorePoint.ps1'),
  (Join-Path $PSScriptRoot 'Create-PR145LabPreDeployBackup.ps1'),
  (Join-Path $PSScriptRoot 'Inspect-Consilium17484Runtime.ps1'),
  (Join-Path $PSScriptRoot 'Inspect-Consilium17484Endpoints.ps1'),
  (Join-Path $PSScriptRoot 'Probe-Consilium17484Mcp.ps1'),
  (Join-Path $PSScriptRoot 'Test-ConsiliumControlRoomSuite.ps1'),
  (Join-Path $PSScriptRoot 'Inspect-PR102LabRuntime.ps1'),
  (Join-Path $PSScriptRoot 'Inspect-PR102LabRoots.ps1'),
  (Join-Path $PSScriptRoot 'Test-PR132ReleaseScripts.ps1'),
  (Join-Path $candidateRoot 'deployment\process-identity.ps1'),
  (Join-Path $candidateRoot 'deployment\verify-candidate-source.ps1'),
  (Join-Path $candidateRoot 'deployment\bootstrap-pr102-lab-server.ps1'),

  (Join-Path $candidateRoot 'deployment\upgrade-pr102-lab-server.ps1'),
  (Join-Path $candidateRoot 'deployment\upgrade-pr102-lab.ps1'),
  (Join-Path $candidateRoot 'tests\bootstrap-pr102-lab-server.test.ps1'),

  (Join-Path $candidateRoot 'tests\upgrade-pr102-lab-server.test.ps1'),
  (Join-Path $candidateRoot 'tests\upgrade-pr102-lab.test.ps1')
)
$results=@()
foreach($target in $targets){
  if(!(Test-Path -LiteralPath $target -PathType Leaf)){throw ('PARSER_TARGET_MISSING: '+$target)}
  $tokens=$null
  $parseErrors=$null
  $null=[System.Management.Automation.Language.Parser]::ParseFile($target,[ref]$tokens,[ref]$parseErrors)
  if($parseErrors -and $parseErrors.Count -gt 0){
    $detail=@($parseErrors|ForEach-Object {('{0}:{1} {2}' -f $_.Extent.StartLineNumber,$_.Extent.StartColumnNumber,$_.Message)}) -join ' | '
    throw ('POWERSHELL_PARSE_FAILED: '+$target+'; '+$detail)
  }
  $results += [pscustomobject]@{
    File=$target.Substring($workspaceExpected.Length).TrimStart('\')
    Parse='PASS'
    TokenCount=@($tokens).Count
  }
}
[pscustomobject]@{
  Result='PR132_POWERSHELL_51_PARSE_PASS'
  Runtime=$PSVersionTable.PSVersion.ToString()
  FilesChecked=$results.Count
  Results=$results
}|ConvertTo-Json -Depth 6
