[CmdletBinding()]
param([string]$TargetBranch='main')
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
function Invoke-RepoGit {
    & git '-c' ('safe.directory='+($repoRoot -replace '\\','/')) @args
    if($LASTEXITCODE -ne 0){throw ('git failed: '+($args -join ' '))}
}
$origin=(Invoke-RepoGit remote get-url origin | Out-String).Trim()
if($origin -ne 'https://github.com/rinatikd/nss-engine.git'){throw 'Unexpected origin; nothing pushed.'}
Invoke-RepoGit diff --quiet
Invoke-RepoGit diff --cached --quiet
& python (Join-Path $PSScriptRoot 'repo_guard.py') --tree HEAD
if($LASTEXITCODE -ne 0){throw 'Source/secret check failed; nothing pushed.'}
# Fetch is mandatory, before any push. Never overwrite an uninspected existing branch.
Invoke-RepoGit fetch origin
$remoteHeads=@(Invoke-RepoGit ls-remote --heads origin)
$head=(Invoke-RepoGit rev-parse HEAD | Out-String).Trim()
if($remoteHeads.Count -eq 0){
    Invoke-RepoGit push -u origin ('HEAD:refs/heads/'+$TargetBranch)
    Write-Host ('Published '+$TargetBranch+' to '+$origin)
}else{
    $remoteDefault=(Invoke-RepoGit ls-remote --symref origin HEAD | Out-String)
    Write-Host 'Existing remote history detected:'
    $remoteHeads | Write-Host
    $bootstrapBranch='bootstrap/main-pc-'+$head.Substring(0,12)
    # Preserve all remote branches/history: publish only a uniquely named review branch.
    Invoke-RepoGit push origin ('HEAD:refs/heads/'+$bootstrapBranch)
    Write-Host ('Published a separate review branch: '+$bootstrapBranch)
    Write-Host 'Remote main/default branch was not changed. Review remote history before merging.'
    Write-Host ('https://github.com/rinatikd/nss-engine/compare/'+$bootstrapBranch+'?expand=1')
}
Invoke-RepoGit ls-remote --heads origin
