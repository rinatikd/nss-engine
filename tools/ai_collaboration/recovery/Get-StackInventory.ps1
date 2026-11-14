# Read-only sanitized inventory. No command lines, tokens, file contents,
# URLs or environment variables leave the Windows host.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$ports=17381,17382,17481,17484,17486,18791
$nodes=@(foreach($port in $ports) {
  $entry=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  $owner=$null
  $exe='none'
  if($entry.Count -eq 1) {
    $owner=[int]$entry[0].OwningProcess
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    if($process){$exe=$process.Name}
  }
  [PSCustomObject]@{
    Port=$port
    ListenCount=$entry.Count
    PID=$owner
    Image=$exe
    Status=if($entry.Count -eq 0){'stopped'}elseif($entry.Count -eq 1){'listening'}else{'ambiguous'}
  }
})
$profiles=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" |
  ForEach-Object {
    $command=[string]$_.CommandLine
    $name='unknown'
    if($command.Contains('chatgpt-chrome-bridge-pr102.yaml')) {
      $name='chrome-pr102'
    } elseif($command.Contains('powershell-direct-work')) {
      $name='powershell-direct-work'
    } elseif($command.Contains('chatgpt-local-codex')) {
      $name='codex-associated'
    }
    [PSCustomObject]@{
      PID=$_.ProcessId
      ParentPID=$_.ParentProcessId
      ProfileCategory=$name
      Image=$_.Name
    }
  })
[PSCustomObject]@{
  CapturedAt=(Get-Date).ToUniversalTime().ToString('o')
  Ports=$nodes
  TunnelProcesses=$profiles
} | ConvertTo-Json -Depth 6
