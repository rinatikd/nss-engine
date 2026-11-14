# Engineering MCP RC1 — operator-safe offline release qualification.
# Runs only against this checkout. Never starts/stops services or touches tunnels.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Verify')][string]$Mode='Inspect',
 [switch]$IncludeDpapi
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
$node='C:\Program Files\nodejs\node.exe'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_REQUIRED'}
if(!(Test-Path -LiteralPath $node -PathType Leaf)){throw 'NODE_NOT_INSTALLED_AT_TRUSTED_PATH'}
$syntax=@(
 'tools/powershell-direct/service.mjs',
 'tools/powershell-direct/stack-supervisor.mjs',
 'tools/powershell-direct/approval-bootstrap.mjs',
 'tools/ai_collaboration/engineering-plan.mjs',
 'tools/ai_collaboration/engineering-runner.mjs',
 'tools/ai_collaboration/engineering-mcp.mjs',
 'tools/ai_collaboration/local_job_service.mjs'
)
$tests=@(
 'tools/powershell-direct/tests/engineering.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/local_mcp_dispatch.test.mjs'
)
foreach($item in @($syntax+$tests)){
 if(!(Test-Path -LiteralPath (Join-Path $root $item) -PathType Leaf)){
  throw ('RELEASE_FILE_MISSING: '+$item)
 }
}
if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Result='ENGINEERING_MCP_RC1_INSPECT_PASS'
  Root=$root
  SyntaxModules=$syntax.Count
  TestFiles=$tests.Count
  ProductionChanged=$false
  TestsExecuted=$false
 }|ConvertTo-Json -Compress
 return
}
foreach($item in $syntax){
 & $node --check (Join-Path $root $item)
 if($LASTEXITCODE -ne 0){throw ('RC1_SYNTAX_FAILED: '+$item)}
}
Push-Location $root
try{
 & $node --test @tests
 if($LASTEXITCODE -ne 0){throw 'RC1_NODE_TESTS_FAILED'}
 if($IncludeDpapi){
  $dpapi=Join-Path $root 'tools\powershell-direct\tests\Test-ApprovalBootstrap.ps1'
  if(!(Test-Path -LiteralPath $dpapi -PathType Leaf)){throw 'RC1_DPAPI_TEST_MISSING'}
  & powershell.exe -NoProfile -NonInteractive -File $dpapi
  if($LASTEXITCODE -ne 0){throw 'RC1_DPAPI_TEST_FAILED'}
 }
}finally{Pop-Location}
[pscustomobject]@{
 Result='ENGINEERING_MCP_RC1_VERIFY_PASS'
 Root=$root
 SyntaxModules=$syntax.Count
 TestFiles=$tests.Count
 DpapiExecuted=[bool]$IncludeDpapi
 ProductionChanged=$false
}|ConvertTo-Json -Compress
