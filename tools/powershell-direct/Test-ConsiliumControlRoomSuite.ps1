# Run the local Consilium Control Room source regression suite against synthetic fixtures only.
# No live Control Room process, provider accounts, Bridge state or real credentials are touched.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$candidateRoot=Join-Path $workspaceExpected 'work\ChromeBridge-PR145-754b8f5f-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
$consiliumRoot=Join-Path $candidateRoot 'consilium-control-room'
$nodeExe='C:\Program Files\nodejs\node.exe'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
. (Join-Path $candidateRoot 'deployment\process-identity.ps1')
if(!(Test-Path -LiteralPath $consiliumRoot -PathType Container)){throw 'CONSILIUM_CONTROL_ROOM_SOURCE_ROOT_MISSING'}
if(!(Test-Path -LiteralPath $nodeExe -PathType Leaf)){throw 'PINNED_NODE_EXECUTABLE_MISSING'}
$sourceRoot=Join-Path $consiliumRoot 'consilium'
$testRoot=Join-Path $consiliumRoot 'tests'
$smokeScript=Join-Path $consiliumRoot 'deployment\consilium-lab-smoke.mjs'
foreach($file in @(
  (Join-Path $sourceRoot 'control-room.mjs'),
  (Join-Path $sourceRoot 'event-ledger.mjs'),
  (Join-Path $sourceRoot 'web\app.js'),
  (Join-Path $testRoot 'chrome-bridge-provider-adapter.test.mjs'),
  (Join-Path $testRoot 'consilium-control-room.test.mjs'),
  (Join-Path $testRoot 'consilium-event-ledger.test.mjs'),
  (Join-Path $testRoot 'provider-transport.test.mjs'),
  $smokeScript
)){
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw ('CONSILIUM_TEST_INPUT_MISSING: '+$file)}
}
function ListenerSignature([int]$Port){
  return ((@([BridgeNativeMetadata]::Listeners($Port)|Sort-Object)) -join ';')
}
function RunNode([string[]]$Arguments,[string]$WorkingDirectory,[int]$TimeoutMs=120000){
  $quoted=@($Arguments|ForEach-Object {'"'+([string]$_).Replace('"','\"')+'"'})
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName=$nodeExe
  $psi.Arguments=[string]::Join(' ',$quoted)
  $psi.WorkingDirectory=$WorkingDirectory
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $proc=New-Object Diagnostics.Process
  $proc.StartInfo=$psi
  try{
    if(!$proc.Start()){throw 'NODE_PROCESS_START_FAILED'}
    $outTask=$proc.StandardOutput.ReadToEndAsync()
    $errTask=$proc.StandardError.ReadToEndAsync()
    if(!$proc.WaitForExit($TimeoutMs)){
      try{$proc.Kill();$null=$proc.WaitForExit(3000)}catch{}
      throw 'NODE_TEST_TIMEOUT'
    }
    return [pscustomobject]@{
      ExitCode=$proc.ExitCode
      Stdout=[string]$outTask.GetAwaiter().GetResult()
      Stderr=[string]$errTask.GetAwaiter().GetResult()
    }
  }finally{$proc.Dispose()}
}
$version=RunNode @('--version') $consiliumRoot 10000
if($version.ExitCode -ne 0){throw ('NODE_VERSION_FAILED: '+$version.Stderr)}
$portBefore=ListenerSignature 18765
$syntaxFiles=@(
  (Join-Path $sourceRoot 'event-ledger.mjs'),
  (Join-Path $sourceRoot 'control-room.mjs'),
  (Join-Path $sourceRoot 'web\app.js')
)
foreach($file in $syntaxFiles){
  $check=RunNode @('--check',$file) $consiliumRoot 15000
  if($check.ExitCode -ne 0){throw ('CONSILIUM_SYNTAX_FAILED: '+$file+'; '+$check.Stderr)}
}
$testFiles=@(Get-ChildItem -LiteralPath $testRoot -Filter '*.test.mjs' -File -Force|ForEach-Object {$_.FullName})
if($testFiles.Count -lt 4){throw ('CONSILIUM_TEST_FILE_COUNT_LOW: '+$testFiles.Count)}
$nodeTestArguments=@('--test')+$testFiles
$tests=RunNode $nodeTestArguments $consiliumRoot 180000
if($smoke.ExitCode -ne 0){
  [pscustomobject]@{
    Result='CONSILIUM_CONTROL_ROOM_SMOKE_FAILED'
    NodeVersion=$version.Stdout.Trim()
    SyntaxFilesChecked=$syntaxFiles.Count
    TestFiles=$testFiles.Count
    TestExitCode=$tests.ExitCode
    SmokeExitCode=$smoke.ExitCode
    SmokeOutput=$smokeOutput
    ControlRoomPortUnchanged=($portAfter -ceq $portBefore)
  }|ConvertTo-Json -Depth 4
  exit $smoke.ExitCode
}
if($tests.ExitCode -ne 0){throw ('CONSILIUM_NODE_TESTS_FAILED: '+$tests.Stderr)}
$smoke=RunNode @($smokeScript) $consiliumRoot 60000
$portAfter=ListenerSignature 18765
if($portAfter -cne $portBefore){throw 'CONTROL_ROOM_PORT_18765_CHANGED_DURING_TESTS'}
$testOutput=$tests.Stdout+$tests.Stderr
$smokeOutput=$smoke.Stdout+$smoke.Stderr
if($smokeOutput.Length -gt 3000){$smokeOutput=$smokeOutput.Substring($smokeOutput.Length-3000)}
if($testOutput.Length -gt 12000){$testOutput=$testOutput.Substring($testOutput.Length-12000)}
if($tests.ExitCode -ne 0){
  [pscustomobject]@{
    Result='CONSILIUM_CONTROL_ROOM_TESTS_FAILED'
    NodeVersion=$version.Stdout.Trim()
    SyntaxFilesChecked=$syntaxFiles.Count
    TestFiles=$testFiles.Count
    TestExitCode=$tests.ExitCode
    TestOutputTail=$testOutput
    ControlRoomPortUnchanged=$true
  }|ConvertTo-Json -Depth 4
  exit $tests.ExitCode
}
[pscustomobject]@{
  Result='CONSILIUM_CONTROL_ROOM_TESTS_PASS'
  NodeVersion=$version.Stdout.Trim()
  SyntaxFilesChecked=$syntaxFiles.Count
  TestFiles=$testFiles.Count
  TestExitCode=0
  TestOutputTail=$testOutput
  SmokeOutput=$smokeOutput
  SmokeExitCode=$smoke.ExitCode
  ControlRoomPort18765Unchanged=$true
  LiveProvidersTouched=$false
  RealTokensUsed=$false
  PersistentLabStateChanged=$false
}|ConvertTo-Json -Depth 4
