# Restore the existing PowerShell Direct supervisor (17486) after reboot.
# Never stop/replace an existing process. The supervisor itself owns its tunnel.
# No credentials are shown, logged, or included on the command line.
[CmdletBinding()]
param([ValidateSet('Status','Restore')][string]$Mode='Status')
$ErrorActionPreference='Stop'
$port=17486
$node='C:\Program Files\nodejs\node.exe'
$script='C:\Engineering\ChromeBridge-PowerShell-Direct-Validation\tools\powershell-direct\stack-supervisor.mjs'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
function Check-Stack {
  try {
    $l=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    $matches=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.ExecutablePath -ieq $node -and $_.CommandLine -and $_.CommandLine.Contains($script)
    })
    if($l.Count -gt 1){return 'occupied'}
    if($l.Count -eq 1){
      if(@($matches|Where-Object {$_.ProcessId -eq $l[0].OwningProcess}).Count -eq 1){
        return 'owned-listener'
      }
      return 'occupied'
    }
    if($matches.Count -gt 0){return 'unhealthy'}
    return 'stopped'
  } catch {return 'unknown'}
}
$before=Check-Stack
if($Mode -eq 'Status'){
  [PSCustomObject]@{Service='powershell-direct';State=$before;
    KeyAvailable=(Test-Path -LiteralPath $credential -PathType Leaf)}|ConvertTo-Json
  return
}
if($before -ne 'stopped'){
  [PSCustomObject]@{Service='powershell-direct';Outcome=('BLOCKED_'+$before)}|ConvertTo-Json
  return
}
foreach($file in @($node,$script,$client,$credential)){
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw 'POWERSHELL_DIRECT_PREREQUISITE_MISSING'}
}
$secure=(Get-Content -LiteralPath $credential -Raw -Encoding UTF8)|ConvertTo-SecureString
$ptr=[IntPtr]::Zero
$plain=$null
try {
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if([string]::IsNullOrWhiteSpace($plain)){throw 'KEY_EMPTY'}
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName=$node
  $psi.Arguments='"'+$script+'"'
  $psi.WorkingDirectory=Split-Path $script -Parent
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.EnvironmentVariables['PS_DIRECT_ALLOWED_ROOT']='C:\Engineering'
  $psi.EnvironmentVariables['PS_DIRECT_TUNNEL_CLIENT']=$client
  $psi.EnvironmentVariables['CONTROL_PLANE_API_KEY']=$plain
  if((Check-Stack) -ne 'stopped'){throw 'POWERSHELL_DIRECT_START_RACE'}
  $child=[Diagnostics.Process]::Start($psi)
  if(!$child){throw 'POWERSHELL_DIRECT_START_FAILED'}
  Start-Sleep -Seconds 3
  [PSCustomObject]@{Service='powershell-direct';Outcome=if((Check-Stack) -eq 'owned-listener'){
    'OWNED_LISTENER_STARTED_TUNNEL_UNVERIFIED'
  }else{'START_UNCONFIRMED'}}|ConvertTo-Json
} finally {
  $plain=$null
  if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  $secure.Dispose()
  if($psi){$psi.EnvironmentVariables.Remove('CONTROL_PLANE_API_KEY')|Out-Null}
}
