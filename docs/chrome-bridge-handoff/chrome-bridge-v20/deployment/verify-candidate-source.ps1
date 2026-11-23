# Fail-closed verification for source trees used by PR102 Lab deployment scripts.
# Checks the exact Git commit, all tracked changes, untracked files and ignored files
# under deployment input paths before any candidate bytes are staged.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Invoke-BridgeCandidateGit {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$CandidateRoot,
    [Parameter(Mandatory=$true)][string[]]$Arguments
  )
  $gitExe='C:\Program Files\Git\cmd\git.exe'
  if (-not (Test-Path -LiteralPath $gitExe -PathType Leaf)) {
    throw 'TRUSTED_GIT_NOT_FOUND'
  }
  $global:LASTEXITCODE=0
  $output=@(& $gitExe -C $CandidateRoot @Arguments 2>&1)
  $exitCode=$global:LASTEXITCODE
  if ($exitCode -ne 0) {
    throw ('CANDIDATE_GIT_QUERY_FAILED ('+$exitCode+'): '+(($output|Out-String).Trim()))
  }
  return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

function Assert-BridgeCandidateSource {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$CandidateRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedSourceSha,
    [Parameter(Mandatory=$true)][string[]]$InputPaths
  )
  if (-not (Test-Path -LiteralPath $CandidateRoot -PathType Container)) {
    throw 'CANDIDATE_ROOT_NOT_FOUND'
  }
  if (@($InputPaths).Count -eq 0) { throw 'CANDIDATE_INPUT_PATHS_EMPTY' }
  foreach ($path in $InputPaths) {
    if ([string]::IsNullOrWhiteSpace($path) -or $path.StartsWith('/') -or
        $path -match '(^|[\\/])\.\.([\\/]|$)' -or $path.Contains(':')) {
      throw 'CANDIDATE_INPUT_PATH_UNSAFE'
    }
  }

  $actualSha=Invoke-BridgeCandidateGit -CandidateRoot $CandidateRoot -Arguments @('rev-parse','HEAD')
  if ($actualSha -cne $ExpectedSourceSha.ToLowerInvariant()) {
    throw ('CANDIDATE_SHA_MISMATCH: '+$actualSha)
  }

  $dirty=Invoke-BridgeCandidateGit -CandidateRoot $CandidateRoot -Arguments @('status','--porcelain=v1','--untracked-files=all')
  if (-not [string]::IsNullOrWhiteSpace($dirty)) {
    throw 'CANDIDATE_WORKTREE_NOT_CLEAN'
  }

  # Git status intentionally omits ignored files. These directories are copied by
  # the updater, so an ignored node_modules/config/archive must also fail closed.
  $ignoredArgs=@('ls-files','--others','--ignored','--exclude-standard','--') + @($InputPaths)
  $ignored=Invoke-BridgeCandidateGit -CandidateRoot $CandidateRoot -Arguments $ignoredArgs
  if (-not [string]::IsNullOrWhiteSpace($ignored)) {
    throw 'CANDIDATE_IGNORED_FILES_PRESENT'
  }

  $trackedArgs=@('ls-files','--error-unmatch','--') + @($InputPaths)
  $tracked=Invoke-BridgeCandidateGit -CandidateRoot $CandidateRoot -Arguments $trackedArgs
  if ([string]::IsNullOrWhiteSpace($tracked)) {
    throw 'CANDIDATE_INPUTS_NOT_TRACKED'
  }
  return $actualSha
}
