param(
    [string]$AutoCADDir = 'C:\Program Files\Autodesk\AutoCAD 2026',
    [string]$OutputDir = '',
    [switch]$SkipPythonTests
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDir) { $OutputDir = Join-Path $root 'validation_v038' }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$started = (Get-Date).ToUniversalTime().ToString('o')
$results = [ordered]@{ version='0.38'; started_utc=$started; autocad_dir=$AutoCADDir; dotnet=''; references=@(); python_tests='not_run'; build='not_run'; dll=''; issues=@() }
try {
    $dotnetCmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if (-not $dotnetCmd) { throw 'dotnet not found. Install .NET 8 SDK.' }
    $results.dotnet = (& dotnet --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'dotnet --version failed' }
    foreach ($name in @('AcCoreMgd.dll','AcDbMgd.dll','AcMgd.dll')) {
        $path = Join-Path $AutoCADDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing AutoCAD reference: $path" }
        $results.references += $path
    }
    if (-not $SkipPythonTests) {
        $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
        if (-not $pythonCmd) { $results.python_tests='skipped_python_missing' }
        else {
            & python -m unittest discover -s (Join-Path $root 'tests') -v 2>&1 | Out-File -FilePath (Join-Path $OutputDir 'python-tests.log') -Encoding utf8
            if ($LASTEXITCODE -ne 0) { $results.python_tests='failed'; throw 'Python tests failed' }
            $results.python_tests='passed'
        }
    }
    $project = Join-Path $root 'autocad\NssEngine.Export.csproj'
    $buildLog = Join-Path $OutputDir 'dotnet-build.log'
    & dotnet build $project -c Release "-p:AutoCADDir=$AutoCADDir" --nologo 2>&1 | Out-File -FilePath $buildLog -Encoding utf8
    if ($LASTEXITCODE -ne 0) { $results.build='failed'; throw "Build failed. Inspect $buildLog" }
    $results.build='passed'
    $dll = Join-Path $root 'autocad\bin\Release\net8.0-windows\NssEngine.Export.dll'
    if (-not (Test-Path -LiteralPath $dll)) { throw 'Build succeeded but expected DLL missing' }
    $results.dll = $dll
    Get-FileHash -LiteralPath $dll -Algorithm SHA256 | Select-Object Path,Hash | ConvertTo-Json | Set-Content -Path (Join-Path $OutputDir 'dll-sha256.json') -Encoding utf8
}
catch { $results.issues += $_.Exception.Message }
finally {
    $results.completed_utc = (Get-Date).ToUniversalTime().ToString('o')
    $results | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $OutputDir 'build-validation.json') -Encoding utf8
    Write-Host "Validation results: $(Join-Path $OutputDir 'build-validation.json')"
}
if ($results.issues.Count -gt 0) { exit 1 }
