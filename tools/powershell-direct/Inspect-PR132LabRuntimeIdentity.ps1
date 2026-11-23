# Read-only PR102 Lab runtime identity report. Never emits config/token values.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$labRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$labPort=17484
$candidateRoot='C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\ChromeBridge-PR132-42ccb6de-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
if(!(Test-Path -LiteralPath $labRoot -PathType Container)){throw 'LAB_ROOT_NOT_FOUND'}
. (Join-Path $candidateRoot 'deployment\process-identity.ps1')
$listeners=@([BridgeNativeMetadata]::Listeners($labPort))
if($listeners.Count -ne 1){throw ('LAB_LISTENER_COUNT_MISMATCH: '+$listeners.Count)}
$parts=([string]$listeners[0]).Split('|')
if($parts.Count -ne 2 -or $parts[0] -cne '127.0.0.1'){throw 'LAB_LISTENER_ADDRESS_MISMATCH'}
$pidValue=0
if(![int]::TryParse($parts[1],[ref]$pidValue)){throw 'LAB_LISTENER_PID_INVALID'}
$proc=[Diagnostics.Process]::GetProcessById($pidValue)
try{$identity=Get-BridgeHandleIdentity $proc}finally{$proc.Dispose()}
$command=[string]$identity.command
$safeCommand=$command
$safeCommand=[regex]::Replace($safeCommand,'(?i)(bearer\s+)[A-Za-z0-9._~+/-]{16,}','$1[REDACTED]')
$safeCommand=[regex]::Replace($safeCommand,'(?i)((?:token|secret|password|api[_-]?key)(?:\s+|=|:))("[^"]+"|\S+)','$1[REDACTED]')
$safeCommand=[regex]::Replace($safeCommand,'(?i)\b(?:[a-f0-9]{40,}|[A-Za-z0-9_-]{48,})\b','[REDACTED]')
if($safeCommand.Length -gt 1200){$safeCommand=$safeCommand.Substring(0,1200)+'...[TRUNCATED]'}
$bridgePath=(Join-Path $labRoot 'server\bridge.mjs')
$configReports=@()
$configFiles=@(Get-ChildItem -LiteralPath $labRoot -Filter 'config.json' -File -Recurse -Force -ErrorAction Stop)
foreach($file in $configFiles){
  try{
    $cfg=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json
    $relative=$file.FullName.Substring($labRoot.Length).TrimStart('\')
    $configReports += [pscustomobject]@{
      RelativePath=$relative
      Sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      AgentTokenLength=if($cfg.agentToken -is [string]){$cfg.agentToken.Length}else{0}
      BrowserTokenLength=if($cfg.browserToken -is [string]){$cfg.browserToken.Length}else{0}
      HasExtensionId=($null -ne $cfg.PSObject.Properties['extensionId'])
      ExtensionIdMatches=([string]$cfg.extensionId -ceq 'nhflbnfcaicihaepdcjacdmaddagcmcj')
      PropertyNames=@($cfg.PSObject.Properties.Name)
    }
  }catch{
    $relative=$file.FullName.Substring($labRoot.Length).TrimStart('\')
    $configReports += [pscustomobject]@{RelativePath=$relative;ParseError=$_.Exception.Message}
  }
}
$parent=$null
try{
  $ppid=(Get-CimInstance Win32_Process -Filter ("ProcessId="+$identity.id)).ParentProcessId
  $p=Get-Process -Id $ppid -ErrorAction Stop
  $parent=[pscustomobject]@{ProcessId=$ppid;Name=$p.ProcessName}
}catch{}
[pscustomobject]@{
  Result='PR102_LAB_RUNTIME_IDENTITY_READ_ONLY'
  Listener=$listeners[0]
  ProcessId=$identity.id
  ProcessCreatedUtc=$identity.created
  Executable=$identity.executable
  Parent=$parent
  CommandLength=$command.Length
  CommandSha256=( [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($command)) | ForEach-Object ToString x2 ) -join ''
  CommandHasLabBridge=($command.IndexOf($bridgePath,[StringComparison]::OrdinalIgnoreCase) -ge 0)
  CommandHasCutoverStart=($command -match '(?i)cutover-start\.mjs')
  CommandHasStartJob=($command -match '(?i)start-[0-9a-f]{32}\.json')
  CommandRedacted=$safeCommand
  ConfigFiles=$configReports
  ProductionPathsTouched=$false
  CredentialsPrinted=$false
}|ConvertTo-Json -Depth 8
