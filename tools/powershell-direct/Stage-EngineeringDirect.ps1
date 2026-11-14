# Create-only isolated staging: no production restart, tunnel or credential change.
[CmdletBinding()]
param([ValidateSet('Inspect','Stage','Test')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
$source=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dest='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$node='C:\Program Files\nodejs\node.exe'
$tests=@(
  'tools/powershell-direct/tests/engineering.test.mjs',
  'tools/powershell-direct/tests/named-suites.test.mjs',
  'tools/ai_collaboration/local_job_service.test.mjs',
  'tools/ai_collaboration/local_mcp_dispatch.test.mjs'
)
$required=@(
  'tools\powershell-direct\service.mjs',
  'tools\powershell-direct\stack-supervisor.mjs',
  'tools\ai_collaboration\engineering-plan.mjs',
  'tools\ai_collaboration\engineering-runner.mjs',
  'tools\ai_collaboration\engineering-mcp.mjs',
  'tools\ai_collaboration\local_job_service.mjs',
  'tools\powershell-direct\tests\engineering.test.mjs'
)
if(!(Test-Path -LiteralPath $node -PathType Leaf)){throw 'NODE_NOT_FOUND'}
if($Mode -eq 'Inspect'){
  $status=@(& git -C $source status --porcelain -- tools/powershell-direct tools/ai_collaboration)
  [PSCustomObject]@{
    Mode='READ_ONLY'
    Branch=(& git -C $source branch --show-current)
    Source=$source
    StageExists=(Test-Path -LiteralPath $dest)
    PendingSourceChanges=$status.Count
    ProductionModified=$false
  }|ConvertTo-Json
  return
}
if($Mode -eq 'Stage'){
  if(Test-Path -LiteralPath $dest){throw 'DESTINATION_EXISTS_NO_OVERWRITE'}
  $branch=(& git -C $source branch --show-current).Trim()
  if($branch -ne 'platform/ai-windows-control-release-20261114'){throw 'UNEXPECTED_PLATFORM_BRANCH'}
  $changes=@(& git -C $source status --porcelain -- tools/powershell-direct tools/ai_collaboration)
  if($LASTEXITCODE -ne 0 -or $changes.Count){throw 'SOURCE_DIRTY_NO_STAGE'}
  foreach($relative in $required){
    if(!(Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)){
      throw ('MISSING_REQUIRED_SOURCE_'+$relative)
    }
  }
  Push-Location -LiteralPath $source
  try {
    & $node --test @tests
    if($LASTEXITCODE -ne 0){throw 'ENGINEERING_TESTS_FAILED'}
  } finally {Pop-Location}
  New-Item -ItemType Directory -Path (Join-Path $dest 'tools') -Force|Out-Null
  Copy-Item -LiteralPath (Join-Path $source 'tools\powershell-direct') -Destination (Join-Path $dest 'tools\powershell-direct') -Recurse
  Copy-Item -LiteralPath (Join-Path $source 'tools\ai_collaboration') -Destination (Join-Path $dest 'tools\ai_collaboration') -Recurse
  $hashes=@(Get-ChildItem (Join-Path $dest 'tools') -Recurse -File |
    Where-Object {$_.Extension -in '.mjs','.js','.ps1'} |
    ForEach-Object {
      [pscustomobject]@{
        File=$_.FullName.Substring($dest.Length+1)
        Sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
      }
    })
  $hashes|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $dest 'source-hashes.json') -Encoding UTF8
}
if(!(Test-Path -LiteralPath $dest -PathType Container)){throw 'STAGE_NOT_FOUND'}
Push-Location -LiteralPath $dest
try{
  foreach($relative in $required){
    & $node --check (Join-Path $dest $relative)
    if($LASTEXITCODE -ne 0){throw ('STAGED_SYNTAX_FAILED_'+$relative)}
  }
  & $node --test @tests
  if($LASTEXITCODE -ne 0){throw 'STAGED_TESTS_FAILED'}
} finally {Pop-Location}
[PSCustomObject]@{
  Result='ENGINEERING_LAB_STAGED_AND_TESTED'
  Stage=$dest
  ProductionPort17486Touched=$false
  TunnelTouched=$false
  NewRemoteMcpToolsInstalled=$false
}|ConvertTo-Json
