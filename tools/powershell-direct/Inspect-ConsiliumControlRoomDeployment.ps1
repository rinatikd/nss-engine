# Read-only inventory of Consilium Control Room launch settings and listeners.
# Does not start the Control Room, open browser tabs or modify state.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$root='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
$controlRoot=Join-Path $root 'consilium\consilium'
$startScript=Join-Path $root 'consilium\scripts\start.ps1'
$readme=Join-Path $controlRoot 'README.md'
$main=Join-Path $controlRoot 'control-room.mjs'
foreach($file in @($controlRoot,$startScript,$readme,$main)){
  if(!(Test-Path -LiteralPath $file)){throw ('CONSILIUM_CONTROL_ROOM_SOURCE_MISSING: '+$file)}
}
$startContent=[IO.File]::ReadAllText($startScript)
$readmeHints=@(Select-String -LiteralPath $readme -Pattern 'CONSILIUM_PORT|18765|127\.0\.0\.1|localhost|loopback|токен|запуск' |
  ForEach-Object {[pscustomobject]@{Line=$_.LineNumber;Text=$_.Line.Trim()}})
$mainHints=@(Select-String -LiteralPath $main -Pattern 'CONSILIUM_PORT|18765|server\.listen|listen\(|127\.0\.0\.1|CONSILIUM_.*TOKEN' |
  ForEach-Object {[pscustomobject]@{Line=$_.LineNumber;Text=$_.Line.Trim()}})
$expectedPort=18765
$listeners=@([BridgeNativeMetadata]::Listeners($expectedPort))
$requiredVariables=@(
  'CONSILIUM_OWNER_TOKEN','CONSILIUM_CHATGPT_TOKEN','CONSILIUM_CLAUDE_TOKEN',
  'CONSILIUM_DEEPSEEK_TOKEN','CONSILIUM_QWEN_TOKEN','CONSILIUM_KIMI_TOKEN',
  'CONSILIUM_GROK_TOKEN','CONSILIUM_GEMINI_TOKEN'
)
$environmentPresence=@($requiredVariables|ForEach-Object {
  [pscustomobject]@{Name=$_;Present=[bool](Test-Path -LiteralPath ('Env:'+$_))}
})
$report=[ordered]@{
  Result='CONSILIUM_CONTROL_ROOM_DEPLOYMENT_READ_ONLY'
  ControlRoomRoot=$controlRoot
  SourceExists=$true
  StartScriptContent=$startContent
  ReadmeRelevantLines=$readmeHints
  ControlRoomListenAndTokenLines=$mainHints
  DefaultPort=$expectedPort
  DefaultPortListeners=$listeners
  RequiredTokenEnvironmentPresence=$environmentPresence
  NoFilesChanged=$true
  NoProcessesStarted=$true
}
$report|ConvertTo-Json -Depth 6
