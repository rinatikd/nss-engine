# Authenticated, read-only MCP diagnostics for PR102 provider adapters.
# Calls tools/list, agent_list and agent_selftest only; no drafts, sends, grants or provider mutations.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$candidateRoot=Join-Path $workspaceExpected 'work\ChromeBridge-PR145-754b8f5f-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
$root='C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20'
$state='C:\Engineering\ChromeBridge-PR102-17484-State'
$configExpectedSha='cb3bc9bc5ff43559e36185ac130eed56828beac4f27634439476d95f8b33b61b'
$extensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'
$port=17485
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
. (Join-Path $candidateRoot 'deployment\process-identity.ps1')
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function FullPath([string]$Path){Get-BridgeCanonicalPath $Path}
function HashFile([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}

$configPath=Join-Path $state 'config.json'
Require (Test-Path -LiteralPath $configPath -PathType Leaf) 'PR102_CONFIG_MISSING'
$configHash=HashFile $configPath
Require ($configHash -ceq $configExpectedSha) 'PR102_CONFIG_HASH_MISMATCH'
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
Require ($config.agentToken -is [string] -and $config.agentToken.Length -ge 32) 'PR102_AGENT_TOKEN_INVALID'

$listeners=@([BridgeNativeMetadata]::Listeners($port))
Require ($listeners.Count -eq 1) ('PR102_LISTENER_COUNT_MISMATCH: '+$listeners.Count)
$parts=([string]$listeners[0]).Split('|')
Require ($parts.Count -eq 2 -and $parts[0] -ceq '127.0.0.1') 'PR102_LISTENER_NOT_LOOPBACK'
$pidValue=0
Require ([int]::TryParse($parts[1],[ref]$pidValue) -and $pidValue -gt 0) 'PR102_PID_INVALID'
$process=[Diagnostics.Process]::GetProcessById($pidValue)
try{
  $identity=Get-BridgeHandleIdentity $process
  Require ((FullPath ([string]$identity.workingDirectory)) -ieq (FullPath $root)) 'PR102_WORKDIR_MISMATCH'
  Require ((FullPath ([string]$identity.bridgeHome)) -ieq (FullPath $state)) 'PR102_STATE_ROOT_MISMATCH'
  Require ([string]$identity.bridgePort -ceq [string]$port) 'PR102_PORT_ENV_MISMATCH'
  Require ([string]$identity.extensionId -ceq $extensionId) 'PR102_EXTENSION_ID_MISMATCH'
}finally{$process.Dispose()}

$uri='http://127.0.0.1:17485/mcp'
$headers=@{Authorization=('Bearer '+$config.agentToken);Accept='application/json'}
function InvokeMcp([object]$Payload,[int]$TimeoutSec=40){
  $body=$Payload|ConvertTo-Json -Depth 20 -Compress
  try{
    $response=Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec $TimeoutSec
  }catch{
    $detail=$_.Exception.Message
    if($_.Exception.Response){try{$detail+='; HTTP '+[int]$_.Exception.Response.StatusCode}catch{}}
    throw ('PR102_MCP_HTTP_FAILED: '+$detail)
  }
  $raw=[string]$response.Content
  if([string]::IsNullOrWhiteSpace($raw)){return $null}
  if($raw -match '(?m)^data:\s*(\{.*\})\s*$'){$raw=$Matches[1]}
  try{return ($raw|ConvertFrom-Json)}catch{throw 'PR102_MCP_RESPONSE_NOT_JSON'}
}
function ExtractText($Response){
  if(!$Response -or !$Response.result){return ''}
  return (@($Response.result.content|ForEach-Object {[string]$_.text}) -join [Environment]::NewLine)
}
function ParseSelfTest([string]$Name,$Response){
  $text=ExtractText $Response
  $data=$null
  try{$data=$text|ConvertFrom-Json}catch{}
  if($null -eq $data){
    return [pscustomobject]@{Name=$Name;Status='ERROR';Error=$text;ComposerVisible=0;SendVisible=0;ReplyVisible=0}
  }
  return [pscustomobject]@{
    Name=$Name
    Status=if($Response.result.isError){'TOOL_ERROR'}else{'PASS'}
    ComposerMatched=[int]$data.composer.matched
    ComposerVisible=[int]$data.composer.visible
    ComposerSelector=[string]$data.composer.selector
    SendMatched=[int]$data.send.matched
    SendVisible=[int]$data.send.visible
    SendSelector=[string]$data.send.selector
    StopVisible=[int]$data.stop.visible
    ReplyVisible=[int]$data.reply.visible
    InputMetadata=@($data.diagnostics.inputMetadata)
    NearInputButtons=@($data.diagnostics.nearInputButtons)
    SendCandidates=$data.diagnostics.sendCandidates
    Error=if($Response.result.isError){$text}else{''}
  }
}

$initialize=InvokeMcp ([ordered]@{
 jsonrpc='2.0';id=1;method='initialize';
 params=@{protocolVersion='2025-06-18';capabilities=@{};clientInfo=@{name='pr102-readonly-adapter-probe';version='1.0.0'}}
})
Require ($initialize -and $initialize.result) 'PR102_MCP_INITIALIZE_FAILED'
$null=InvokeMcp ([ordered]@{jsonrpc='2.0';method='notifications/initialized';params=@{}})
$toolsResponse=InvokeMcp ([ordered]@{jsonrpc='2.0';id=2;method='tools/list';params=@{}})
Require ($toolsResponse -and $toolsResponse.result.tools) 'PR102_TOOLS_LIST_FAILED'
$toolNames=@($toolsResponse.result.tools|ForEach-Object {[string]$_.name})
Require ($toolNames -contains 'agent_selftest') 'PR102_AGENT_SELFTEST_TOOL_MISSING'
$agentResponse=InvokeMcp ([ordered]@{jsonrpc='2.0';id=3;method='tools/call';params=@{name='agent_list';arguments=@{}}})
$agentText=ExtractText $agentResponse
$agentList=$null
try{$agentList=$agentText|ConvertFrom-Json}catch{}
Require ($null -ne $agentList) 'PR102_AGENT_LIST_NOT_JSON'

$results=@()
foreach($name in @('claude','gemini','deepseek','grok','qwen','kimi')){
  try{
    $response=InvokeMcp ([ordered]@{jsonrpc='2.0';id=(10+$results.Count);method='tools/call';params=@{name='agent_selftest';arguments=@{name=$name}}})
    $results += ParseSelfTest $name $response
  }catch{
    $results += [pscustomobject]@{Name=$name;Status='ERROR';Error=$_.Exception.Message}
  }
}
Require ((HashFile $configPath) -ceq $configHash) 'PR102_CONFIG_CHANGED_DURING_PROBE'
$finalListeners=@([BridgeNativeMetadata]::Listeners($port))
Require ($finalListeners.Count -eq 1 -and [string]$finalListeners[0] -ceq [string]$listeners[0]) 'PR102_LISTENER_CHANGED_DURING_PROBE'

[pscustomobject]@{
  Result='PR102_AGENT_ADAPTER_DIAGNOSTICS_READ_ONLY'
  Port=$port
  ProcessId=$pidValue
  ServerVersion=if($initialize.result.serverInfo){[string]$initialize.result.serverInfo.version}else{''}
  ToolCount=$toolNames.Count
  AgentBindings=@($agentList.bound|ForEach-Object {[pscustomobject]@{Name=[string]$_.name;Alive=[bool]$_.alive;TabId=$_.tabId}})
  VisibleChatTabCount=@($agentList.chatTabs).Count
  Selftests=$results
  ConfigUnchanged=$true
  ListenerUnchanged=$true
  MessagesSent=0
  GrantsChanged=$false
}|ConvertTo-Json -Depth 9
