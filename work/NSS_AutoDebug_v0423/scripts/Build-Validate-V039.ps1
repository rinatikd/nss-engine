param(
    [string]$AutoCADDir = 'C:\Program Files\Autodesk\AutoCAD 2026',
    [string]$OutputDir = ''
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDir) { $OutputDir = Join-Path $root 'validation_v039' }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$result = [ordered]@{ version='0.39'; dotnet='not_run'; python='not_run'; build='not_run'; dll=''; errors=@() }
try {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python not found' }
    & python -m unittest discover -s (Join-Path $root 'tests') -v *> (Join-Path $OutputDir 'python-tests.log')
    if ($LASTEXITCODE -ne 0) { throw 'Python tests failed; inspect python-tests.log' }
    $result.python='passed'
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET SDK not found' }
    $result.dotnet = (& dotnet --version | Out-String).Trim()
    foreach ($ref in @('AcCoreMgd.dll','AcDbMgd.dll','AcMgd.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $AutoCADDir $ref) -PathType Leaf)) { throw "Missing AutoCAD DLL: $ref" }
    }
    & dotnet build (Join-Path $root 'autocad\NssEngine.Export.csproj') -c Release "-p:AutoCADDir=$AutoCADDir" --nologo *> (Join-Path $OutputDir 'dotnet-build.log')
    if ($LASTEXITCODE -ne 0) { $result.build='failed'; throw 'Build failed; inspect dotnet-build.log' }
    $dll = Join-Path $root 'autocad\bin\Release\net8.0-windows\NssEngine.Export.dll'
    if (-not (Test-Path -LiteralPath $dll)) { throw 'DLL missing after build' }
    $result.build='passed'; $result.dll=$dll
    Get-FileHash -LiteralPath $dll -Algorithm SHA256 | Select-Object Path,Hash | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir 'dll-sha256.json')
} catch { $result.errors += $_.Exception.Message }
finally {
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'validation.json') -Encoding utf8
    Write-Host "Results: $(Join-Path $OutputDir 'validation.json')"
}
if ($result.errors.Count) { exit 1 }
