param([string]$AutoCADDir = 'C:\Program Files\Autodesk\AutoCAD 2026')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = Join-Path $root 'validation_v041'
New-Item -ItemType Directory -Path $out -Force | Out-Null
& python -m unittest discover -s (Join-Path $root 'tests') -v 2>&1 | Out-File (Join-Path $out 'python-tests.log')
if ($LASTEXITCODE -ne 0) { throw 'Python tests failed' }
foreach ($dll in @('AcCoreMgd.dll','AcDbMgd.dll','AcMgd.dll')) {
    if (-not (Test-Path (Join-Path $AutoCADDir $dll))) { throw "Missing AutoCAD DLL: $dll" }
}
& dotnet build (Join-Path $root 'autocad\NssEngine.Export.csproj') -c Release "-p:AutoCADDir=$AutoCADDir" --nologo 2>&1 | Out-File (Join-Path $out 'dotnet-build.log')
if ($LASTEXITCODE -ne 0) { throw 'Build failed; inspect validation_v041\dotnet-build.log' }
Write-Host 'Build succeeded. Use NETLOAD with the generated DLL, then NSS_VALIDATE_V041.'
