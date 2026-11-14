# Idempotent PR102 lab tunnel recovery for the CURRENT Windows user.
# No production tunnel changes. No credential values in output or arguments.
[CmdletBinding()]
param([ValidateSet('Status','Restore')][string]$Mode='Status')
$ErrorActionPreference='Stop'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$profile=Join-Path $env:APPDATA 'tunnel-client\chatgpt-chrome-bridge-pr102.yaml'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$expectedTunnel='tunnel_6af6edcde2388191a662d3c45fb6f469'
$labHome='C:\Engineering\ChromeBridge-PR102-17484-State'
function Get-TunnelState {
  try {
    $active=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" |
      Where-Object {$_.ExecutablePath -ieq $client -and $_.CommandLine -and
        $_.CommandLine.Contains($profile)})
    if($active.Count -gt 1) {return 'duplicate'}
    if($active.Count -eq 1) {return 'process-running-unverified'}
    return 'stopped'
  } catch {return 'unknown'}
}
$state=Get-TunnelState
if($Mode -eq 'Status'){
  [PSCustomObject]@{Service='chrome-pr102-tunnel';ProcessState=$state;
    KeyAvailable=(Test-Path -LiteralPath $credential -PathType Leaf)} | ConvertTo-Json
  return
}
if($state -ne 'stopped'){
  [PSCustomObject]@{Service='chrome-pr102-tunnel';Outcome=('BLOCKED_'+$state)} | ConvertTo-Json
  return
}
if(!(Test-Path -LiteralPath $client -PathType Leaf) -or
   !(Test-Path -LiteralPath $profile -PathType Leaf) -or
   !(Test-Path -LiteralPath $credential -PathType Leaf)) {
  throw 'TUNNEL_PREREQUISITE_MISSING'
}
$raw=Get-Content -LiteralPath $profile -Raw -Encoding UTF8
if(!$raw.Contains($expectedTunnel)) {throw 'TUNNEL_PROFILE_ID_MISMATCH'}
# Do not allow credentials to leave the current user process except through
# the tunnel client's environment. Avoid secrets in command-line arguments.
$secure=(Get-Content -LiteralPath $credential -Raw -Encoding UTF8) | ConvertTo-SecureString
$bstr=[IntPtr]::Zero
$plain=$null
try {
  $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if([string]::IsNullOrWhiteSpace($plain)) {throw 'DECRYPTED_KEY_EMPTY'}
  $startInfo=New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName=$client
  $startInfo.Arguments='run --config "'+$profile+'"'
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $startInfo.WorkingDirectory=Split-Path $client -Parent
  $startInfo.EnvironmentVariables['CONTROL_PLANE_API_KEY']=$plain
  $startInfo.EnvironmentVariables['CHROME_BRIDGE_LAB_HOME']=$labHome
  if((Get-TunnelState) -ne 'stopped') {throw 'TUNNEL_START_RACE'}
  $child=[System.Diagnostics.Process]::Start($startInfo)
  if($null -eq $child){throw 'TUNNEL_START_FAILED'}
  Start-Sleep -Seconds 2
  [PSCustomObject]@{
    Service='chrome-pr102-tunnel'
    Outcome=if((Get-TunnelState) -eq 'process-running-unverified') {
      'PROCESS_STARTED_REMOTE_HEALTH_NOT_VERIFIED'
    } else {'START_UNCONFIRMED'}
  } | ConvertTo-Json
} finally {
  $plain=$null
  if($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  $secure.Dispose()
  if($startInfo) {$startInfo.EnvironmentVariables.Remove('CONTROL_PLANE_API_KEY') | Out-Null}
}
