# Read-only endpoint and stderr diagnostics for Consilium 0.4.0.
# Displays only short code fragments around port references and redacted bounded stderr.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$root='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0'
$state='C:\Engineering\ChromeBridge_Consilium_Lab_0.4.0-State'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $root -PathType Container) -or !(Test-Path -LiteralPath $state -PathType Container)){throw 'CONSILIUM_ROOT_MISSING'}

$endpointReferences=@()
foreach($name in @('control.js','connection-check.js','transport-engine.js','connection-diagnostic.js','control-targets.js')){
  $file=Join-Path $root $name
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){continue}
  $lines=[IO.File]::ReadAllLines($file)
  for($i=0;$i -lt $lines.Length;$i++){
    $line=$lines[$i]
    if($line.Contains('17381') -or $line.Contains('17484')){
      $needle=if($line.Contains('17381')){'17381'}else{'17484'}
      $index=$line.IndexOf($needle,[StringComparison]::Ordinal)
      $begin=[Math]::Max(0,$index-100)
      $length=[Math]::Min(300,$line.Length-$begin)
      $fragment=$line.Substring($begin,$length)
      $endpointReferences += [pscustomobject]@{
        File=$name
        Line=$i+1
        Port=$needle
        Fragment=$fragment
      }
    }
  }
}
$stderrCandidates=@(Get-ChildItem -LiteralPath $state -File -Filter 'bridge-*.stderr.log' -Force -ErrorAction SilentlyContinue |
  Where-Object {$_.Length -gt 0}|Sort-Object LastWriteTimeUtc -Descending)
$stderrSummary=@()
foreach($file in $stderrCandidates | Select-Object -First 3){
  $raw=[IO.File]::ReadAllText($file.FullName)
  if($raw.Length -gt 1800){$raw=$raw.Substring($raw.Length-1800)}
  $safe=$raw -replace '(?i)(authorization|token|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;"]+','$1$2[REDACTED]'
  $safe=$safe -replace '(?i)Bearer\s+[A-Za-z0-9._~-]+','Bearer [REDACTED]'
  $safe=$safe -replace '\b[A-Fa-f0-9]{48,}\b','[REDACTED_HEX]'
  $stderrSummary += [pscustomobject]@{
    File=$file.Name
    Length=[long]$file.Length
    LastWriteUtc=$file.LastWriteTimeUtc.ToString('o')
    Tail=$safe
  }
}
$consiliumFiles=@()
$consiliumCodeRoot=Join-Path $root 'consilium'
if(Test-Path -LiteralPath $consiliumCodeRoot -PathType Container){
  $consiliumFiles=@(Get-ChildItem -LiteralPath $consiliumCodeRoot -Recurse -File -Force |
    Select-Object -First 80|ForEach-Object {
      [pscustomobject]@{Path=$_.FullName.Substring($root.Length).TrimStart('\');Length=[long]$_.Length}
    })
}
$authAndProtocol=@()
$bridgeFile=Join-Path $root 'server\bridge.mjs'
if(Test-Path -LiteralPath $bridgeFile -PathType Leaf){
  $lines=[IO.File]::ReadAllLines($bridgeFile)
  for($i=0;$i -lt $lines.Length;$i++){
    if($lines[$i] -match '(?i)authorization|Bearer|tools/list|browser_status|unauthorized|agentToken|req\.headers'){
      $authAndProtocol += [pscustomobject]@{Line=$i+1;Text=($lines[$i].Trim())}
    }
  }
}
$connectionCheckSource=''
$connectionCheckPath=Join-Path $root 'connection-check.js'
if(Test-Path -LiteralPath $connectionCheckPath -PathType Leaf){
  $connectionCheckSource=[string]::Join([Environment]::NewLine,(Get-Content -LiteralPath $connectionCheckPath -Encoding UTF8|Select-Object -First 100))
}
$serverRoutes=@()
$bridgeFile=Join-Path $root 'server\bridge.mjs'
if(Test-Path -LiteralPath $bridgeFile -PathType Leaf){
  $lines=[IO.File]::ReadAllLines($bridgeFile)
  for($i=0;$i -lt $lines.Length;$i++){
    if($lines[$i] -match '(\.get\(|\.post\(|\.put\(|\.delete\(|createServer|health|/mcp|/bridge/)'){
      $serverRoutes += [pscustomobject]@{Line=$i+1;Text=($lines[$i].Trim())}
    }
  }
}
[pscustomobject]@{
  Result='CONSILIUM_ENDPOINT_DIAGNOSTICS_READ_ONLY'
  EndpointReferences=$endpointReferences
  PreviousStderr=$stderrSummary
  ConsiliumCodeFiles=$consiliumFiles
  AuthAndProtocolCode=$authAndProtocol
  ConnectionCheckSource=$connectionCheckSource
  ServerRouteCandidates=@($serverRoutes|Select-Object -First 80)
}|ConvertTo-Json -Depth 7
