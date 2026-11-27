# Non-disruptive, local credential/configuration doctor for PowerShell Direct.
# Never starts the tunnel daemon, never touches an existing process, and never
# emits plaintext, ciphertext, raw diagnostic output, or the local key path.
[CmdletBinding()]
param([ValidateSet('Inspect','Doctor')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
$client='C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe'
$credential=Join-Path $env:LOCALAPPDATA 'ChromeBridge-Recovery\control-plane.dpapi'
$profileName='powershell-direct-work'
if(!(Test-Path -LiteralPath $client -PathType Leaf)){throw 'TUNNEL_CLIENT_MISSING'}
$present=Test-Path -LiteralPath $credential -PathType Leaf
if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Check='CONTROL_PLANE_DOCTOR_PREFLIGHT'
  TunnelClientPresent=$true
  RecoveryFilePresent=[bool]$present
  Profile=$profileName
  TunnelStarted=$false
  ProductionTouched=$false
 }|ConvertTo-Json
 return
}
if(!$present){throw 'RECOVERY_FILE_MISSING'}
$secret=$null
$pointer=[IntPtr]::Zero
$plain=$null
$previous=[Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY','Process')
if(![string]::IsNullOrEmpty($previous)){
 throw 'EXISTING_PROCESS_API_KEY_SET_REFUSE_OVERRIDE'
}
try{
 $ciphertext=Get-Content -LiteralPath $credential -Raw -Encoding UTF8
 $secret=ConvertTo-SecureString -String $ciphertext.Trim() -ErrorAction Stop
 if($secret.Length -lt 8){throw 'RECOVERY_FILE_INVALID'}
 $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
 $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 if([string]::IsNullOrWhiteSpace($plain)){throw 'RECOVERY_FILE_EMPTY'}
 [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$plain,'Process')
 # doctor is a pre-start validation command, not "run".
 # Never print raw stdout/stderr: future versions may emit sensitive details.
 $output=@(& $client doctor --profile $profileName --control-plane.api-key 'env:CONTROL_PLANE_API_KEY' --json 2>&1 | Out-String)
 $code=$LASTEXITCODE
 $raw=$output -join [Environment]::NewLine
 $jsonOk=$false
 try{$null=ConvertFrom-Json -InputObject $raw -ErrorAction Stop;$jsonOk=$true}catch{}
 $hasCredentialCheck=$raw -match '(?i)control_plane_api_key|control-plane.api-key'
 [pscustomobject]@{
  Check='CONTROL_PLANE_DOCTOR_RESULT'
  DoctorExitCode=$code
  JsonParsed=$jsonOk
  CredentialCheckMentioned=[bool]$hasCredentialCheck
  LocalDoctorPassed=($code -eq 0)
  RemoteAuthenticationVerified=$false
  TunnelStarted=$false
  ProductionTouched=$false
  RawDiagnosticsSuppressed=$true
  Note='Doctor validates pre-start configuration. Remote key acceptance remains unverified unless separately proven.'
 }|ConvertTo-Json
}finally{
 [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$null,'Process')
 $plain=$null
 if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 if($secret){$secret.Dispose()}
}
