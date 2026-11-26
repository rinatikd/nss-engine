# Read-only transport diagnostics. No credentials, environment or command lines are read.
# Does not start/stop processes, edit files, or change ports and tunnel.
[CmdletBinding()]
param(
  [int[]]$Ports = @(17381, 17382),
  [int]$TimeoutMs = 1200,
  [switch]$SkipHttp
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($TimeoutMs -lt 100 -or $TimeoutMs -gt 10000) { throw 'TimeoutMs must be within 100..10000' }
if ($Ports.Count -eq 0) { throw 'At least one port is required' }
foreach ($p in $Ports) { if ($p -lt 1 -or $p -gt 65535) { throw 'Port out of range' } }

Write-Output 'CHROME_BRIDGE_MCP_LINK_DIAGNOSTICS'
Write-Output '[SCOPE] Read-only loopback, no bearer tokens, no config, no request body, no process command lines'
foreach ($port in ($Ports | Select-Object -Unique)) {
  $listener = $null
  try {
    $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction Stop |
      Select-Object -First 1
  } catch { $listener = $null }

  if ($null -ne $listener) {
    $ownerName = 'unknown'
    try {
      $owner = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
      $ownerName = [string]$owner.ProcessName
    } catch { }
    Write-Output ("[LISTENER] port={0} state=LISTEN owner={1}" -f $port, $ownerName)
  } else {
    Write-Output ("[LISTENER] port={0} state=NOT_CONFIRMED" -f $port)
  }

  $client = New-Object System.Net.Sockets.TcpClient
  $connected = $false
  try {
    $connect = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    try { $connected = $connect.AsyncWaitHandle.WaitOne($TimeoutMs, $false) } finally { $connect.AsyncWaitHandle.Close() }
    if ($connected) { $client.EndConnect($connect); $connected = $client.Connected }
  } catch { $connected = $false }
  finally { $client.Close() }
  Write-Output ("[TCP] port={0} reachable={1}" -f $port, $connected.ToString().ToLowerInvariant())

  if (-not $connected -or $SkipHttp) { continue }
  # GET is deliberately used, never tools/call, and never sends an Authorization header.
  $uri = "http://127.0.0.1:$port/mcp"
  $req = [System.Net.HttpWebRequest]::Create($uri)
  $req.Method = 'GET'
  $req.Timeout = $TimeoutMs
  $req.ReadWriteTimeout = $TimeoutMs
  $req.AllowAutoRedirect = $false
  $req.KeepAlive = $false
  $req.Proxy = $null
  try {
    $res = [System.Net.HttpWebResponse]$req.GetResponse()
    try {
      Write-Output ("[HTTP] port={0} path=/mcp method=GET code={1}" -f $port, [int]$res.StatusCode)
    } finally { $res.Close() }
  } catch [System.Net.WebException] {
    $web = $_.Exception
    if ($web.Response -is [System.Net.HttpWebResponse]) {
      $res = [System.Net.HttpWebResponse]$web.Response
      try {
        Write-Output ("[HTTP] port={0} path=/mcp method=GET code={1}" -f $port, [int]$res.StatusCode)
      } finally { $res.Close() }
    } else {
      # Do not echo exception bodies, URLs, headers, or sensitive environment information.
      Write-Output ("[HTTP] port={0} path=/mcp result=NETWORK_ERROR category={1}" -f $port, $web.Status)
    }
  } catch {
    Write-Output ("[HTTP] port={0} path=/mcp result=UNEXPECTED_ERROR" -f $port)
  }
}
Write-Output '[INTERPRETATION] TCP reachable only proves a listener, not ChatGPT connector routing'
Write-Output '[INTERPRETATION] HTTP 401/403/405 can be normal fail-closed behavior for anonymous GET; HTTP 200 is not a successful authorized MCP test'
Write-Output '[INTERPRETATION] If both ports respond but ChatGPT tools fail, inspect app connector session/routing separately'
Write-Output '[DONE] No configuration changed'
