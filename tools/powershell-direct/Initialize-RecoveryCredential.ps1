# Secure local recovery-key setup. Never prints or accepts plaintext on a command line.
# Does NOT start/restart/stop a service or a tunnel.
[CmdletBinding()]
param([ValidateSet('Inspect','Provision')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_REQUIRED'}
$dir=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery'
$dest=Join-Path $dir 'control-plane.dpapi'
$expectedName='control-plane.dpapi'
if([IO.Path]::GetFileName($dest) -ne $expectedName){throw 'UNEXPECTED_CREDENTIAL_PATH'}
function Check-Existing {
  if(!(Test-Path -LiteralPath $dest -PathType Leaf)){
    return [pscustomobject]@{Present=$false;CurrentUserDecryptionSucceeded=$false;HasContent=$false}
  }
  $s=$null
  try {
    $protected=(Get-Content -LiteralPath $dest -Raw -Encoding UTF8).Trim()
    if(!$protected){throw 'CREDENTIAL_EMPTY'}
    $s=ConvertTo-SecureString -String $protected -ErrorAction Stop
    return [pscustomobject]@{Present=$true;CurrentUserDecryptionSucceeded=$true;HasContent=($s.Length -gt 0)}
  } catch {
    return [pscustomobject]@{Present=$true;CurrentUserDecryptionSucceeded=$false;HasContent=$false}
  } finally {
    if($s){$s.Dispose()}
  }
}
$before=Check-Existing
if($Mode -eq 'Inspect'){
 [pscustomobject]@{
   Check='POWERSHELL_DIRECT_DPAPI_RECOVERY_INSPECT'
   FilePresent=$before.Present
   DecryptableByCurrentWindowsUser=$before.CurrentUserDecryptionSucceeded
   ContentNonempty=$before.HasContent
   CredentialValidityAgainstControlPlaneVerified=$false
   ProductionChanged=$false
 }|ConvertTo-Json
 return
}
# Fail closed even when the existing file cannot be decrypted.
if($before.Present){throw 'CREDENTIAL_ALREADY_EXISTS_NO_OVERWRITE'}
# Must prompt through Windows console, never through script args or environment.
$secret=Read-Host 'Enter your CURRENT authorized control-plane API key (local console only)' -AsSecureString
if(!$secret -or $secret.Length -lt 8){
 if($secret){$secret.Dispose()}
 throw 'EMPTY_OR_TOO_SHORT_KEY'
}
try{
  $protected=ConvertFrom-SecureString -SecureString $secret -ErrorAction Stop
  if([string]::IsNullOrWhiteSpace($protected)){throw 'ENCRYPTION_FAILED'}
  # Create-only; no secret ever returned in stdout.
  if(!(Test-Path -LiteralPath $dir -PathType Container)){
    New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
  }
  $handle=$null
  try{
    # CreateNew prevents overwrite, including concurrent provisioning.
    $handle=[IO.File]::Open($dest,[IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,[IO.FileShare]::None)
    $bytes=[Text.Encoding]::UTF8.GetBytes($protected)
    $handle.Write($bytes,0,$bytes.Length)
    $handle.Flush($true)
  } finally {
    if($handle){$handle.Dispose()}
  }
} finally {
  $secret.Dispose()
}
$after=Check-Existing
if(!$after.Present -or !$after.CurrentUserDecryptionSucceeded -or !$after.HasContent){
  throw 'DPAPI_ROUNDTRIP_FAILED_INSPECT_FILE_LOCALLY'
}
[pscustomobject]@{
 Result='DPAPI_RECOVERY_CREDENTIAL_PROVISIONED'
 FilePresent=$true
 DecryptableByCurrentWindowsUser=$true
 ValidityAgainstControlPlaneVerified=$false
 ProductionChanged=$false
 TunnelTouched=$false
 Note='Credential was entered locally and DPAPI-encrypted. Live service/tunnel were not restarted.'
}|ConvertTo-Json
