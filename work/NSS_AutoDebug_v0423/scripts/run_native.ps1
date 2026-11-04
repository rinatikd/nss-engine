# NSS AutoDebug v0.42.3 native-runner entry point.
# Default: prepare artifacts only; NEVER launches AutoCAD unless explicitly requested.
[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'InHost', 'DesktopHost')]
    [string]$Mode = 'Prepare',
    [ValidateRange(1, 3600)]
    [int]$TimeoutSeconds = 600,
    [string]$AutoCADDirectory = 'C:\Program Files\Autodesk\AutoCAD 2026',
    [switch]$UsePrebuilt
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
            Write-Host 'PREPARE ONLY: AutoCAD will not be launched.'
        }
        'InHost' {
            $arguments += '--in-host'
            Write-Host 'IN-HOST: waiting for manual RUN_IN_AUTOCAD.lsp load in an existing AutoCAD session.'
            Write-Host 'This script does not launch AutoCAD.'
        }
        'DesktopHost' {
            if (-not (Test-Path -LiteralPath (Join-Path $AutoCADDirectory 'acad.exe') -PathType Leaf)) {
                throw "acad.exe not found in $AutoCADDirectory"
            }
            Write-Warning 'DesktopHost EXPLICITLY launches acad.exe. This is not a verified headless/console run.'
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
        Write-Error "NSS AutoDebug returned exit code $exitCode. Review the reported Runs directory." -ErrorAction Continue
    }
    exit $exitCode
}
catch {
    Write-Error $_
    exit 2
}
