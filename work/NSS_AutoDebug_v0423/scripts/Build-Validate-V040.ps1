param(
    [string]$AutoCADDir = 'C:\Program Files\Autodesk\AutoCAD 2026',
    [string]$OutputDir = ''
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDir) { $OutputDir = Join-Path $root 'validation_v040' }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$result = [ordered]@{version='0.40'; python='not_run'; dotnet='not_run'; build='not_run'; runtime='not_tested'; dll=''; errors=@()}
try {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python missing' }
    Push-Location $root
    try { & python -m unittest discover -s tests -v *> (Join-Path $OutputDir 'python-tests.log') }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Python tests failed' }
    $result.python='passed'
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET SDK missing' }
    $result.dotnet=(& dotnet --version | Out-String).Trim()
    foreach ($name in @('AcCoreMgd.dll','AcDbMgd.dll','AcMgd.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $AutoCADDir $name) -PathType Leaf)) { throw "Missing AutoCAD assembly: $name" }
    }
    & dotnet build (Join-Path $root 'autocad\NssEngine.Export.csproj') -c Release "-p:AutoCADDir=$AutoCADDir" --nologo *> (Join-Path $OutputDir 'dotnet-build.log')
    if ($LASTEXITCODE -ne 0) { $result.build='failed'; throw 'Compilation failed' }
    $dll=Join-Path $root 'autocad\bin\Release\net8.0-windows\NssEngine.Export.dll'
    if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) { throw 'Expected DLL not found' }
    $result.build='passed'; $result.dll=$dll
    Get-FileHash -LiteralPath $dll -Algorithm SHA256 | Select-Object Path,Hash | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir 'dll-sha256.json') -Encoding UTF8
} catch { $result.errors += $_.Exception.Message }
finally {
    $log=Join-Path $OutputDir 'dotnet-build.log'
    if (Test-Path -LiteralPath $log) {
        Push-Location $root
        try { & python -m nss_engine.build_diagnostics_v040 --log $log --output (Join-Path $OutputDir 'build-diagnostics.json') }
        finally { Pop-Location }
    }
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'validation.json') -Encoding UTF8
    Write-Host "Results: $OutputDir"
}
if ($result.errors.Count -gt 0) { exit 1 }
