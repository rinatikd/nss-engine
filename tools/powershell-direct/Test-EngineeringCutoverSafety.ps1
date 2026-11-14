# Fail-closed safety gates for actual production cutover entry point.
# This script never supplies production activation switches, never confirms
# a cutover, never stops a process, and does not touch credentials.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$target=Join-Path $PSScriptRoot 'Invoke-EngineeringCutover.ps1'
if(!(Test-Path -LiteralPath $target -PathType Leaf)){throw 'CUTOVER_FILE_MISSING'}
$tokens=$null;$parseErrors=$null
[System.Management.Automation.Language.Parser]::ParseFile(
  $target,[ref]$tokens,[ref]$parseErrors
)|Out-Null
if($parseErrors.Count -gt 0){throw 'CUTOVER_SCRIPT_PARSE_FAILED'}
$ports=@(17381,17382,17486,18086,18791)
function Snapshot {
 $out=@()
 foreach($port in $ports){
  $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  $out+=[pscustomobject]@{
   Port=$port
   Count=$listeners.Count
   Pid=if($listeners.Count -eq 1){[int]$listeners[0].OwningProcess}else{$null}
  }
 }
 return ,$out
}
$before=Snapshot
# Skip source test if original port isn't occupied, to avoid accidentally
# entering a different lifecycle environment.
$direct=@($before|Where-Object {$_.Port -eq 17486})
if($direct.Count -ne 1 -or $direct[0].Count -ne 1){throw 'LIVE_DIRECT_NOT_PRESENT'}
$cases=@(
 @{Name='NO_SWITCHES';Args=@('-Mode','Cutover')},
 @{Name='ONLY_AUTH_FLAG';Args=@('-Mode','Cutover','-RemoteAuthenticationVerified')},
 @{Name='ONLY_PRODUCTION_FLAG';Args=@('-Mode','Cutover','-EnableProductionCutover')}
)
$results=@()
foreach($case in $cases){
 $raw=(& powershell.exe -NoProfile -NonInteractive -File $target @($case.Args) 2>&1 | Out-String)
 $exitCode=$LASTEXITCODE
 if($exitCode -eq 0){throw ('CUTOVER_GATE_OPENED_'+$case.Name)}
 if($raw -notmatch 'PRODUCTION_CUTOVER_REQUIRES_EXPLICIT_SWITCHES'){
  throw ('CUTOVER_GATE_UNEXPECTED_ERROR_'+$case.Name)
 }
 $after=Snapshot
 foreach($item in $before){
  $now=@($after|Where-Object {$_.Port -eq $item.Port})
  if($now.Count -ne 1 -or $now[0].Count -ne $item.Count -or
     $now[0].Pid -ne $item.Pid){
   throw ('PORT_OWNERSHIP_CHANGED_'+$item.Port)
  }
 }
 $results+=[pscustomobject]@{Case=$case.Name;Denied=$true;PortOwnersUnchanged=$true}
}
[pscustomobject]@{
 Result='ENGINEERING_CUTOVER_ENTRY_GATE_TEST_PASS'
 PowerShellParsePassed=$true
 DeniedCases=$results
 ProductionChanged=$false
 TunnelChanged=$false
 RealRollbackExecuted=$false
 Note='Only verifies access gates; cannot prove crash recovery or rollback.'
}|ConvertTo-Json -Depth 5
