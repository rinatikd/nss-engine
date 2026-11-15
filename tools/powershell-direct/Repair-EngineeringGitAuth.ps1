# Operator-side one-time GitHub credential enrollment for Engineering MCP RC1.
# Default Inspect is read-only. AuthorizeAndStage may change only the fixed clean
# base checkout by fast-forward and create the separate pinned RC1 lab folder.
# Never sends or prints GitHub credentials to ChatGPT; no Codex or paid API.
[CmdletBinding()]
param([ValidateSet('Inspect','AuthorizeAndStage')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo='C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$expectedBranch='platform/ai-windows-control-release-20261114'
$remote='https://github.com/rinatikd/nss-engine.git'
$git='C:\Program Files\Git\cmd\git.exe'
# Modern Git for Windows may install GCM under ucrt64, older under mingw64.
# Restrict discovery to standard trusted installation directories.
$gcmCandidates=@(
 'C:\Program Files\Git\ucrt64\bin\git-credential-manager.exe',
 'C:\Program Files\Git\mingw64\bin\git-credential-manager.exe',
 'C:\Program Files\Git\clangarm64\bin\git-credential-manager.exe',
 'C:\Program Files\Git\cmd\git-credential-manager.exe',
 'C:\Program Files\Git Credential Manager\git-credential-manager.exe',
 'C:\Program Files (x86)\Git Credential Manager\git-credential-manager.exe'
)
$gcm=@($gcmCandidates | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf} | Select-Object -First 1)
if($gcm.Count -eq 0){
 throw ('GCM_NOT_FOUND_IN_STANDARD_LOCATIONS; checked '+($gcmCandidates -join '; '))
}
$gcm=$gcm[0]

if(-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)){throw 'WINDOWS_REQUIRED'}
foreach($p in @($git)){
 if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw ('TRUSTED_EXE_MISSING: '+[IO.Path]::GetFileName($p))}
}
if(!(Test-Path -LiteralPath $repo -PathType Container)){throw 'BASE_CHECKOUT_MISSING'}
if((Resolve-Path -LiteralPath $repo).ProviderPath -ine $repo){throw 'BASE_CHECKOUT_REDIRECTED'}
$previous=@{}
foreach($name in @('GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_OPTIONAL_LOCKS','GIT_TERMINAL_PROMPT','GCM_INTERACTIVE','GCM_GUI_PROMPT')){
 $previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
}
try{
 $env:GIT_CONFIG_GLOBAL='NUL'
 $env:GIT_CONFIG_NOSYSTEM='1'
 $env:GIT_OPTIONAL_LOCKS='0'
 $env:GIT_TERMINAL_PROMPT='0'
 $env:GCM_INTERACTIVE=if($Mode -eq 'AuthorizeAndStage'){'1'}else{'0'}
 $env:GCM_GUI_PROMPT=if($Mode -eq 'AuthorizeAndStage'){'1'}else{'0'}
 $actualUrl=(& $git -C $repo remote get-url origin | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $actualUrl -cne $remote){throw 'REMOTE_URL_NOT_ALLOWLISTED'}
 $branch=(& $git -C $repo branch --show-current | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $branch -cne $expectedBranch){throw 'BASE_BRANCH_MISMATCH'}
 $upstream=(& $git -C $repo rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $upstream -cne ('origin/'+$expectedBranch)){throw 'BASE_UPSTREAM_MISMATCH'}
 $dirty=(& $git -C $repo status --porcelain=v1 --untracked-files=all | Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $dirty){throw 'BASE_CHECKOUT_NOT_CLEAN'}
 if($Mode -eq 'Inspect'){
  [pscustomobject]@{Result='GIT_AUTH_BOOTSTRAP_READY';GcmInstalled=$true;GcmPath=$gcm;Branch=$branch;BaseClean=$true;GitHubLoginStarted=$false;ProductionServiceChanged=$false}|ConvertTo-Json -Compress
  return
 }
 # Credential enrollment occurs locally through the official Git for Windows
 # GCM browser/GUI if the Windows credential vault lacks an existing login.
 $gcmFlags=@('-c','core.hooksPath=NUL','-c','protocol.ext.allow=never',
  '-c','protocol.file.allow=never','-c','credential.helper=',
  '-c','credential.helper=manager','-c','credential.interactive=true')
 & $git @gcmFlags ls-remote --exit-code $remote ('refs/heads/'+$expectedBranch) | Out-Null
 if($LASTEXITCODE -ne 0){throw 'LOCAL_GITHUB_AUTH_FAILED'}
 & $git -C $repo @gcmFlags pull --ff-only --no-rebase --no-tags --no-autostash
 if($LASTEXITCODE -ne 0){throw 'BASE_FAST_FORWARD_FAILED'}
 $labScript=Join-Path $repo 'tools\powershell-direct\Prepare-EngineeringRc1Lab.ps1'
 if(!(Test-Path -LiteralPath $labScript -PathType Leaf)){throw 'LAB_HELPER_NOT_AVAILABLE'}
 & powershell.exe -NoProfile -NonInteractive -File $labScript -Mode Prepare
 if($LASTEXITCODE -ne 0){throw 'ISOLATED_LAB_PREPARATION_FAILED'}
 [pscustomobject]@{Result='RC1_LAB_STAGED';GitHubCredentialManager='WindowsLocal';BaseSynced=$true;ProductionServiceChanged=$false}|ConvertTo-Json -Compress
}finally{
 foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
}
