# Receives UI token through standard input, never through CLI arguments or logs.
# Stores only DPAPI CurrentUser ciphertext in the current user's profile.
$ErrorActionPreference='Stop'
$script:bootstrapStep='INITIALIZE'
trap {
 # Only stable operation identifiers and .NET error types may be emitted.
 # Do not emit exception messages, paths, scripts, credential text or token bytes.
 $e=$_.Exception
 $type=$e.GetType().Name
 if($e.InnerException){$type=$e.InnerException.GetType().Name}
 if($type -cnotmatch '^[A-Za-z][A-Za-z0-9]{0,60}
Add-Type -AssemblyName System.Security -ErrorAction Stop
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
foreach($allowedSid in @($sid,([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')))){
 $rule=[System.Security.AccessControl.FileSystemAccessRule]::new(
  $allowedSid,[System.Security.AccessControl.FileSystemRights]::FullControl,
  ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
  [System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
 $dirAcl.AddAccessRule($rule)
}
if(Test-Path -LiteralPath $directory){
 $item=Get-Item -LiteralPath $directory -Force
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'APPROVAL_DIRECTORY_REPARSE_DENIED'}
 if(!$item.PSIsContainer){throw 'APPROVAL_DIRECTORY_NOT_DIRECTORY'}
}else{
 New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$script:bootstrapStep='DIRECTORY_ACL'
Set-Acl -LiteralPath $directory -AclObject $dirAcl
$entropy=[Text.Encoding]::UTF8.GetBytes('PowerShellDirectApproval:v1')
$plain=[Text.Encoding]::UTF8.GetBytes($token)
try{
 $script:bootstrapStep='DPAPI_ENCRYPT'
 $encrypted=[System.Security.Cryptography.ProtectedData]::Protect(
  $plain,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
 $temp=Join-Path $directory ([IO.Path]::GetRandomFileName()+'.tmp')
 $script:bootstrapStep='TEMP_WRITE'
 [IO.File]::WriteAllBytes($temp,$encrypted)
 $fileAcl=New-Object System.Security.AccessControl.FileSecurity
 $fileAcl.SetAccessRuleProtection($true,$false)
 foreach($allowedSid in @($sid,([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')))){
  $fileRule=[System.Security.AccessControl.FileSystemAccessRule]::new(
   $allowedSid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)
  $fileAcl.AddAccessRule($fileRule)
 }
 # Apply the restricted DACL to the temporary file before publication.
 # NTFS rename inside the same directory preserves that DACL; applying Set-Acl
 # again after Move-Item can request SeSecurityPrivilege in PowerShell 5.1.
 $script:bootstrapStep='TEMP_ACL'
 Set-Acl -LiteralPath $temp -AclObject $fileAcl
 # Windows PowerShell Move-Item -Force may fail when destination already exists
 # with a protected DACL. Use NTFS atomic replacement for token rotation.
 # File.Replace does not delete the old token unless replacement succeeds.
 if(Test-Path -LiteralPath $file -PathType Leaf){
  $oldItem=Get-Item -LiteralPath $file -Force
  if(($oldItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
   throw 'APPROVAL_EXISTING_TOKEN_REPARSE_DENIED'
  }
  $script:bootstrapStep='EXISTING_ACL_READ'
  $oldAcl=Get-Acl -LiteralPath $file
  if(!$oldAcl.AreAccessRulesProtected){throw 'APPROVAL_EXISTING_TOKEN_ACL_NOT_PROTECTED'}
  foreach($entry in @($oldAcl.Access)){
   $oldSid=$entry.IdentityReference.Translate(
    [System.Security.Principal.SecurityIdentifier]).Value
   if($oldSid -ne $sid.Value -and $oldSid -ne 'S-1-5-18'){
    throw 'APPROVAL_EXISTING_TOKEN_UNEXPECTED_PRINCIPAL'
   }
  }
  $script:bootstrapStep='ATOMIC_REPLACE'
  try{[IO.File]::Replace($temp,$file,$null)}
  catch{throw 'APPROVAL_EXISTING_TOKEN_ATOMIC_REPLACE_FAILED'}
 }elseif(Test-Path -LiteralPath $file){
  throw 'APPROVAL_TOKEN_DESTINATION_NOT_FILE'
 }else{
  $script:bootstrapStep='INITIAL_MOVE'
  Move-Item -LiteralPath $temp -Destination $file
 }
 # Fail closed if replacing an existing file did not preserve protection.
 $script:bootstrapStep='PUBLISHED_ACL_VERIFY'
 $publishedAcl=Get-Acl -LiteralPath $file
 if(!$publishedAcl.AreAccessRulesProtected){throw 'APPROVAL_FILE_ACL_NOT_PROTECTED'}
 foreach($entry in @($publishedAcl.Access)){
  $entrySid=$entry.IdentityReference.Translate(
   [System.Security.Principal.SecurityIdentifier]).Value
  if($entrySid -ne $sid.Value -and $entrySid -ne 'S-1-5-18'){
   throw 'APPROVAL_FILE_ACL_UNEXPECTED_PRINCIPAL'
  }
 }
}finally{
 # A failed replace must not leave ciphertext temporary files in the profile.
 if($temp -and (Test-Path -LiteralPath $temp -PathType Leaf)){
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
 }
 [Array]::Clear($plain,0,$plain.Length)
 $token=$null
}
# No token or URL emitted.
){$type='UnknownException'}
 [Console]::Error.WriteLine('APPROVAL_BOOTSTRAP_FAILURE_STAGE_'+$script:bootstrapStep+'_TYPE_'+$type)
 exit 1
}
Add-Type -AssemblyName System.Security -ErrorAction Stop
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
foreach($allowedSid in @($sid,([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')))){
 $rule=[System.Security.AccessControl.FileSystemAccessRule]::new(
  $allowedSid,[System.Security.AccessControl.FileSystemRights]::FullControl,
  ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
  [System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
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
 $encrypted=[System.Security.Cryptography.ProtectedData]::Protect(
  $plain,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
 $temp=Join-Path $directory ([IO.Path]::GetRandomFileName()+'.tmp')
 [IO.File]::WriteAllBytes($temp,$encrypted)
 $fileAcl=New-Object System.Security.AccessControl.FileSecurity
 $fileAcl.SetAccessRuleProtection($true,$false)
 foreach($allowedSid in @($sid,([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')))){
  $fileRule=[System.Security.AccessControl.FileSystemAccessRule]::new(
   $allowedSid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)
  $fileAcl.AddAccessRule($fileRule)
 }
 # Apply the restricted DACL to the temporary file before publication.
 # NTFS rename inside the same directory preserves that DACL; applying Set-Acl
 # again after Move-Item can request SeSecurityPrivilege in PowerShell 5.1.
 Set-Acl -LiteralPath $temp -AclObject $fileAcl
 # Windows PowerShell Move-Item -Force may fail when destination already exists
 # with a protected DACL. Use NTFS atomic replacement for token rotation.
 # File.Replace does not delete the old token unless replacement succeeds.
 if(Test-Path -LiteralPath $file -PathType Leaf){
  $oldItem=Get-Item -LiteralPath $file -Force
  if(($oldItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
   throw 'APPROVAL_EXISTING_TOKEN_REPARSE_DENIED'
  }
  $oldAcl=Get-Acl -LiteralPath $file
  if(!$oldAcl.AreAccessRulesProtected){throw 'APPROVAL_EXISTING_TOKEN_ACL_NOT_PROTECTED'}
  foreach($entry in @($oldAcl.Access)){
   $oldSid=$entry.IdentityReference.Translate(
    [System.Security.Principal.SecurityIdentifier]).Value
   if($oldSid -ne $sid.Value -and $oldSid -ne 'S-1-5-18'){
    throw 'APPROVAL_EXISTING_TOKEN_UNEXPECTED_PRINCIPAL'
   }
  }
  try{[IO.File]::Replace($temp,$file,$null)}
  catch{throw 'APPROVAL_EXISTING_TOKEN_ATOMIC_REPLACE_FAILED'}
 }elseif(Test-Path -LiteralPath $file){
  throw 'APPROVAL_TOKEN_DESTINATION_NOT_FILE'
 }else{
  Move-Item -LiteralPath $temp -Destination $file
 }
 # Fail closed if replacing an existing file did not preserve protection.
 $publishedAcl=Get-Acl -LiteralPath $file
 if(!$publishedAcl.AreAccessRulesProtected){throw 'APPROVAL_FILE_ACL_NOT_PROTECTED'}
 foreach($entry in @($publishedAcl.Access)){
  $entrySid=$entry.IdentityReference.Translate(
   [System.Security.Principal.SecurityIdentifier]).Value
  if($entrySid -ne $sid.Value -and $entrySid -ne 'S-1-5-18'){
   throw 'APPROVAL_FILE_ACL_UNEXPECTED_PRINCIPAL'
  }
 }
}finally{
 # A failed replace must not leave ciphertext temporary files in the profile.
 if($temp -and (Test-Path -LiteralPath $temp -PathType Leaf)){
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
 }
 [Array]::Clear($plain,0,$plain.Length)
 $token=$null
}
# No token or URL emitted.
