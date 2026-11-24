# Create a fresh, isolated stage for the current PR138 HEAD.
# Never touches the older R2 service, R1, tunnels, credentials or production.
[CmdletBinding()]
param([ValidateSet('Inspect','Prepare')][string]$Mode='Inspect')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$sourceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\PowerShellDirect-PR138-current-release-clean'
$expectedCommit='35e69e7e58c7e1b054a0771cabce07cc0c4108df'
$expectedRemote='github.com/rinatikd/nss-engine'
$sourcePath=(Resolve-Path -LiteralPath $sourceExpected).ProviderPath.TrimEnd('\')
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R2-PR138-35e69e7'
$git='C:\Program Files\Git\cmd\git.exe'
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_MISSING'}
function Quote-Argument([string]$Value){
 $b=New-Object System.Text.StringBuilder;[void]$b.Append('"');$slashes=0
 foreach($c in $Value.ToCharArray()){
  if($c -eq [char]'\'){$slashes++;continue}
  if($c -eq [char]'"'){if($slashes -gt 0){[void]$b.Append(('\'*($slashes*2)))};[void]$b.Append('\"');$slashes=0;continue}
  if($slashes -gt 0){[void]$b.Append(('\'*$slashes));$slashes=0};[void]$b.Append($c)
 }
 if($slashes -gt 0){[void]$b.Append(('\'*($slashes*2)))}
 [void]$b.Append('"');return $b.ToString()
}
function Git([string]$Root,[string[]]$GitArguments){
 $quoted=@((@('-C',$Root)+$GitArguments)|ForEach-Object{Quote-Argument ([string]$_)})
 $psi=New-Object System.Diagnostics.ProcessStartInfo;$psi.FileName=$git
 $psi.WorkingDirectory=$Root;$psi.Arguments=[string]::Join(' ',$quoted)
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=New-Object System.Diagnostics.Process;$p.StartInfo=$psi;$code=-1
 try{if(!$p.Start()){throw 'GIT_START_FAILED'};$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync()
  if(!$p.WaitForExit(60000)){try{$p.Kill()}catch{};throw 'GIT_TIMEOUT'}
  $stdout=$o.GetAwaiter().GetResult();$stderr=$e.GetAwaiter().GetResult();$code=$p.ExitCode
 }finally{$p.Dispose()}
 if($code -ne 0){throw ('GIT_FAILED_'+$code)}
 return ([string]$stdout).Trim()
}
function RemoteIdentity([string]$Value){
 $u=$null
 if([Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$u) -and $u.Host){
  $p=$u.AbsolutePath.Trim('/')
  if($p.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$p=$p.Substring(0,$p.Length-4)}
  return ($u.Host.ToLowerInvariant()+'/'+$p.ToLowerInvariant())
 }
 if($Value -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
  $p=$Matches.path.Trim('/').TrimEnd('/')
  if($p.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$p=$p.Substring(0,$p.Length-4)}
  return ($Matches.host.ToLowerInvariant()+'/'+$p.ToLowerInvariant())
 }
 return ''
}
if($sourcePath -ine $sourceExpected){throw 'UNEXPECTED_CURRENT_SOURCE_PATH'}
$head=Git $sourcePath @('rev-parse','--verify','HEAD')
if($head -cne $expectedCommit){throw 'UNEXPECTED_CURRENT_RELEASE_COMMIT'}
$top=[IO.Path]::GetFullPath((Git $sourcePath @('rev-parse','--show-toplevel')))
if($top.TrimEnd('\') -ine $sourcePath){throw 'GIT_TOPLEVEL_MISMATCH'}
$origin=Git $sourcePath @('remote','get-url','origin')
if((RemoteIdentity $origin) -cne $expectedRemote){throw 'GIT_REMOTE_MISMATCH'}
$dirty=Git $sourcePath @('status','--porcelain=v1','--untracked-files=all')
if(![string]::IsNullOrWhiteSpace($dirty)){throw 'SOURCE_WORKTREE_NOT_CLEAN'}
$trackedText=Git $sourcePath @('ls-files','--','tools/powershell-direct','tools/ai_collaboration')
$files=@($trackedText -split '\r?\n'|Where-Object{![string]::IsNullOrWhiteSpace($_)}|Sort-Object -Unique)
if($files.Count -lt 17){throw 'TRACKED_SOURCE_INVENTORY_TOO_SMALL'}
$tests=@(
 'tools/ai_collaboration/workspace-policy.test.mjs',
 'tools/ai_collaboration/local_test_runner.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/ai_collaboration/local_mcp_dispatch.test.mjs',
 'tools/powershell-direct/tests/service.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/powershell-direct/tests/engineering.test.mjs'
)
$required=@(
 'tools/powershell-direct/service.mjs',
 'tools/powershell-direct/stack-supervisor.mjs',
 'tools/powershell-direct/runner.mjs',
 'tools/ai_collaboration/engineering-plan.mjs',
 'tools/ai_collaboration/engineering-runner.mjs',
 'tools/ai_collaboration/engineering-mcp.mjs',
 'tools/ai_collaboration/local_job_service.mjs',
 'tools/ai_collaboration/local_test_runner.mjs',
 'tools/ai_collaboration/workspace-policy.mjs',
 'tools/powershell-direct/tests/engineering-smoke.mjs'
)
foreach($relative in ($required+$tests)){
 if($files -notcontains $relative){throw ('TRACKED_SOURCE_MISSING_'+($relative -replace '[\\/ ]','_'))}
}
foreach($relative in $files){
 if($relative -notmatch '^tools/(powershell-direct|ai_collaboration)/[a-zA-Z0-9_./ -]+$'){throw 'TRACKED_SOURCE_PATH_UNSAFE'}
 if($relative.Split('/') -contains '..' -or $relative.Split('/') -contains '.'){throw 'TRACKED_SOURCE_PATH_TRAVERSAL'}
 $p=Join-Path $sourcePath ($relative.Replace('/','\'))
 if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw 'TRACKED_SOURCE_FILE_MISSING'}
 if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SOURCE_REPARSE_POINT_DENIED'}
}
if($Mode -eq 'Inspect'){
 [pscustomobject]@{
  Result='CURRENT_PR138_STAGE_PREFLIGHT';CandidateSha=$head
  StageExists=(Test-Path -LiteralPath $stage);TrackedFileCount=$files.Count
  RequiredFileCount=$required.Count;RegressionTestCount=$tests.Count
  ExistingR1AndR2Untouched=$true;ProductionUntouched=$true
 }|ConvertTo-Json -Compress
 return
}
if(Test-Path -LiteralPath $stage){throw 'CURRENT_STAGE_EXISTS_NO_OVERWRITE'}
$created=$false
try{
 $null=New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -ErrorAction Stop;$created=$true
 $rows=@()
 foreach($relative in $files){
  $from=Join-Path $sourcePath ($relative.Replace('/','\'))
  $to=Join-Path $stage ($relative.Replace('/','\'))
  $dir=Split-Path -Parent $to
  if(!(Test-Path -LiteralPath $dir -PathType Container)){$null=New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop}
  Copy-Item -LiteralPath $from -Destination $to -ErrorAction Stop
  $a=(Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash
  $b=(Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash
  if($a -cne $b){throw 'CURRENT_STAGE_HASH_MISMATCH'}
  $rows += [pscustomobject]@{File=$relative;Sha256=$a}
 }
 $manifest=Join-Path $stage 'source-hashes.json'
 ConvertTo-Json -InputObject $rows -Depth 4|Set-Content -LiteralPath $manifest -Encoding UTF8
 [pscustomobject]@{
  Result='CURRENT_PR138_STAGE_STAGED_UNTESTED';Stage=$stage
  CandidateSha=$head;VerifiedFileCount=$rows.Count
  ExistingR1AndR2Untouched=$true;ProductionTouched=$false
  TunnelTouched=$false;CutoverPerformed=$false;TestsPending=$true
 }|ConvertTo-Json -Compress
}catch{if($created){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue};throw}
