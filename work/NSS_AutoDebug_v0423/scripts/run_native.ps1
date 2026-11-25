# NSS AutoDebug native-runner entry point. AutoCAD is never launched by default.
[CmdletBinding()]
param(
    [ValidateSet('Inspect', 'Prepare', 'InHost', 'DesktopHost')]
    [string]$Mode = 'Inspect',
    [ValidateRange(1, 3600)]
    [int]$TimeoutSeconds = 600,
    [string]$AutoCADDirectory = 'C:\Program Files\Autodesk\AutoCAD 2026',
    [switch]$UsePrebuilt,
    [switch]$AllowAutoCADLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$driver = Join-Path $projectRoot 'scripts\autodebug_v0421.py'
$embeddedPython = Join-Path $projectRoot 'runtime\python.exe'

try {
    if (-not (Test-Path -LiteralPath $driver -PathType Leaf)) {
        throw "Missing AutoDebug driver: $driver"
    }
    if ($Mode -eq 'Inspect') {
        Write-Host 'INSPECT PASSED: driver exists; no tests, files, or AutoCAD processes were started.'
        Write-Host "Driver: $driver"
        exit 0
    }
    if ($Mode -eq 'DesktopHost' -and -not $AllowAutoCADLaunch) {
        throw 'DesktopHost requires explicit -AllowAutoCADLaunch. This is an interactive acad.exe launch, NOT headless.'
    }
    if ($Mode -eq 'DesktopHost') {
        if (-not (Test-Path -LiteralPath (Join-Path $AutoCADDirectory 'acad.exe') -PathType Leaf)) {
            throw "acad.exe not found in $AutoCADDirectory"
        }
    }

    $python = $null
    if (Test-Path -LiteralPath $embeddedPython -PathType Leaf) {
        $python = $embeddedPython
    } else {
        $command = Get-Command python -ErrorAction SilentlyContinue
        if ($null -ne $command) { $python = $command.Source }
    }
    if (-not $python) { throw 'Python not found (runtime/python.exe or python on PATH).' }

    $arguments = @('-E', '-s', '-X', 'utf8', $driver,
        '--autocad-dir', $AutoCADDirectory, '--timeout', [string]$TimeoutSeconds)
    if ($UsePrebuilt) { $arguments += '--use-prebuilt' }

    switch ($Mode) {
        'Prepare' {
            $arguments += '--prepare'
            Write-Host 'PREPARE ONLY: Python offline checks/build may write Runs; AutoCAD will not launch.'
        }
        'InHost' {
            $arguments += '--in-host'
            Write-Host 'IN-HOST: prepares a loader and waits for MANUAL RUN_IN_AUTOCAD.lsp execution.'
            Write-Host 'This script does not launch AutoCAD.'
        }
        'DesktopHost' {
            Write-Warning 'Explicit launch of acad.exe requested; headless behavior has NOT been verified.'
        }
    }

    Push-Location -LiteralPath $projectRoot
    try {
        & $python @arguments
        $exitCode = $LASTEXITCODE
    }
    finally { Pop-Location }

    if ($null -eq $exitCode) { throw 'Python process did not return an exit code.' }
    if ($exitCode -ne 0) {
        Write-Warning "NSS AutoDebug exit $exitCode. Review the run-specific diagnostics."
    }
    exit $exitCode
}
catch {
    Write-Error -Message ($_ | Out-String) -ErrorAction Continue
    exit 2
}
