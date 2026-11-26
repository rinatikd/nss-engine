#requires -Version 5.1
<#
Single-console launcher for isolated PowerShell Direct + stdio tunnel.
Check is non-mutating. Cutover explicitly stops ONLY verified 17486 service and
18086 powershell-direct-work client, never 17487/17381/17382 or other profiles.
No tokens are written to disk or echoed.
#>
[CmdletBinding()]
param(
 [ValidateSet('Check','Cutover')][string]$Mode='Check',
 [string]$WorkspaceRoot='C:/Engineering',
 [string]$TunnelClient='C:/Engineering/chrome-bridge/codex-handoff-output/direct-cli-v21/runtime/tunnel-client.exe'
)
$ErrorActionPreference='Stop'
$here=Split-Path -Parent $MyInvocation.MyCommand.Path
$node=(Get-Command node.exe -ErrorAction Stop).Source
$supervisor=Join-Path $here 'stack-supervisor.mjs'
if(-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)){throw 'WORKSPACE_ROOT_NOT_FOUND'}
if(-not (Test-Path -LiteralPath $TunnelClient -PathType Leaf)){throw 'TUNNEL_CLIENT_NOT_FOUND'}
if(-not (Test-Path -LiteralPath $supervisor -PathType Leaf)){throw 'STACK_SUPERVISOR_NOT_FOUND'}
& $node --check $supervisor
if($LASTEXITCODE -ne 0){throw 'SUPERVISOR_SYNTAX_CHECK_FAILED'}
& $node --test (Join-Path $here 'tests/service.test.mjs')
if($LASTEXITCODE -ne 0){throw 'UNIT_TESTS_FAILED'}

$expected=@{
  17486=@{Name='node.exe';Match='*powershell-direct*service.mjs*'};
  18086=@{Name='tunnel-client.exe';Match='*run*--profile powershell-direct-work*'}
}
$observed=@()
foreach($port in @(17486,18086)){
 $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
 if($listeners.Count -gt 1){throw ('MULTIPLE_LISTENERS_'+$port)}
 foreach($listener in $listeners){
   $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
   if(-not $proc -or $proc.Name -ne $expected[$port].Name -or $proc.CommandLine -notlike $expected[$port].Match){
     throw ('UNRECOGNIZED_PORT_OWNER_'+$port)
   }
   $observed+= [pscustomobject]@{Port=$port;PID=[int]$proc.ProcessId;Name=$proc.Name}
 }
}
$observed | Format-Table -AutoSize
Write-Host 'PREFLIGHT_PASS. Ports 17487 and 17381/17382 were not touched.'
if($Mode -eq 'Check'){Write-Host 'CHECK_ONLY; to replace the verified stack use -Mode Cutover.';return}

# Capture the existing runtime key before stopping the old instance.
if([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)){
  $secure=Read-Host 'Enter CONTROL_PLANE_API_KEY (hidden)' -AsSecureString
  $env:CONTROL_PLANE_API_KEY=[System.Net.NetworkCredential]::new('', $secure).Password
  Remove-Variable secure -ErrorAction SilentlyContinue
}
if([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)){throw 'RUNTIME_KEY_REQUIRED'}

# Re-check all owners, to avoid PID reuse or replacing the wrong profile.
foreach($entry in $observed){
 $conn=Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $entry.Port -State Listen -ErrorAction Stop
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.PID)"
 if($conn.OwningProcess -ne $entry.PID -or -not $p -or
    $p.Name -ne $expected[$entry.Port].Name -or $p.CommandLine -notlike $expected[$entry.Port].Match){
   throw ('OWNER_CHANGED_'+$entry.Port)
 }
}
foreach($entry in $observed){
 Stop-Process -Id $entry.PID -ErrorAction Stop
 Write-Host ('STOPPED_VERIFIED_PORT_'+$entry.Port)
}
$env:PS_DIRECT_ALLOWED_ROOT=(Resolve-Path -LiteralPath $WorkspaceRoot).Path
$env:PS_DIRECT_TUNNEL_CLIENT=(Resolve-Path -LiteralPath $TunnelClient).Path
try{
  Write-Host 'Starting supervised service and tunnel in this one window...'
  & $node $supervisor
  if($LASTEXITCODE -ne 0){throw ('STACK_EXIT_'+$LASTEXITCODE)}
}finally{
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PS_DIRECT_ALLOWED_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:PS_DIRECT_TUNNEL_CLIENT -ErrorAction SilentlyContinue
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}
