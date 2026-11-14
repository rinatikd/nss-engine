# Receives UI token through standard input, never through CLI arguments or logs.
# Stores only DPAPI CurrentUser ciphertext in the current user's profile.
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_REQUIRED'}
$token=[Console]::In.ReadLine()
if($null -eq $token -or $token -cnotmatch '^[0-9a-f]{64}$'){throw 'INVALID_APPROVAL_INPUT'}
$directory=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\Approval'
$file=Join-Path $directory 'powershell-direct-ui.dpapi'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
if($null -eq $sid){throw 'WINDOWS_IDENTITY_REQUIRED'}
# Folder is private to the same Windows SID (plus SYSTEM).
$dirAcl=New-Object System.Security.AccessControl.DirectorySecurity
$dirAcl.SetAccessRuleProtection($true,$false)
foreach($allowedSid in @($sid,(New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))){
 $rule=New-Object System.Security.AccessControl.FileSystemAccessRule(
  $allowedSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $dirAcl.AddAccessRule($rule)
}
if(Test-Path -LiteralPath $directory){
 $item=Get-Item -LiteralPath $directory -Force
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'APPROVAL_DIRECTORY_REPARSE_DENIED'}
 if(!$item.PSIsContainer){throw 'APPROVAL_DIRECTORY_NOT_DIRECTORY'}
}else{
 New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
Set-Acl -LiteralPath $directory -AclObject $dirAcl
$entropy=[Text.Encoding]::UTF8.GetBytes('PowerShellDirectApproval:v1')
$plain=[Text.Encoding]::UTF8.GetBytes($token)
try{
 $encrypted=[Security.Cryptography.ProtectedData]::Protect(
  $plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $temp=Join-Path $directory ([IO.Path]::GetRandomFileName()+'.tmp')
 [IO.File]::WriteAllBytes($temp,$encrypted)
 $fileAcl=New-Object System.Security.AccessControl.FileSecurity
 $fileAcl.SetAccessRuleProtection($true,$false)
 foreach($allowedSid in @($sid,(New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))){
  $fileRule=New-Object System.Security.AccessControl.FileSystemAccessRule($allowedSid,'FullControl','Allow')
  $fileAcl.AddAccessRule($fileRule)
 }
 Set-Acl -LiteralPath $temp -AclObject $fileAcl
 Move-Item -LiteralPath $temp -Destination $file -Force
 Set-Acl -LiteralPath $file -AclObject $fileAcl
}finally{
 [Array]::Clear($plain,0,$plain.Length)
 $token=$null
}
# No token or URL emitted.
