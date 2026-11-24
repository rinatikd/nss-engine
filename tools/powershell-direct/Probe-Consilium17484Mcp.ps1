# Authenticated, read-only MCP health probe for the live Consilium Bridge on 17484.
# Uses agentToken only in-memory; never emits credentials or sends provider/browser mutations.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$candidateRoot=Join-Path $workspaceExpected 'work\ChromeBridge-PR145-754b8f5f-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
$root='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0'
$state='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0-State'
$expectedConfigSha='cb3bc9bc5ff43559e36185ac130eed56828beac4f27634439476d95f8b33b61b'
$extensionId='ojkfdjndmcpnphecoadbcnmlnadmmkah'
$port=17484
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
. (Join-Path $candidateRoot 'deployment\process-identity.ps1')
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function FullPath([string]$Path){Get-BridgeCanonicalPath $Path}
function HashFile([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}

$configPath=Join-Path $state 'config.json'
Require (Test-Path -LiteralPath $configPath -PathType Leaf) 'CONSILIUM_CONFIG_MISSING'
$configHash=HashFile $configPath
Require ($configHash -ceq $expectedConfigSha) 'CONSILIUM_CONFIG_HASH_MISMATCH'
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
Require ($config.agentToken -is [string] -and $config.agentToken.Length -ge 32) 'CONSILIUM_AGENT_TOKEN_INVALID'
Require ($config.browserToken -is [string] -and $config.browserToken.Length -ge 32) 'CONSILIUM_BROWSER_TOKEN_INVALID'

$listeners=@([BridgeNativeMetadata]::Listeners($port))
Require ($listeners.Count -eq 1) ('CONSILIUM_LISTENER_COUNT_MISMATCH: '+$listeners.Count)
$parts=([string]$listeners[0]).Split('|')
Require ($parts.Count -eq 2 -and $parts[0] -ceq '127.0.0.1') 'CONSILIUM_LISTENER_NOT_LOOPBACK'
$pidValue=0
Require ([int]::TryParse($parts[1],[ref]$pidValue) -and $pidValue -gt 0) 'CONSILIUM_PID_INVALID'
$process=[Diagnostics.Process]::GetProcessById($pidValue)
try{
  $identity=Get-BridgeHandleIdentity $process
  Require ((FullPath ([string]$identity.workingDirectory)) -ieq (FullPath $root)) 'CONSILIUM_WORKDIR_MISMATCH'
  Require ((FullPath ([string]$identity.bridgeHome)) -ieq (FullPath $state)) 'CONSILIUM_STATE_ROOT_MISMATCH'
  Require ([string]$identity.bridgePort -ceq [string]$port) 'CONSILIUM_PORT_ENV_MISMATCH'
  Require ([string]$identity.extensionId -ceq $extensionId) 'CONSILIUM_EXTENSION_ID_MISMATCH'
  $created=[string]$identity.created
}finally{$process.Dispose()}

$uri='http://127.0.0.1:17484/mcp'
$headers=@{Authorization=('Bearer '+$config.agentToken);Accept='application/json'}
function InvokeMcp([object]$Payload){
  $body=$Payload|ConvertTo-Json -Depth 20 -Compress
  try{
    $response=Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 20
  }catch{
    $detail=$_.Exception.Message
    if($_.Exception.Response){
      try{$detail+='; HTTP '+[int]$_.Exception.Response.StatusCode}catch{}
    }
    throw ('CONSILIUM_MCP_HTTP_FAILED: '+$detail)
  }
  $raw=[string]$response.Content
  if($response.StatusCode -lt 200 -or $response.StatusCode -ge 300){throw ('CONSILIUM_MCP_HTTP_STATUS: '+$response.StatusCode)}
  if([string]::IsNullOrWhiteSpace($raw)){return $null}
  if($raw -match '(?m)^data:\s*(\{.*\})\s*$'){$raw=$Matches[1]}
  try{return ($raw|ConvertFrom-Json)}catch{throw ('CONSILIUM_MCP_RESPONSE_NOT_JSON: '+$response.Headers['Content-Type'])}
}

$initialize=InvokeMcp ([ordered]@{
  jsonrpc='2.0'
  id=1
  method='initialize'
  params=@{
    protocolVersion='2025-06-18'
    capabilities=@{}
    clientInfo=@{name='consilium-readonly-health-probe';version='1.0.0'}
  }
})
Require ($initialize -and $initialize.result) 'CONSILIUM_MCP_INITIALIZE_INVALID'
$serverInfo=$initialize.result.serverInfo
$protocol=[string]$initialize.result.protocolVersion

$null=InvokeMcp ([ordered]@{jsonrpc='2.0';method='notifications/initialized';params=@{}})
$toolsResponse=InvokeMcp ([ordered]@{jsonrpc='2.0';id=2;method='tools/list';params=@{}})
Require ($toolsResponse -and $toolsResponse.result -and $toolsResponse.result.tools) 'CONSILIUM_MCP_TOOLS_LIST_INVALID'
$tools=@($toolsResponse.result.tools)
$toolNames=@($tools|ForEach-Object {[string]$_.name})
$uniqueNames=@($toolNames|Sort-Object -Unique)
Require ($toolNames.Count -eq $uniqueNames.Count) 'CONSILIUM_MCP_DUPLICATE_TOOL_NAMES'
Require ($toolNames -contains 'browser_status') 'CONSILIUM_BROWSER_STATUS_TOOL_MISSING'

$statusResponse=InvokeMcp ([ordered]@{
  jsonrpc='2.0'
  id=3
  method='tools/call'
  params=@{name='browser_status';arguments=@{}}
})
Require ($statusResponse -and $statusResponse.result) 'CONSILIUM_BROWSER_STATUS_RESPONSE_INVALID'
$statusText=@($statusResponse.result.content|ForEach-Object {[string]$_.text}) -join [Environment]::NewLine
$browserStatus=$null
try{$browserStatus=$statusText|ConvertFrom-Json}catch{}
Require ($null -ne $browserStatus) 'CONSILIUM_BROWSER_STATUS_NOT_JSON'

Require ((HashFile $configPath) -ceq $configHash) 'CONSILIUM_CONFIG_CHANGED_DURING_MCP_PROBE'
$finalListeners=@([BridgeNativeMetadata]::Listeners($port))
Require ($finalListeners.Count -eq 1 -and [string]$finalListeners[0] -ceq [string]$listeners[0]) 'CONSILIUM_LISTENER_CHANGED_DURING_MCP_PROBE'

[pscustomobject]@{
  Result='CONSILIUM_MCP_READ_ONLY_PROBE_PASS'
  Listener='127.0.0.1:17484'
  ProcessId=$pidValue
  ProcessCreatedUtc=$created
  ServerName=if($serverInfo){[string]$serverInfo.name}else{''}
  ServerVersion=if($serverInfo){[string]$serverInfo.version}else{''}
  ProtocolVersion=$protocol
  ToolCount=$toolNames.Count
  ToolNames=$toolNames
  BrowserConnected=[bool]$browserStatus.connected
  Queued=[int]$browserStatus.queued
  AgentCount=@($browserStatus.agents).Count
  AgentNames=@($browserStatus.agents|ForEach-Object {[string]$_.name})
  ConfigSha256=$configHash
  ConfigUnchanged=$true
  ListenerUnchanged=$true
}|ConvertTo-Json -Depth 6
