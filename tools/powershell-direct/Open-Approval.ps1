# Operator-only: open the current supervisor's local approval page.
# Does not reveal the query key in console, files, MCP or ChatGPT.
[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
$source=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\Approval\powershell-direct-ui.dpapi'
if(!(Test-Path -LiteralPath $source -PathType Leaf)){throw 'APPROVAL_BOOTSTRAP_NOT_PUBLISHED'}
$item=Get-Item -LiteralPath $source -Force
if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'APPROVAL_TOKEN_REPARSE_DENIED'}
$entropy=[Text.Encoding]::UTF8.GetBytes('PowerShellDirectApproval:v1')
$encrypted=[IO.File]::ReadAllBytes($source)
$plain=$null
try{
 $plain=[Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $key=[Text.Encoding]::UTF8.GetString($plain)
 if($key -cnotmatch '^[0-9a-f]{64}$'){throw 'APPROVAL_TOKEN_INVALID'}
 # Never construct any non-loopback URL or reflect the token in output.
 $url='http://127.0.0.1:17486/approve?key='+[Uri]::EscapeDataString($key)
 # CheckOnly validates the access without opening a browser or printing secrets.
 $request=[Net.HttpWebRequest][Net.WebRequest]::Create($url)
 $request.Timeout=2500
 $request.AllowAutoRedirect=$false
 $request.Proxy=$null
 try{
  $response=$request.GetResponse()
  try{
   if([int]$response.StatusCode -ne 200){throw 'APPROVAL_UI_NOT_READY'}
  }finally{$response.Close()}
 }catch{
  throw 'APPROVAL_UI_NOT_READY_OR_STALE_TOKEN'
 }
 if(!$CheckOnly){
  Start-Process -FilePath $url | Out-Null
  Write-Output 'LOCAL_APPROVAL_PAGE_OPENED'
 }else{
  Write-Output 'LOCAL_APPROVAL_PAGE_READY'
 }
}finally{
 if($null -ne $plain){[Array]::Clear($plain,0,$plain.Length)}
 $key=$null
 $url=$null
}
