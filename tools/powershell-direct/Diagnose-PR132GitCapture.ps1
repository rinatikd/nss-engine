# Read-only diagnostic for the PR132 candidate Git-output capture discrepancy.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedWorkspace = 'C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$checkoutRoot = Join-Path $expectedWorkspace 'work\ChromeBridge-PR132-fb2c27a8'
$git = 'C:\Program Files\Git\cmd\git.exe'

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
if ($workspace -ine $expectedWorkspace) { throw 'UNEXPECTED_APPROVED_WORKSPACE' }
if (!(Test-Path -LiteralPath $git -PathType Leaf)) { throw 'TRUSTED_GIT_NOT_FOUND' }

$gitDir = Join-Path $checkoutRoot '.git'
# .git may be a hidden directory or a file (worktree pointer). Use .NET
# existence checks and never let an optional metadata probe abort diagnostics.
$checkoutExists = [System.IO.Directory]::Exists($checkoutRoot)
$gitDirDirectoryExists = [System.IO.Directory]::Exists($gitDir)
$gitDirFileExists = [System.IO.File]::Exists($gitDir)
$gitDirExists = $gitDirDirectoryExists -or $gitDirFileExists
$gitDirItemType = if ($gitDirDirectoryExists) { 'Directory' } elseif ($gitDirFileExists) { 'File' } else { 'Missing' }

function Invoke-GitProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string[]]$GitArguments
    )
    $global:LASTEXITCODE = 0
    $captured = @(& $git @GitArguments 2>&1)
    $exitCode = $global:LASTEXITCODE
    $lines = @($captured | ForEach-Object { [string]$_ })
    [pscustomobject]@{
        Label = $Label
        ExitCode = $exitCode
        OutputCount = $lines.Count
        Output = @($lines)
    }
}

$results = @()
$results += Invoke-GitProbe -Label 'git-version' -GitArguments @('--version')
if ($checkoutExists) {
    $results += Invoke-GitProbe -Label 'direct-rev-parse' -GitArguments @('-C', $checkoutRoot, 'rev-parse', '--verify', 'HEAD')
    $results += Invoke-GitProbe -Label 'direct-branch' -GitArguments @('-C', $checkoutRoot, 'branch', '--show-current')
    $results += Invoke-GitProbe -Label 'direct-status' -GitArguments @('-C', $checkoutRoot, 'status', '--porcelain=v1', '--untracked-files=all')
}

function Git([string[]]$Arguments) {
    $global:LASTEXITCODE = 0
    $gitLines = @(& $git -c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never @Arguments 2>&1)
    $exitCode = $global:LASTEXITCODE
    if ($exitCode -ne 0) { throw ('GIT_OPERATION_FAILED (' + $exitCode + '): ' + (($gitLines | Out-String).Trim())) }
    $gitText = [string]::Join([Environment]::NewLine, [string[]]@($gitLines | ForEach-Object { [string]$_ }))
    return $gitText
}

$wrapperOutput = $null
$wrapperError = $null
$wrapperExitCode = $null
if ($checkoutExists) {
    try {
        $wrapperOutput = (Git -Arguments @('-C', $checkoutRoot, 'rev-parse', '--verify', 'HEAD') | Out-String).Trim()
        $wrapperExitCode = $global:LASTEXITCODE
    } catch {
        $wrapperError = $_.Exception.Message
        $wrapperExitCode = $global:LASTEXITCODE
    }
}

$command = Get-Command Git -All -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ Name = $_.Name; CommandType = [string]$_.CommandType; Source = [string]$_.Source }
}
$envPresence = @{}
foreach ($name in @('GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_CEILING_DIRECTORIES')) {
    $envPresence[$name] = -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))
}

[pscustomobject]@{
    Result = 'PR132_GIT_CAPTURE_DIAGNOSTIC'
    PowerShellVersion = $PSVersionTable.PSVersion.ToString()
    Workspace = $workspace
    CheckoutExists = $checkoutExists
    GitDirectoryExists = $gitDirExists
    GitDirectoryItemType = $gitDirItemType
    GitCommandResolution = @($command)
    GitEnvironmentOverridesPresent = $envPresence
    DirectAndVersionProbes = @($results)
    ExistingWrapperOutput = $wrapperOutput
    ExistingWrapperError = $wrapperError
    ExistingWrapperLastExitCode = $wrapperExitCode
    NoFilesWritten = $true
    LabChanged = $false
    ProductionChanged = $false
    CredentialsRead = $false
} | ConvertTo-Json -Depth 6
