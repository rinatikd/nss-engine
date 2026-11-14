# Windows-only DPAPI approval bootstrap test. Never touches the live supervisor.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security -ErrorAction Stop
$save=Join-Path $PSScriptRoot '..\Save-ApprovalToken.ps1'
$open=Join-Path $PSScriptRoot '..\Open-Approval.ps1'
$testRoot=Join-Path $env:TEMP ('psdirect-approval-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$priorLocalAppData=$env:LOCALAPPDATA
$token=('a'*64)
try{
 $env:LOCALAPPDATA=$testRoot
 $psi=New-Object System.Diagnostics.ProcessStartInfo
 $psi.FileName='powershell.exe'
 $psi.Arguments='-NoProfile -NonInteractive -File "'+$save+'"'
 $psi.UseShellExecute=$false
 $psi.CreateNoWindow=$true
 $psi.RedirectStandardInput=$true
 $psi.RedirectStandardOutput=$true
 $psi.RedirectStandardError=$true
 $psi.EnvironmentVariables['LOCALAPPDATA']=$testRoot
 $p=[Diagnostics.Process]::Start($psi)
 try{
  $p.StandardInput.WriteLine($token)
  $p.StandardInput.Close()
  if(!$p.WaitForExit(12000)){try{$p.Kill()}catch{};throw 'WRITER_TIMEOUT'}
  $output=$p.StandardOutput.ReadToEnd()+$p.StandardError.ReadToEnd()
  # Preserve child PowerShell's actual error, but never show the token.
  $safeOutput=$output.Replace($token,'[REDACTED]')
  if($output.Contains($token)){throw 'PLAINTEXT_EMITTED'}
  if($p.ExitCode -ne 0){
   $safeOutput=$safeOutput.Substring(0,[Math]::Min(1800,$safeOutput.Length))
   throw ('WRITER_FAILED_EXIT_'+$p.ExitCode+': '+$safeOutput)
  }
 }finally{$p.Dispose()}
 $file=Join-Path $testRoot 'ChromeBridge-Recovery\Approval\powershell-direct-ui.dpapi'
 if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw 'DPAPI_FILE_MISSING'}
 $encrypted=[IO.File]::ReadAllBytes($file)
 if([Text.Encoding]::UTF8.GetString($encrypted).Contains($token)){throw 'PLAINTEXT_STORED'}
 $entropy=[Text.Encoding]::UTF8.GetBytes('PowerShellDirectApproval:v1')
 $plain=[System.Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
 try{
  if([Text.Encoding]::UTF8.GetString($plain) -cne $token){throw 'DPAPI_DECRYPT_MISMATCH'}
 }finally{[Array]::Clear($plain,0,$plain.Length)}
 $acl=Get-Acl -LiteralPath $file
 if(!$acl.AreAccessRulesProtected){throw 'FILE_ACL_NOT_PROTECTED'}
 $directoryAcl=Get-Acl -LiteralPath (Split-Path $file -Parent)
 if(!$directoryAcl.AreAccessRulesProtected){throw 'DIRECTORY_ACL_NOT_PROTECTED'}
 $rules=@($acl.Access)
 foreach($rule in $rules){
  $sid=try{([System.Security.Principal.NTAccount]$rule.IdentityReference).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$rule.IdentityReference.Value}
  if($sid -ne ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -and $sid -ne 'S-1-5-18'){
   throw 'FILE_ACL_UNEXPECTED_PRINCIPAL'
  }
 }
 # False/stale URL must not open the browser or reveal token. -CheckOnly errors.
 $previousErrorAction=$ErrorActionPreference
 try{
  $ErrorActionPreference='Continue'
  $staleOutput=(& powershell.exe -NoProfile -NonInteractive -File $open -CheckOnly 2>&1 | Out-String)
  $staleExit=$LASTEXITCODE
 }finally{$ErrorActionPreference=$previousErrorAction}
 if($staleExit -eq 0){throw 'STALE_APPROVAL_TOKEN_ACCEPTED'}
 if($staleOutput.Contains($token)){throw 'TOKEN_EXPOSED_ON_FAILURE'}
 [pscustomobject]@{
  Result='APPROVAL_BOOTSTRAP_ISOLATED_PASS'
  CurrentUserDpapiRoundTrip=$true
  PlaintextNotStored=$true
  SecretNotPrinted=$true
  FileAclProtected=$true
  DirectoryAclProtected=$true
  StaleApprovalRejected=$true
  ProductionServiceTouched=$false
 }|ConvertTo-Json
}finally{
 $env:LOCALAPPDATA=$priorLocalAppData
 Remove-Item -LiteralPath $testRoot -Force -Recurse -ErrorAction SilentlyContinue
}
