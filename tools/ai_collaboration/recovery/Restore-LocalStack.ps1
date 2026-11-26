# Windows-owned, bounded, idempotent recovery for verified local Node servers.
# Starts only enumerated PR102 lab, PowerShell Direct and their trusted tunnel profiles.
# Production is observation-only. Never kills processes or modifies tokens.
[CmdletBinding()]
param([ValidateSet('Status','Restore')][string]$Mode='Status')
$ErrorActionPreference='Stop'
$node='C:\Program Files\nodejs\node.exe'
$services=@(
  [PSCustomObject]@{
    Id='chrome-pr102-lab'
    Port=17485
    Script='C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20\server\bridge.mjs'
    StateDir='C:\Engineering\ChromeBridge-PR102-17485-State'
    ExtensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'
    Restorable=$true
  },
  [PSCustomObject]@{
    Id='chrome-rc1-lab'
    Port=17481
    Script='C:\Engineering\chrome-bridge-rc-final-clean\docs\chrome-bridge-handoff\chrome-bridge-v20\server\bridge.mjs'
    StateDir=''
    Restorable=$false
  },
  [PSCustomObject]@{
    Id='chrome-prod-server'
    Port=17381
    Script='C:\Engineering\chrome-bridge\server\bridge.mjs'
    StateDir=''
    Restorable=$false
  }
)
function Test-OwnedService([object]$s) {
  try {
    $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $s.Port -State Listen -ErrorAction SilentlyContinue)
    if($listeners.Count -gt 1) { return 'occupied' }
    if($listeners.Count -eq 1) {
      $pidValue=[int]$listeners[0].OwningProcess
      $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction Stop
      if($proc.Name -ieq 'node.exe' -and $proc.ExecutablePath -ieq $node -and
        $proc.CommandLine -and $proc.CommandLine.Contains($s.Script)) {
        return 'owned-listener'
      }
      return 'occupied'
    }
    $matches=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object {$_.ExecutablePath -ieq $node -and $_.CommandLine -and $_.CommandLine.Contains($s.Script)})
    if($matches.Count -gt 0) {return 'unhealthy'}
    return 'stopped'
  } catch {return 'unknown'}
}
if(!(Test-Path -LiteralPath $node -PathType Leaf)) {throw 'TRUSTED_NODE_MISSING'}
# A named mutex prevents simultaneous invocations by the scheduled task
# and an operator clicking Restore.
$mutex=New-Object System.Threading.Mutex($false,'Local\ChromeBridgeStackRecovery')
$acquired=$false
try {
  $acquired=$mutex.WaitOne(0)
  if(!$acquired){throw 'RECOVERY_ALREADY_RUNNING'}
  $results=@()
  foreach($s in $services) {
    $before=Test-OwnedService $s
    $result='OBSERVED_ONLY'
    if($Mode -eq 'Restore' -and $s.Restorable) {
      if($before -eq 'owned-listener') { $result='ALREADY_LISTENING' }
      elseif($before -ne 'stopped') { $result='BLOCKED_'+$before.ToUpperInvariant() }
      elseif(!(Test-Path -LiteralPath $s.Script -PathType Leaf) -or
             !(Test-Path -LiteralPath "$($s.StateDir)\config.json" -PathType Leaf)) {
        $result='BLOCKED_MISSING_FILES'
      } else {
        # A brand-new isolated environment is constructed, rather than
        # inheriting a potentially stale CHROME_BRIDGE_EXTENSION_ID.
        $startInfo=New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName=$node
        $startInfo.Arguments='"'+$s.Script+'"'
        $startInfo.WorkingDirectory=Split-Path $s.Script -Parent
        $startInfo.UseShellExecute=$false
        $startInfo.CreateNoWindow=$true
        $startInfo.EnvironmentVariables['CHROME_BRIDGE_HOME']=$s.StateDir
        $startInfo.EnvironmentVariables['CHROME_BRIDGE_PORT']=[string]$s.Port
        if($s.ExtensionId){$startInfo.EnvironmentVariables['CHROME_BRIDGE_EXTENSION_ID']=$s.ExtensionId}
        [void]$startInfo.EnvironmentVariables.Remove('CONTROL_PLANE_API_KEY')
        [void]$startInfo.EnvironmentVariables.Remove('PS_DIRECT_AGENT_TOKEN')
        [void]$startInfo.EnvironmentVariables.Remove('PS_DIRECT_GATEWAY_TOKEN')
        # Revalidate immediately before the spawn. Port ownership can change.
        if((Test-OwnedService $s) -ne 'stopped') { $result='BLOCKED_RACE' }
        else {
          $child=[System.Diagnostics.Process]::Start($startInfo)
          if($null -eq $child){throw 'NODE_START_FAILED'}
          Start-Sleep -Seconds 2
          if((Test-OwnedService $s) -eq 'owned-listener') {
            $result='STARTED_OWNED_LISTENER'
          } else {
            $result='START_UNCONFIRMED'
          }
        }
      }
    }
    $results+=[PSCustomObject]@{Service=$s.Id;Port=$s.Port;Observed=$before;Outcome=$result}
  }
  # Recovery of the local supervisor and tunnel profiles is separated from
  # local Node listener startup; a listener alone is not a healthy MCP channel.
  $extra=@()
  $powerShellRecovery=Join-Path $PSScriptRoot 'Recover-PowerShellDirect.ps1'
  $pr102TunnelRecovery=Join-Path $PSScriptRoot 'Recover-LabTunnel.ps1'
  if(Test-Path -LiteralPath $powerShellRecovery -PathType Leaf){
    try {
      $raw=& $powerShellRecovery -Mode $Mode | Out-String
      $extra+=($raw | ConvertFrom-Json)
    }catch {
      $extra+=[PSCustomObject]@{Service='powershell-direct';Outcome='BLOCKED_OR_FAILED'}
    }
  }
  $labState=Test-OwnedService $services[0]
  if(Test-Path -LiteralPath $pr102TunnelRecovery -PathType Leaf){
    if($Mode -eq 'Restore' -and $labState -ne 'owned-listener'){
      $extra+=[PSCustomObject]@{Service='chrome-pr102-tunnel';Outcome='BLOCKED_LAB_NOT_RUNNING'}
    } else {
      try {
        $raw=& $pr102TunnelRecovery -Mode $Mode | Out-String
        $extra+=($raw | ConvertFrom-Json)
      }catch {
        $extra+=[PSCustomObject]@{Service='chrome-pr102-tunnel';Outcome='BLOCKED_OR_FAILED'}
      }
    }
  }
  [PSCustomObject]@{Mode=$Mode;Servers=$results;Connections=$extra} | ConvertTo-Json -Depth 5
} finally {
  if($acquired){$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
