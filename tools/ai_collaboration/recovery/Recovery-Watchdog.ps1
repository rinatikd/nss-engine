# Bounded post-logon recovery pass. The same idempotent local recovery
# command is used for each attempt. Do not kill or overwrite running services.
[CmdletBinding()]
param(
  [ValidateRange(1,6)][int]$Attempts=4,
  [ValidateRange(10,60)][int]$IntervalSeconds=20
)
$ErrorActionPreference='Stop'
$script=Join-Path $PSScriptRoot 'Restore-LocalStack.ps1'
if(!(Test-Path -LiteralPath $script -PathType Leaf)){throw 'RECOVERY_SCRIPT_MISSING'}
$folder=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$log=Join-Path $folder 'recovery-status.jsonl'
for($i=1;$i -le $Attempts;$i++){
  try {
    $result=(& $script -Mode Restore | Out-String).Trim()
    # The child script emits only service IDs, states and port numbers.
    $report=$result|ConvertFrom-Json -ErrorAction Stop
    $safe=[PSCustomObject]@{
      time=(Get-Date).ToUniversalTime().ToString('o')
      attempt=$i
      servers=@($report.Servers|ForEach-Object {
        [PSCustomObject]@{id=$_.Service;status=$_.Outcome}
      })
      connections=@($report.Connections|ForEach-Object {
        [PSCustomObject]@{id=$_.Service;status=$_.Outcome}
      })
    }
    $line=$safe|ConvertTo-Json -Depth 6 -Compress
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    # A blocked/unknown process, missing secret, or already-running tunnel is
    # not a transient startup race. NEVER retry automatic dispatch in that case.
    # Remote MCP health must be checked separately; a listening PID is not E2E.
    $allStatuses=@($safe.servers)+@($safe.connections)
    $unsafe=@($allStatuses | Where-Object {
      [string]$_.status -match '^(BLOCKED|START_UNKNOWN|START_UNCONFIRMED)'
    })
    if($unsafe.Count -gt 0){break}
    # Exactly one startup pass is sufficient. Any later verification must be
    # read-only, outside this runner, to avoid duplicate tunnel launches.
    break
  } catch {
    $safe=[PSCustomObject]@{time=(Get-Date).ToUniversalTime().ToString('o');
      attempt=$i;status='RECOVERY_ATTEMPT_FAILED'}
    Add-Content -LiteralPath $log -Value ($safe|ConvertTo-Json -Compress) -Encoding UTF8
  }
  if($i -lt $Attempts){Start-Sleep -Seconds $IntervalSeconds}
}
Write-Host 'RECOVERY_WATCHDOG_FINISHED'
