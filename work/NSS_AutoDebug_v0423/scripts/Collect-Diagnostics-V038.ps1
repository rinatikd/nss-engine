param([string]$OutputZip = '')
$ErrorActionPreference = 'Stop'
$dir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'NSS_Engine'
if (-not $OutputZip) { $OutputZip = Join-Path $dir 'NSS_diagnostics_v038.zip' }
if (-not (Test-Path -LiteralPath $dir)) { throw "No diagnostics folder: $dir" }
$names = @('runtime_v035.jsonl','diagnostics_v036.json','NSS_health_v034.json','build-validation.json')
$staging = Join-Path $env:TEMP ('nss_v038_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    foreach ($name in $names) {
        $path = Join-Path $dir $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { Copy-Item -LiteralPath $path -Destination $staging }
    }
    if (-not (Get-ChildItem -LiteralPath $staging -File)) { throw 'No diagnostic files found' }
    if (Test-Path -LiteralPath $OutputZip) { Remove-Item -LiteralPath $OutputZip -Force }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $OutputZip
    Write-Host "Diagnostics ZIP: $OutputZip"
} finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
