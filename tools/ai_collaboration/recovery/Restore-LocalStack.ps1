# Windows-owned, bounded, idempotent recovery for verified local Node servers.
# Only explicitly enumerated lab servers may start in this prototype.
# Production and tunnels: STATUS ONLY until independently reviewed.
# Does not stop/kill processes, modify tokens, start Chrome, or contact Internet.
[CmdletBinding()]
param([ValidateSet('Status','Restore')][string]$Mode='Status')
$ErrorActionPreference='Stop'
$node='C:\Program Files\nodejs\node.exe'
$services=@(
  [PSCustomObject]@{
    Id='chrome-pr102-lab'
    Port=17484
    Script='C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20\server\bridge.mjs'
    StateDir='C:\Engineering\ChromeBridge-PR102-17484-State'
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
        $startInfo.EnvironmentVariables.Remove('CHROME_BRIDGE_EXTENSION_ID')
        # Revalidate immediately before the spawn. Port ownership can change.
        if((Test-OwnedService $s) -ne 'stopped') { $result='BLOCKED_RACE' }
        else {
          $child=[System.Diagnostics.Process]::Start($startInfo)
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
  $results | ConvertTo-Json -Depth 4
} finally {
  if($acquired){$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
