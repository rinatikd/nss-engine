#requires -Version 5.1
<#
Local-only developer bootstrap. Does NOT alter production/PR102 services.
Run with -Check first. -Start explicitly opts into the new localhost server.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })][string]$WorkspaceRoot,
  [switch]$Start
)
$ErrorActionPreference='Stop'
$here=Split-Path -Parent $MyInvocation.MyCommand.Path
$node=(Get-Command node.exe -ErrorAction Stop).Source
$port=17486
$tcp=New-Object System.Net.Sockets.TcpClient
try {
  $connect=$tcp.BeginConnect('127.0.0.1',$port,$null,$null)
  if($connect.AsyncWaitHandle.WaitOne(400) -and $tcp.Connected) {
    throw "PORT_17486_ALREADY_OCCUPIED"
  }
} finally { $tcp.Close() }

Write-Host "Node:" (& $node --version)
Write-Host "Root:" (Resolve-Path -LiteralPath $WorkspaceRoot)
Write-Host "Executing local unit tests..."
& $node --test (Join-Path $here 'tests\service.test.mjs')
if ($LASTEXITCODE -ne 0) { throw "POWERSHELL_DIRECT_TESTS_FAILED" }
if (-not $Start) {
  Write-Host 'CHECK_PASS — service NOT STARTED. Re-run with -Start to launch isolated port 17486.'
  exit 0
}
Write-Host 'Starting isolated PowerShell Direct service at 127.0.0.1:17486.'
Write-Host 'Private local URL and token will appear below. Do NOT share either.'
& $node (Join-Path $here 'service.mjs') (Resolve-Path -LiteralPath $WorkspaceRoot).Path
if ($LASTEXITCODE -ne 0) { throw 'POWERSHELL_DIRECT_SERVER_FAILED' }
