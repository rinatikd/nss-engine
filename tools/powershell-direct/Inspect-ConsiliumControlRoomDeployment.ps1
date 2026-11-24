# Read-only inventory of Consilium Control Room launch settings and listeners.
# Does not start the Control Room, open browser tabs or modify state.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$root='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
$controlRoot=Join-Path $root 'consilium\consilium'
$startScript=Join-Path $root 'consilium\scripts\start.ps1'
$readme=Join-Path $controlRoot 'README.md'
$main=Join-Path $controlRoot 'control-room.mjs'
foreach($file in @($controlRoot,$startScript,$readme,$main)){
  if(!(Test-Path -LiteralPath $file)){throw ('CONSILIUM_CONTROL_ROOM_SOURCE_MISSING: '+$file)}
}
$startLines=@(Get-Content -LiteralPath $startScript -Encoding UTF8)
$readmeHits=@()
$readmeLines=[IO.File]::ReadAllLines($readme)
for($i=0;$i -lt $readmeLines.Length;$i++){
  if($readmeLines[$i] -match '(?i)port|127\.0\.0\.1|localhost|listen|start|launch|запуск|порт'){
    $readmeHits += [pscustomobject]@{Line=$i+1;Text=$readmeLines[$i].Trim()}
  }
}
$mainLines=[IO.File]::ReadAllLines($main)
$mainHits=@()
$portCandidates=@()
for($i=0;$i -lt $mainLines.Length;$i++){
  $line=$mainLines[$i]
  if($line -match '(?i)port|listen\(|127\.0\.0\.1|localhost|process\.env'){
    $mainHits += [pscustomobject]@{Line=$i+1;Text=$line.Trim()}
  }
  foreach($match in [regex]::Matches($line,'(?<!\d)(1[0-9]{4}|2[0-9]{4}|3[0-9]{4})(?!\d)')){
    $value=[int]$match.Value
    if($value -ge 1024 -and $value -le 65535){$portCandidates += $value}
  }
}
foreach($match in [regex]::Matches([string]::Join([Environment]::NewLine,$startLines),'(?<!\d)(1[0-9]{4}|2[0-9]{4}|3[0-9]{4})(?!\d)')){
  $value=[int]$match.Value
  if($value -ge 1024 -and $value -le 65535){$portCandidates += $value}
}
$portCandidates=@($portCandidates|Sort-Object -Unique)
$listeners=@()
foreach($port in $portCandidates){
  $items=@([BridgeNativeMetadata]::Listeners($port))
  $listeners += [pscustomobject]@{Port=$port;Listeners=$items}
}
$result=[ordered]@{
  Result='CONSILIUM_CONTROL_ROOM_DEPLOYMENT_READ_ONLY'
  ControlRoomRoot=$controlRoot
  ControlRoomSourceExists=$true
  StartScript=$startScript
  StartScriptContent=$startLines
  ReadmeRelevantLines=$readmeHits
  ControlRoomListenAndPortLines=$mainHits
  PortCandidates=$portCandidates
  PortListeners=$listeners
  LiveBridgePort17484Listener=@([BridgeNativeMetadata]::Listeners(17484))
  NoFilesChanged=$true
  NoProcessesStarted=$true
}|ConvertTo-Json -Depth 7
$result
