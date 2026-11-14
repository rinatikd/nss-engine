# One-time, user-initiated DPAPI credential enrollment for tunnel recovery.
# Does not print the key or store it in a YAML/script; only this Windows user
# on this PC can decrypt the resulting file. Do not sync it to GitHub/cloud.
[CmdletBinding()]
param([switch]$Replace)
$ErrorActionPreference='Stop'
$folder=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery'
$file=Join-Path $folder 'control-plane.dpapi'
if((Test-Path -LiteralPath $file) -and !$Replace) {
  throw 'CREDENTIAL_ALREADY_EXISTS_USE_REPLACE_EXPLICITLY'
}
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$secret=Read-Host 'CONTROL_PLANE_API_KEY (hidden input)' -AsSecureString
if($secret.Length -lt 8) { $secret.Dispose(); throw 'KEY_TOO_SHORT' }
try {
  $cipher=$secret | ConvertFrom-SecureString
  # Write to a temporary file; never print it.
  $tmp=Join-Path $folder ('credential-'+[guid]::NewGuid().ToString('N')+'.tmp')
  [IO.File]::WriteAllText($tmp,$cipher,(New-Object System.Text.UTF8Encoding($false)))
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $tmp -AclObject $acl
  Move-Item -LiteralPath $tmp -Destination $file -Force
  Write-Host 'DPAPI_CREDENTIAL_ENROLLED_FOR_CURRENT_USER'
} finally {
  $secret.Dispose()
}
