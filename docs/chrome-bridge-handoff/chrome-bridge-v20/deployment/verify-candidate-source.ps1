# Fail-closed verification for source trees used by PR102 Lab deployment scripts.
# Checks the exact Git commit, all tracked changes, untracked files and ignored files
# under deployment input paths before any candidate bytes are staged.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Quote-BridgeGitArgument([string]$Value) {
  $builder=New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes=0
  foreach($character in $Value.ToCharArray()){
    if($character -eq [char]'\'){$backslashes++;continue}
    if($character -eq [char]'"'){
      if($backslashes -gt 0){[void]$builder.Append(('\' * ($backslashes*2)))}
      [void]$builder.Append('\"')
      $backslashes=0
      continue
    }
    if($backslashes -gt 0){[void]$builder.Append(('\' * $backslashes));$backslashes=0}
    [void]$builder.Append($character)
  }
  if($backslashes -gt 0){[void]$builder.Append(('\' * ($backslashes*2)))}
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Invoke-BridgeCandidateGit {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$CandidateRoot,
    [Parameter(Mandatory=$true)][string[]]$GitArgList
  )
  $gitExe='C:\Program Files\Git\cmd\git.exe'
  if (-not (Test-Path -LiteralPath $gitExe -PathType Leaf)) {
    throw 'TRUSTED_GIT_NOT_FOUND'
  }
  $allArguments=@('-C',$CandidateRoot)+$GitArgList
  $quotedArguments=@($allArguments|ForEach-Object { Quote-BridgeGitArgument ([string]$_) })
  $startInfo=New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName=$gitExe
  $startInfo.WorkingDirectory=$CandidateRoot
  $startInfo.Arguments=[string]::Join(' ',$quotedArguments)
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $startInfo.RedirectStandardOutput=$true
  $startInfo.RedirectStandardError=$true
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$startInfo
  try {
    if(-not $process.Start()){throw 'CANDIDATE_GIT_START_FAILED'}
    $stdoutTask=$process.StandardOutput.ReadToEndAsync()
    $stderrTask=$process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout=$stdoutTask.GetAwaiter().GetResult()
    $stderr=$stderrTask.GetAwaiter().GetResult()
    $exitCode=$process.ExitCode
  } finally {
    $process.Dispose()
  }
  if($exitCode -ne 0) {
    $detail=$stderr.Trim()
    if([string]::IsNullOrWhiteSpace($detail)){$detail=$stdout.Trim()}
    throw ('CANDIDATE_GIT_QUERY_FAILED ('+$exitCode+'): '+$detail)
  }
  return ([string]$stdout).Trim()
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
        $path -match '(^|[\\\\/])\\.\\.([\\\\/]|$)' -or $path.Contains(':')) {
      throw 'CANDIDATE_INPUT_PATH_UNSAFE'
    }
  }

  $actualSha=Invoke-BridgeCandidateGit -CandidateRoot $CandidateRoot -GitArgList @('rev-parse','HEAD')
  if ($actualSha -cne $ExpectedSourceSha.ToLowerInvariant()) {
    throw ('CANDIDATE_SHA_MISMATCH: '+$actualSha)
  }

  $dirtyArgs=@('status','--porcelain=v1','--untracked-files=all','--') + @($InputPaths)
  $dirty=Invoke-BridgeCandidateGit -CandidateRoot $CandidateRoot -GitArgList $dirtyArgs
  if (-not [string]::IsNullOrWhiteSpace($dirty)) {
    throw ('CANDIDATE_WORKTREE_NOT_CLEAN: '+$dirty)
  }

  # Git status intentionally omits ignored files. These directories are copied by
  # the updater, so an ignored node_modules/config/archive must also fail closed.
  $ignoredArgs=@('ls-files','--others','--ignored','--exclude-standard','--') + @($InputPaths)
  $ignored=Invoke-BridgeCandidateGit -CandidateRoot $CandidateRoot -GitArgList $ignoredArgs
  if (-not [string]::IsNullOrWhiteSpace($ignored)) {
    throw 'CANDIDATE_IGNORED_FILES_PRESENT'
  }

  $trackedArgs=@('ls-files','--error-unmatch','--') + @($InputPaths)
  $tracked=Invoke-BridgeCandidateGit -CandidateRoot $CandidateRoot -GitArgList $trackedArgs
  if ([string]::IsNullOrWhiteSpace($tracked)) {
    throw 'CANDIDATE_INPUTS_NOT_TRACKED'
  }
  return $actualSha
}
