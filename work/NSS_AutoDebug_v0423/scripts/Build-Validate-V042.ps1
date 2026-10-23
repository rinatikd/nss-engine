param([string]$AutoCADDir = 'C:\Program Files\Autodesk\AutoCAD 2026')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $root 'runtime\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }
& $python -X utf8 (Join-Path $PSScriptRoot 'build_validate_v042.py') --autocad-dir $AutoCADDir
if ($LASTEXITCODE -ne 0) { throw "Offline verification failed: $LASTEXITCODE" }
