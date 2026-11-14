# Read-only PID/port ownership probe; never outputs full command lines or secrets.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateRange(1024,65535)][int]$Port,
  [Parameter(Mandatory)][string]$Executable,
  [Parameter(Mandatory)][string]$ScriptPath
)
$ErrorActionPreference='Stop'
try {
  $expectedExe=[IO.Path]::GetFullPath($Executable)
  $expectedScript=[IO.Path]::GetFullPath($ScriptPath)
  $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  $matchingProcess=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.ExecutablePath -ieq $expectedExe -and $_.CommandLine -and $_.CommandLine.Contains($expectedScript)
  })
  $state='unknown'
  if($listeners.Count -eq 0) {
    if($matchingProcess.Count -eq 0) { $state='stopped' } else { $state='unhealthy' }
  } elseif($listeners.Count -ne 1) {
    $state='occupied'
  } else {
    $owner=[int]$listeners[0].OwningProcess
    if(@($matchingProcess | Where-Object {$_.ProcessId -eq $owner}).Count -eq 1) {
      $state='healthy'
    } else { $state='occupied' }
  }
  [PSCustomObject]@{State=$state;Port=$Port} | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{State='unknown';Port=$Port} | ConvertTo-Json -Compress
}
