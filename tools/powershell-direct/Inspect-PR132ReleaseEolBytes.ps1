# Read-only byte-level EOL inventory for tracked dirty files in the disposable PR132 checkout.
# Reads Git blobs and working files only; never writes any repository file.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspace='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$repo=Join-Path $workspace 'work\ChromeBridge-PR132-fb2c27a8-release-clean'
$git='C:\Program Files\Git\cmd\git.exe'
$resolved=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($resolved -ine $workspace){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $repo -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}

function Count-Eol([byte[]]$Bytes){
  $lf=0;$crlf=0;$bareCr=0
  for($i=0;$i -lt $Bytes.Length;$i++){
    if($Bytes[$i] -eq 10){
      $lf++
      if($i -gt 0 -and $Bytes[$i-1] -eq 13){$crlf++}
    }elseif($Bytes[$i] -eq 13){
      if($i+1 -ge $Bytes.Length -or $Bytes[$i+1] -ne 10){$bareCr++}
    }
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$hash=[BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  [pscustomobject]@{Bytes=$Bytes.Length;LF=$lf;CRLF=$crlf;BareCR=$bareCr;SHA256=$hash}
}
function Read-GitBlob([string]$Path){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.Arguments='cat-file blob HEAD:'+$Path
  $psi.WorkingDirectory=$repo
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $p=New-Object System.Diagnostics.Process
  $p.StartInfo=$psi
  if(!$p.Start()){throw 'GIT_BLOB_PROCESS_START_FAILED'}
  $errTask=$p.StandardError.ReadToEndAsync()
  $memory=New-Object System.IO.MemoryStream
  $p.StandardOutput.BaseStream.CopyTo($memory)
  if(!$p.WaitForExit(15000)){try{$p.Kill()}catch{};throw 'GIT_BLOB_READ_TIMEOUT'}
  $p.WaitForExit()
  if($p.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$errTask.Result)){throw 'GIT_BLOB_READ_FAILED'}
  return ,$memory.ToArray()
}
$statusPsi=New-Object System.Diagnostics.ProcessStartInfo
$statusPsi.FileName=$git
$statusPsi.Arguments='status --porcelain=v1 --untracked-files=all'
$statusPsi.WorkingDirectory=$repo
$statusPsi.UseShellExecute=$false
$statusPsi.CreateNoWindow=$true
$statusPsi.RedirectStandardOutput=$true
$statusPsi.RedirectStandardError=$true
$statusProc=New-Object System.Diagnostics.Process
$statusProc.StartInfo=$statusPsi
if(!$statusProc.Start()){throw 'GIT_STATUS_PROCESS_START_FAILED'}
$statusOut=$statusProc.StandardOutput.ReadToEndAsync()
$statusErr=$statusProc.StandardError.ReadToEndAsync()
if(!$statusProc.WaitForExit(15000)){try{$statusProc.Kill()}catch{};throw 'GIT_STATUS_TIMEOUT'}
$statusProc.WaitForExit()
if($statusProc.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$statusErr.Result)){throw 'GIT_STATUS_READ_FAILED'}
$lines=@(([string]$statusOut.Result) -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$items=@()
foreach($line in $lines){
  if($line.Length -lt 4){throw 'STATUS_LINE_INVALID'}
  $path=$line.Substring(3)
  if($path.Contains([char]32) -or $path.Contains([char]9)){throw 'COMPLEX_PATH_REFUSED'}
  $full=Join-Path $repo ($path.Replace('/','\'))
  $work=[IO.File]::ReadAllBytes($full)
  $blob=Read-GitBlob $path
  $items += [pscustomobject]@{
    Status=$line.Substring(0,2)
    Path=$path
    HeadBlob=(Count-Eol $blob)
    WorkingFile=(Count-Eol $work)
  }
}
[pscustomobject]@{
  Result='PR132_EOL_BYTE_INVENTORY_READ_ONLY'
  Head=(Get-Content -LiteralPath (Join-Path $repo '.git\HEAD') -Raw).Trim()
  DirtyFileCount=$items.Count
  Files=$items
  NoWrites=$true
  LabChanged=$false
  ProductionChanged=$false
}|ConvertTo-Json -Depth 6
