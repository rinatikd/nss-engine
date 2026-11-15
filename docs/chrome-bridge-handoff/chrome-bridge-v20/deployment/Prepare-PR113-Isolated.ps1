# Offline-only PR113 worktree preparation. Does not fetch, modify PR110 branch, or start services.
[CmdletBinding()]
param(
  [string]$Repo = 'C:\Engineering\ChromeBridge-Recovery-Install-20261114',
  [string]$Destination = 'C:\Engineering\ChromeBridge-PR113-Exact-Offline',
  [string]$Commit = 'ba82b7f6bd0167051e0ea64aa37d74da6513434e'
)
$ErrorActionPreference = 'Stop'
$git = 'C:\Program Files\Git\cmd\git.exe'
if (-not (Test-Path -LiteralPath $git -PathType Leaf)) { throw 'TRUSTED_GIT_NOT_FOUND' }
if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'INVALID_COMMIT_SHA' }
if (-not (Test-Path -LiteralPath $Repo -PathType Container)) { throw 'SOURCE_REPOSITORY_MISSING' }
$repoRoot = & $git -C $Repo rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw 'SOURCE_IS_NOT_GIT_REPOSITORY' }
$repoRoot = ([IO.Path]::GetFullPath($repoRoot.Trim())).TrimEnd([char]92)
$destinationFull = ([IO.Path]::GetFullPath($Destination)).TrimEnd([char]92)
$engineeringRoot = 'C:\Engineering'
if (-not $destinationFull.StartsWith($engineeringRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'DESTINATION_MUST_BE_UNDER_C_ENGINEERING' }
if ($destinationFull -ieq $repoRoot -or $destinationFull.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'DESTINATION_INSIDE_SOURCE_REPOSITORY_DENIED' }
if ($destinationFull -match '(?i)production|pr102|recovery-install|17381|17382' -or (Test-Path -LiteralPath $destinationFull)) { throw 'DESTINATION_EXISTS_OR_IS_PROTECTED' }
$branch = (& $git -C $repoRoot symbolic-ref --short HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'platform/ai-windows-control-release-20261114') { throw "UNEXPECTED_SOURCE_BRANCH: $branch" }
& $git -C $repoRoot cat-file -e "$Commit^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Output 'PR113_COMMIT_NOT_PRESENT_OFFLINE'
  Write-Output ('Expected SHA: ' + $Commit)
  Write-Output 'No changes made. Obtain exact source via approved authenticated transfer.'
  return
}
& $git -C $repoRoot worktree add --detach -- $destinationFull $Commit
if ($LASTEXITCODE -ne 0) { throw 'WORKTREE_ADD_FAILED' }
$actual = (& $git -C $destinationFull rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -cne $Commit) { throw 'WORKTREE_SHA_MISMATCH' }
$originalBranch = (& $git -C $repoRoot symbolic-ref --short HEAD).Trim()
if ($originalBranch -ne $branch) { throw 'SOURCE_BRANCH_CHANGED_UNEXPECTEDLY' }
Write-Output ('PR113_ISOLATED_WORKTREE_READY: ' + $destinationFull)
Write-Output ('COMMIT: ' + $actual)
Write-Output ('SOURCE_BRANCH_UNCHANGED: ' + $originalBranch)
