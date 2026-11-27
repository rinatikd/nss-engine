# Human-facing one-click recovery. Only calls the checked release entrypoint.
# Does not require an administrator shell. Never displays tokens or paths.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$entry=Join-Path $PSScriptRoot 'Invoke-VerifiedRecovery.ps1'
$summary='Chrome Bridge recovery: status unknown'
try {
  $output=(& $entry -Mode Restore | Out-String).Trim()
  $result=$output | ConvertFrom-Json -ErrorAction Stop
  $services=@($result.Servers)+@($result.Connections)
  $rows=@(foreach($item in $services){
    $name=[string]$item.Service
    if($name -notmatch '^[a-zA-Z0-9_-]{3,50}$'){continue}
    $status=if($item.Outcome){[string]$item.Outcome}else{'STATUS_ONLY'}
    $status=$status -replace '[^a-zA-Z0-9_-]',''
    $name+': '+$status
  })
  $nl=[Environment]::NewLine
  $summary='Recovery checked at '+(Get-Date -Format 'HH:mm:ss')+$nl+$nl+
    ($rows -join $nl)+$nl+$nl+
    'Remote ChatGPT/MCP connections must be confirmed separately.'
} catch {
  $summary='Recovery could not be confirmed. Inspect local status logs; no unknown process was forcibly terminated.'
}
# Showing a Windows message is local-only; when the user is not logged in,
# the scheduled task uses Recovery-Watchdog and never invokes this UI.
try {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show(
    $summary,'Chrome Bridge recovery',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
} catch {
  Write-Output $summary
}
