# Read-only remote authentication check using the separately DPAPI-protected
# recovery runtime key. Never starts/stops a tunnel, exposes the key, or
# prints control-plane metadata / raw stderr.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)]
 [ValidatePattern('^tunnel_[0-9a-fA-F]{32}$')]
 [string]$TunnelId
)
$ErrorActionPreference='Stop'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
if(!(Test-Path -LiteralPath $client -PathType Leaf)){throw 'CLIENT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $credential -PathType Leaf)){throw 'RECOVERY_FILE_MISSING'}
# The lookup must use only the DPAPI runtime key, never a higher-privilege
# admin key or a pre-existing API key from the caller's environment.
foreach($name in @('CONTROL_PLANE_API_KEY','OPENAI_API_KEY','OPENAI_ADMIN_KEY')){
 if(![string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name,'Process'))){
  throw ('CONFLICTING_ENVIRONMENT_'+$name)
 }
}
$secure=$null
$ptr=[IntPtr]::Zero
$plain=$null
$code=$null
$parsed=$false
$tunnelIdMatched=$false
$metadataReturned=$false
try{
 $ciphertext=(Get-Content -LiteralPath $credential -Raw -Encoding UTF8).Trim()
 $secure=ConvertTo-SecureString -String $ciphertext -ErrorAction Stop
 if($secure.Length -lt 8){throw 'RECOVERY_KEY_INVALID'}
 $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
 $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
 if([string]::IsNullOrWhiteSpace($plain)){throw 'RECOVERY_KEY_EMPTY'}
 [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$plain,'Process')
 # The runtime key exists only in this short-lived PowerShell process and
 # its child. Do NOT write stdout/stderr or use --admin-key.
 $raw=(& $client admin --json tunnels get $TunnelId 2>&1 | Out-String)
 $code=$LASTEXITCODE
 if($code -eq 0){
   try{
     $object=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
     $parsed=$true
     $metadataReturned=($null -ne $object)
     # A successful read for the requested ID is the authentication proof.
     # If the payload identifies the tunnel, ensure it matches exactly.
     foreach($field in @('id','tunnel_id','tunnelId')){
       $prop=$object.PSObject.Properties[$field]
       if($null -ne $prop -and ![string]::IsNullOrWhiteSpace([string]$prop.Value)){
         $tunnelIdMatched=([string]$prop.Value -eq $TunnelId)
         if(!$tunnelIdMatched){$metadataReturned=$false}
         break
       }
     }
   }catch{
     $parsed=$false
   }
 }
} finally {
 [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$null,'Process')
 $plain=$null
 if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
 if($secure){$secure.Dispose()}
}
[pscustomobject]@{
 Check='RECOVERY_RUNTIME_KEY_REMOTE_AUTH'
 RemoteApiRequestSucceeded=($code -eq 0 -and $parsed -and $metadataReturned)
 DoctorOnly=$false
 JsonParsed=$parsed
 MetadataPresent=$metadataReturned
 RemoteAuthenticationVerified=($code -eq 0 -and $parsed -and $metadataReturned)
 TunnelIdentityMatchedIfReturned=$tunnelIdMatched
 ExitCode=$code
 TunnelStarted=$false
 ProductionTouched=$false
 CredentialValueDisclosed=$false
 RawResponseSuppressed=$true
}|ConvertTo-Json
