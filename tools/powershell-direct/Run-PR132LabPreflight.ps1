# Consolidated PR #132 / PR102 Lab preflight.
# One bounded PowerShell Direct operation: normalize only proven EOL-only staging differences,
# inspect exact Lab process/config identity, then dry-run both server and extension updaters.
# Does NOT apply deployment, send provider messages, touch Production, or print credentials.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$workspaceExpected='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$repo=Join-Path $workspaceExpected 'work\ChromeBridge-PR132-4e33b8d3-release-clean'
$candidateRoot=Join-Path $repo 'docs\chrome-bridge-handoff\chrome-bridge-v20'
$expectedSha='4e33b8d34cd5c68b94ee304d4f0c0b502c46d56a'
$expectedBranch='feat/chat-approved-session-auth-20261122'
$remoteExpected='https://github.com/rinatikd/nss-engine'
$labServerRoot='C:\Engineering\chrome-bridge-pr102-release-test\docs\chrome-bridge-handoff\chrome-bridge-v20'
$labExtensionRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$labStateRoot='C:\Engineering\ChromeBridge-PR102-17484-State'
$labExtensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'
$labPort=17484
$git='C:\Program Files\Git\cmd\git.exe'

$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if($workspace -ine $workspaceExpected){throw 'UNEXPECTED_APPROVED_WORKSPACE'}
if(!(Test-Path -LiteralPath $repo -PathType Container)){throw 'PINNED_CHECKOUT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $candidateRoot -PathType Container)){throw 'PINNED_CANDIDATE_NOT_FOUND'}
if(!(Test-Path -LiteralPath $labServerRoot -PathType Container)){throw 'PR102_LAB_SERVER_ROOT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $labExtensionRoot -PathType Container)){throw 'PR102_LAB_EXTENSION_ROOT_NOT_FOUND'}
if(!(Test-Path -LiteralPath $labStateRoot -PathType Container)){throw 'PR102_LAB_STATE_ROOT_NOT_FOUND'}
foreach($rootPath in @($labServerRoot,$labExtensionRoot,$labStateRoot)){
  if((Get-Item -LiteralPath $rootPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('PR102_LAB_ROOT_REPARSE_POINT_REFUSED: '+$rootPath)}
}

function QuoteWindowsArgument([string]$Value){
  $sb=New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $slashCount=0
  foreach($ch in $Value.ToCharArray()){
    if($ch -eq [char]'\'){$slashCount++;continue}
    if($ch -eq [char]'"'){
      if($slashCount -gt 0){[void]$sb.Append(('\' * ($slashCount*2)))}
      [void]$sb.Append('\"')
      $slashCount=0
      continue
    }
    if($slashCount -gt 0){[void]$sb.Append(('\' * $slashCount));$slashCount=0}
    [void]$sb.Append($ch)
  }
  if($slashCount -gt 0){[void]$sb.Append(('\' * ($slashCount*2)))}
  [void]$sb.Append('"')
  return $sb.ToString()
}
function InvokeGit([string[]]$GitArguments){
  $allArguments=@('-C',$repo)+$GitArguments
  $quoted=@($allArguments|ForEach-Object { QuoteWindowsArgument ([string]$_) })
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$git
  $psi.WorkingDirectory=$repo
  $psi.Arguments=[string]::Join(' ',$quoted)
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$psi
  try{
    if(-not $process.Start()){throw 'GIT_PROCESS_START_FAILED'}
    $stdoutTask=$process.StandardOutput.ReadToEndAsync()
    $stderrTask=$process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout=$stdoutTask.GetAwaiter().GetResult()
    $stderr=$stderrTask.GetAwaiter().GetResult()
    $exitCode=$process.ExitCode
  }finally{
    $process.Dispose()
  }
  return [pscustomobject]@{ExitCode=$exitCode;Output=$stdout;Error=$stderr}
}
function GitValue([string[]]$GitArguments){
  $r=InvokeGit $GitArguments
  if($r.ExitCode -ne 0){throw ('GIT_READ_FAILED: '+($GitArguments -join ' '))}
  return $r.Output.Trim()
}
function FullPath([string]$Path){return [IO.Path]::GetFullPath($Path).TrimEnd('\')}
function IsInside([string]$Child,[string]$Parent){
  $c=(FullPath $Child)+'\'
  $p=(FullPath $Parent)+'\'
  return $c.StartsWith($p,[StringComparison]::OrdinalIgnoreCase)
}
function RemoteIdentity([string]$Value){
  if([string]::IsNullOrWhiteSpace($Value)){return ''}
  $s=$Value.Trim()
  try{
    $u=[Uri]$s
    if($u.IsAbsoluteUri -and $u.Host){
      $path=$u.AbsolutePath.TrimEnd('/')
      if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$path=$path.Substring(0,$path.Length-4)}
      return ($u.Host.ToLowerInvariant()+$path.ToLowerInvariant())
    }
  }catch{}
  if($s -match '^(?:[^@/]+@)?(?<host>[^/:]+):(?<path>[^?#]+)$'){
    $path=$Matches.path.TrimStart('/').TrimEnd('/')
    if($path.EndsWith('.git',[StringComparison]::OrdinalIgnoreCase)){$path=$path.Substring(0,$path.Length-4)}
    return ($Matches.host.ToLowerInvariant()+'/'+$path.ToLowerInvariant())
  }
  return ''
}

# Gate 1: exact repository, branch and immutable source commit.
$remote=GitValue @('remote','get-url','origin')
$storedRemote=GitValue @('config','--local','--get','remote.origin.url')
$branch=GitValue @('branch','--show-current')
$head=GitValue @('rev-parse','HEAD')
$remoteBranchHead=GitValue @('rev-parse',('refs/remotes/origin/'+$expectedBranch))
$remoteIdentity=RemoteIdentity $remote
$storedIdentity=RemoteIdentity $storedRemote
$expectedIdentity=RemoteIdentity $remoteExpected
if([string]::IsNullOrWhiteSpace($remoteIdentity) -or
   [string]::IsNullOrWhiteSpace($storedIdentity) -or
   $remoteIdentity -ine $expectedIdentity -or
   $storedIdentity -ine $expectedIdentity){
  throw ('CANDIDATE_REMOTE_MISMATCH: effectiveIdentity='+$remoteIdentity+
    '; storedIdentity='+$storedIdentity+'; expectedIdentity='+$expectedIdentity)
}
if(-not [string]::IsNullOrWhiteSpace($branch) -and $branch -cne $expectedBranch){
  throw 'CANDIDATE_BRANCH_MISMATCH'
}
if($head -cne $expectedSha){throw 'CANDIDATE_COMMIT_MISMATCH'}
if($remoteBranchHead -cne $expectedSha){throw 'CANDIDATE_REMOTE_BRANCH_HEAD_MISMATCH'}

# Gate 2: allow only proven EOL-only edits outside every deployment input.
# Preserve these unrelated checkout files; never rewrite/reset them. The actual server,
# extension and Control Room inputs are checked independently below by Assert-BridgeCandidateSource.
$status=InvokeGit @('status','--porcelain=v1','--untracked-files=all')
if($status.ExitCode -ne 0){throw 'CANDIDATE_STATUS_READ_FAILED'}
$eolOnlyFileCount=0
if(-not [string]::IsNullOrWhiteSpace($status.Output)){
  $cached=InvokeGit @('diff','--cached','--quiet')
  $eolOnly=InvokeGit @('diff','--quiet','--ignore-space-at-eol')
  $untracked=GitValue @('ls-files','--others','--exclude-standard')
  if($cached.ExitCode -ne 0 -or $eolOnly.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($untracked)){
    throw 'CANDIDATE_WORKTREE_HAS_STAGED_NON_EOL_OR_UNTRACKED_CHANGES'
  }
  $rows=@($status.Output -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $protectedInputs=@(
    'docs/chrome-bridge-handoff/chrome-bridge-v20/server',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/extension',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/consilium-control-room',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/cutover-health.mjs',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/cutover-start.mjs',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/process-identity.ps1',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/verify-candidate-source.ps1',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/upgrade-pr102-lab-server.ps1',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/upgrade-pr102-lab.ps1'
  )
  foreach($line in $rows){
    if($line.Length -lt 4 -or $line.Substring(0,2) -cne ' M'){throw 'CANDIDATE_NON_WORKTREE_STATUS_REFUSED'}
    $relativePath=$line.Substring(3).Replace('\','/')
    if($relativePath -match '(^|/)\.\.(/|$)' -or $relativePath.StartsWith('/')){throw 'CANDIDATE_UNSAFE_RELATIVE_PATH'}
    foreach($protected in $protectedInputs){
      if($relativePath -ieq $protected -or $relativePath.StartsWith($protected+'/',[StringComparison]::OrdinalIgnoreCase)){
        throw ('CANDIDATE_DEPLOYMENT_INPUT_MODIFIED: '+$relativePath)
      }
    }
    $eolOnlyFileCount++
  }
}

# Gate 3: verify required source files and source tree integrity.
foreach($relative in @(
 'server\bridge.mjs',
 'server\tools.mjs',
 'deployment\process-identity.ps1',
 'deployment\verify-candidate-source.ps1',
 'deployment\upgrade-pr102-lab-server.ps1',
 'deployment\upgrade-pr102-lab.ps1',
 'extension\background.js',
 'extension\control.js',
 'extension\session-authorization.js',
 'consilium-control-room\consilium\control-room.mjs'
)){
  if(!(Test-Path -LiteralPath (Join-Path $candidateRoot $relative) -PathType Leaf)){
    throw ('PINNED_CANDIDATE_FILE_MISSING: '+$relative)
  }
}
. (Join-Path $candidateRoot 'deployment\verify-candidate-source.ps1')
$sourceInputsServer=@('server','deployment/cutover-health.mjs','deployment/cutover-start.mjs','deployment/process-identity.ps1','deployment/verify-candidate-source.ps1','deployment/upgrade-pr102-lab-server.ps1')
$sourceInputsExtension=@('extension','deployment/verify-candidate-source.ps1','deployment/upgrade-pr102-lab.ps1')
$sourceInputsControlRoom=@('consilium-control-room','deployment/verify-candidate-source.ps1')
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsServer
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsExtension
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsControlRoom

# Gate 4: exact owner, process environment and three-root Lab isolation.
. (Join-Path $candidateRoot 'deployment\process-identity.ps1')
$listeners=@([BridgeNativeMetadata]::Listeners($labPort))
if($listeners.Count -ne 1){throw ('LAB_LISTENER_COUNT_MISMATCH: '+$listeners.Count)}
$listenerParts=([string]$listeners[0]).Split('|')
if($listenerParts.Count -ne 2 -or $listenerParts[0] -cne '127.0.0.1'){throw 'LAB_LISTENER_ADDRESS_MISMATCH'}
$expectedPid=0
if(![int]::TryParse($listenerParts[1],[ref]$expectedPid) -or $expectedPid -le 0){throw 'LAB_LISTENER_PID_INVALID'}
$proc=[Diagnostics.Process]::GetProcessById($expectedPid)
try{
  $null=$proc.Handle
  $identity=Get-BridgeHandleIdentity $proc
}finally{$proc.Dispose()}
$nodeExe=FullPath ([string]$identity.executable)
if($nodeExe -ine 'C:\Program Files\nodejs\node.exe'){throw 'LAB_NODE_EXECUTABLE_NOT_EXPECTED'}
if(!(Test-Path -LiteralPath $nodeExe -PathType Leaf)){throw 'LAB_NODE_EXECUTABLE_NOT_FOUND'}
$nodeExeDirectory=Split-Path -Parent $nodeExe
if([string]::IsNullOrWhiteSpace($nodeExeDirectory)){throw 'LAB_NODE_EXECUTABLE_DIRECTORY_INVALID'}
if((FullPath ([string]$identity.workingDirectory)) -ine (FullPath $labServerRoot)){throw 'LAB_PROCESS_WORKING_DIRECTORY_MISMATCH'}
if((FullPath ([string]$identity.bridgeHome)) -ine (FullPath $labStateRoot)){throw 'LAB_PROCESS_STATE_ROOT_MISMATCH'}
if([string]$identity.bridgePort -cne [string]$labPort){throw 'LAB_PROCESS_PORT_MISMATCH'}
if([string]$identity.extensionId -cne $labExtensionId){throw 'LAB_PROCESS_EXTENSION_ID_MISMATCH'}
$command=([string]$identity.command).Replace('/','\').Trim()
if($command -notmatch '^"C:\\Program Files\\nodejs\\node\.exe"\s+server\\bridge\.mjs

# The unpacked extension path must match Chrome's recorded Secure Preferences entry.
$extensionIdMapped=$false
$chromeRoots=@(
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User')
)|Where-Object {Test-Path -LiteralPath $_ -PathType Container}
foreach($chromeRoot in $chromeRoots){
  $profileNames=@('Default')+@((Get-ChildItem -LiteralPath $chromeRoot -Directory -Force -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '^Profile \d+$'} | ForEach-Object {$_.Name}))
  foreach($profileName in $profileNames){
    $preferencesPath=Join-Path (Join-Path $chromeRoot $profileName) 'Secure Preferences'
    if(Test-Path -LiteralPath $preferencesPath -PathType Leaf){
      try{
        $preferences=Get-Content -LiteralPath $preferencesPath -Raw -Encoding UTF8|ConvertFrom-Json
        $entry=$preferences.extensions.settings.PSObject.Properties[$labExtensionId]
        if($entry){
          $registeredPath=[string]$entry.Value.path
          if((FullPath $registeredPath) -ieq (FullPath $labExtensionRoot)){$extensionIdMapped=$true}
        }
      }catch{}
    }
  }
}
if(-not $extensionIdMapped){throw 'LAB_EXTENSION_CHROME_SECURE_PREFERENCES_PATH_MISMATCH'}

$manifestPath=Join-Path $labExtensionRoot 'manifest.json'
if(!(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'LAB_EXTENSION_MANIFEST_MISSING'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
if([int]$manifest.manifest_version -ne 3 -or [string]$manifest.background.service_worker -cne 'background.js' -or [string]$manifest.background.type -cne 'module'){
  throw 'LAB_EXTENSION_MANIFEST_PROFILE_MISMATCH'
}
$manifestHosts=@($manifest.host_permissions)
if($manifestHosts -notcontains 'http://127.0.0.1:17484/*' -or
   ($manifestHosts | Where-Object {$_ -match '^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/\*$' -and $_ -cne 'http://127.0.0.1:17484/*'}).Count -gt 0){
  throw 'LAB_EXTENSION_HOST_PERMISSION_MISMATCH'
}

# Read the exact state config, but never print or copy its secrets.
$configPath=Join-Path $labStateRoot 'config.json'
if(!(Test-Path -LiteralPath $configPath -PathType Leaf)){throw 'LAB_STATE_CONFIG_MISSING'}
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
if($config.agentToken -isnot [string] -or $config.agentToken.Length -lt 32 -or
   $config.browserToken -isnot [string] -or $config.browserToken.Length -lt 32){
  throw 'LAB_STATE_TOKEN_MATERIAL_INVALID'
}
$configEvidence=[pscustomobject]@{
  Path=$configPath
  StateRoot=$labStateRoot
  ConfigSha256=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
  AgentTokenLength=$config.agentToken.Length
  BrowserTokenLength=$config.browserToken.Length
}
$expectedStartUtc=[DateTime]::Parse($identity.created).ToUniversalTime().ToString('o')

# Gate 5: server dry-run and extension dry-run, each bound to its actual root.
$serverScript=Join-Path $candidateRoot 'deployment\upgrade-pr102-lab-server.ps1'
$extensionScript=Join-Path $candidateRoot 'deployment\upgrade-pr102-lab.ps1'
$serverParams=@{
  LabRoot=$labServerRoot
  StateRoot=$labStateRoot
  ExpectedPid=$expectedPid
  ExpectedStartUtc=$expectedStartUtc
  CandidateRoot=$candidateRoot
  ExpectedSourceSha=$expectedSha
}
$previousPath=$env:PATH
try{
  # Pin both dry-run updaters to the exact node.exe image owning the live Lab listener.
  $env:PATH=$nodeExeDirectory+';'+$previousPath
  $selectedNode=(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
  if((FullPath $selectedNode) -ine $nodeExe){throw 'LAB_NODE_EXECUTABLE_RESOLUTION_MISMATCH'}
  $serverOutput=@(& $serverScript @serverParams 2>&1)
  $serverText=[string]::Join([Environment]::NewLine,[string[]]@($serverOutput|ForEach-Object {[string]$_}))
  if($serverText -notmatch '\[DRY_RUN\] Server and isolated MCP registry validated'){throw ('SERVER_DRY_RUN_FAILED: '+$serverText)}
  $extensionParams=@{
    LabRoot=$labExtensionRoot
    StateRoot=$labStateRoot
    CandidateRoot=$candidateRoot
    LabPort=$labPort
    ExpectedSourceSha=$expectedSha
  }
  $extensionOutput=@(& $extensionScript @extensionParams 2>&1)
  $extensionText=[string]::Join([Environment]::NewLine,[string[]]@($extensionOutput|ForEach-Object {[string]$_}))
  if($extensionText -notmatch '\[DRY_RUN\] No installed files changed'){throw ('EXTENSION_DRY_RUN_FAILED: '+$extensionText)}
}finally{$env:PATH=$previousPath}

# Reconfirm immutable checkout and unchanged process identity after dry-runs.
if((GitValue @('rev-parse','HEAD')) -cne $expectedSha){throw 'CANDIDATE_HEAD_CHANGED_AFTER_DRY_RUN'}
$finalStatus=GitValue @('status','--porcelain=v1','--untracked-files=all')
if($finalStatus -cne $status.Output.Trim()){throw 'CANDIDATE_CHECKOUT_STATUS_CHANGED_DURING_PREFLIGHT'}
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsServer
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsExtension
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsControlRoom
$currentListener=@([BridgeNativeMetadata]::Listeners($labPort))
if($currentListener.Count -ne 1 -or [string]$currentListener[0] -cne ('127.0.0.1|'+$expectedPid)){throw 'LAB_LISTENER_CHANGED_DURING_PREFLIGHT'}
$currentProcess=[Diagnostics.Process]::GetProcessById($expectedPid)
try{$currentIdentity=Get-BridgeHandleIdentity $currentProcess}finally{$currentProcess.Dispose()}
if([string]$currentIdentity.command -cne [string]$identity.command -or
   (FullPath ([string]$currentIdentity.workingDirectory)) -ine (FullPath $labServerRoot) -or
   (FullPath ([string]$currentIdentity.bridgeHome)) -ine (FullPath $labStateRoot) -or
   [string]$currentIdentity.extensionId -cne $labExtensionId){throw 'LAB_PROCESS_IDENTITY_CHANGED_DURING_PREFLIGHT'}
if((Get-FileHash -LiteralPath $configEvidence.Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configEvidence.ConfigSha256){throw 'LAB_CONFIG_CHANGED_DURING_PREFLIGHT'}

[pscustomobject]@{
  Result='PR132_LAB_PREFLIGHT_READY'
  SourceCommit=$expectedSha
  SourceBranch=$expectedBranch
  SourceRemoteIdentity=(RemoteIdentity $remote)
  CandidateRoot=$candidateRoot
  CandidateWorktreeClean=([string]::IsNullOrWhiteSpace($finalStatus))
  UnrelatedEolOnlyFilesPreserved=$eolOnlyFileCount
  DeploymentInputTreesClean=$true
  LabServerRoot=$labServerRoot
  LabExtensionRoot=$labExtensionRoot
  LabStateRoot=$labStateRoot
  LabPort=$labPort
  LabExtensionId=$labExtensionId
  LabProcessId=$expectedPid
  LabProcessStartUtc=$expectedStartUtc
  LabCommandKind=$commandKind
  LabConfigSha256=$configEvidence.ConfigSha256
  ServerDryRun='PASS'
  ExtensionDryRun='PASS'
  NoProviderMessagesSent=$true
  NoSessionAuthorized=$true
  ProductionChanged=$false
  CredentialsPrinted=$false
  DeploymentApplied=$false
}|ConvertTo-Json -Depth 5
){
  throw 'LAB_PROCESS_COMMAND_LINE_MISMATCH'
}
$commandKind='relative-server-entry'

# The unpacked extension path must match Chrome's recorded Secure Preferences entry.
$extensionIdMapped=$false
$chromeRoots=@(
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User')
)|Where-Object {Test-Path -LiteralPath $_ -PathType Container}
foreach($chromeRoot in $chromeRoots){
  $profileNames=@('Default')+@((Get-ChildItem -LiteralPath $chromeRoot -Directory -Force -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '^Profile \d+$'} | ForEach-Object {$_.Name}))
  foreach($profileName in $profileNames){
    $preferencesPath=Join-Path (Join-Path $chromeRoot $profileName) 'Secure Preferences'
    if(Test-Path -LiteralPath $preferencesPath -PathType Leaf){
      try{
        $preferences=Get-Content -LiteralPath $preferencesPath -Raw -Encoding UTF8|ConvertFrom-Json
        $entry=$preferences.extensions.settings.PSObject.Properties[$labExtensionId]
        if($entry){
          $registeredPath=[string]$entry.Value.path
          if((FullPath $registeredPath) -ieq (FullPath $labExtensionRoot)){$extensionIdMapped=$true}
        }
      }catch{}
    }
  }
}
if(-not $extensionIdMapped){throw 'LAB_EXTENSION_CHROME_SECURE_PREFERENCES_PATH_MISMATCH'}

$manifestPath=Join-Path $labExtensionRoot 'manifest.json'
if(!(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'LAB_EXTENSION_MANIFEST_MISSING'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
if([int]$manifest.manifest_version -ne 3 -or [string]$manifest.background.service_worker -cne 'background.js' -or [string]$manifest.background.type -cne 'module'){
  throw 'LAB_EXTENSION_MANIFEST_PROFILE_MISMATCH'
}
$manifestHosts=@($manifest.host_permissions)
if($manifestHosts -notcontains 'http://127.0.0.1:17484/*' -or
   ($manifestHosts | Where-Object {$_ -match '^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/\*$' -and $_ -cne 'http://127.0.0.1:17484/*'}).Count -gt 0){
  throw 'LAB_EXTENSION_HOST_PERMISSION_MISMATCH'
}

# Read the exact state config, but never print or copy its secrets.
$configPath=Join-Path $labStateRoot 'config.json'
if(!(Test-Path -LiteralPath $configPath -PathType Leaf)){throw 'LAB_STATE_CONFIG_MISSING'}
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
if($config.agentToken -isnot [string] -or $config.agentToken.Length -lt 32 -or
   $config.browserToken -isnot [string] -or $config.browserToken.Length -lt 32){
  throw 'LAB_STATE_TOKEN_MATERIAL_INVALID'
}
$configEvidence=[pscustomobject]@{
  Path=$configPath
  StateRoot=$labStateRoot
  ConfigSha256=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
  AgentTokenLength=$config.agentToken.Length
  BrowserTokenLength=$config.browserToken.Length
}
$expectedStartUtc=[DateTime]::Parse($identity.created).ToUniversalTime().ToString('o')

# Gate 5: server dry-run and extension dry-run, each bound to its actual root.
$serverScript=Join-Path $candidateRoot 'deployment\upgrade-pr102-lab-server.ps1'
$extensionScript=Join-Path $candidateRoot 'deployment\upgrade-pr102-lab.ps1'
$serverParams=@{
  LabRoot=$labServerRoot
  StateRoot=$labStateRoot
  ExpectedPid=$expectedPid
  ExpectedStartUtc=$expectedStartUtc
  CandidateRoot=$candidateRoot
  ExpectedSourceSha=$expectedSha
}
$previousPath=$env:PATH
try{
  # Pin both dry-run updaters to the exact node.exe image owning the live Lab listener.
  $env:PATH=$nodeExeDirectory+';'+$previousPath
  $selectedNode=(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
  if((FullPath $selectedNode) -ine $nodeExe){throw 'LAB_NODE_EXECUTABLE_RESOLUTION_MISMATCH'}
  $serverOutput=@(& $serverScript @serverParams 2>&1)
  $serverText=[string]::Join([Environment]::NewLine,[string[]]@($serverOutput|ForEach-Object {[string]$_}))
  if($serverText -notmatch '\[DRY_RUN\] Server and isolated MCP registry validated'){throw ('SERVER_DRY_RUN_FAILED: '+$serverText)}
  $extensionParams=@{
    LabRoot=$labExtensionRoot
    StateRoot=$labStateRoot
    CandidateRoot=$candidateRoot
    LabPort=$labPort
    ExpectedSourceSha=$expectedSha
  }
  $extensionOutput=@(& $extensionScript @extensionParams 2>&1)
  $extensionText=[string]::Join([Environment]::NewLine,[string[]]@($extensionOutput|ForEach-Object {[string]$_}))
  if($extensionText -notmatch '\[DRY_RUN\] No installed files changed'){throw ('EXTENSION_DRY_RUN_FAILED: '+$extensionText)}
}finally{$env:PATH=$previousPath}

# Reconfirm immutable checkout and unchanged process identity after dry-runs.
if((GitValue @('rev-parse','HEAD')) -cne $expectedSha){throw 'CANDIDATE_HEAD_CHANGED_AFTER_DRY_RUN'}
$finalStatus=GitValue @('status','--porcelain=v1','--untracked-files=all')
if($finalStatus -cne $status.Output.Trim()){throw 'CANDIDATE_CHECKOUT_STATUS_CHANGED_DURING_PREFLIGHT'}
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsServer
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsExtension
$null=Assert-BridgeCandidateSource -CandidateRoot $candidateRoot -ExpectedSourceSha $expectedSha -InputPaths $sourceInputsControlRoom
$currentListener=@([BridgeNativeMetadata]::Listeners($labPort))
if($currentListener.Count -ne 1 -or [string]$currentListener[0] -cne ('127.0.0.1|'+$expectedPid)){throw 'LAB_LISTENER_CHANGED_DURING_PREFLIGHT'}
$currentProcess=[Diagnostics.Process]::GetProcessById($expectedPid)
try{$currentIdentity=Get-BridgeHandleIdentity $currentProcess}finally{$currentProcess.Dispose()}
if([string]$currentIdentity.command -cne [string]$identity.command -or
   (FullPath ([string]$currentIdentity.workingDirectory)) -ine (FullPath $labServerRoot) -or
   (FullPath ([string]$currentIdentity.bridgeHome)) -ine (FullPath $labStateRoot) -or
   [string]$currentIdentity.extensionId -cne $labExtensionId){throw 'LAB_PROCESS_IDENTITY_CHANGED_DURING_PREFLIGHT'}
if((Get-FileHash -LiteralPath $configEvidence.Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configEvidence.ConfigSha256){throw 'LAB_CONFIG_CHANGED_DURING_PREFLIGHT'}

[pscustomobject]@{
  Result='PR132_LAB_PREFLIGHT_READY'
  SourceCommit=$expectedSha
  SourceBranch=$expectedBranch
  SourceRemoteIdentity=(RemoteIdentity $remote)
  CandidateRoot=$candidateRoot
  CandidateWorktreeClean=([string]::IsNullOrWhiteSpace($finalStatus))
  UnrelatedEolOnlyFilesPreserved=$eolOnlyFileCount
  DeploymentInputTreesClean=$true
  LabServerRoot=$labServerRoot
  LabExtensionRoot=$labExtensionRoot
  LabStateRoot=$labStateRoot
  LabPort=$labPort
  LabExtensionId=$labExtensionId
  LabProcessId=$expectedPid
  LabProcessStartUtc=$expectedStartUtc
  LabCommandKind=$commandKind
  LabStateRoot=$configEvidence.StateRoot
  LabConfigSha256=$configEvidence.ConfigSha256
  ServerDryRun='PASS'
  ExtensionDryRun='PASS'
  NoProviderMessagesSent=$true
  NoSessionAuthorized=$true
  ProductionChanged=$false
  CredentialsPrinted=$false
  DeploymentApplied=$false
}|ConvertTo-Json -Depth 5
