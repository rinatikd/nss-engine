$ErrorActionPreference = 'Stop'
$compiler = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $compiler) {
  Write-Error 'BLOCKED: cl.exe is unavailable; run from a Visual Studio Developer PowerShell in a disposable Windows test VM.'
  exit 3
}
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $env:TEMP ('cb-v12-native-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $out | Out-Null
try {
  Push-Location $out
  $launcherExe = Join-Path $out 'test_launcher.exe'
  $workerExe = Join-Path $out 'synthetic_worker.exe'
  & $compiler.Source /nologo /std:c++17 /EHsc /W4 /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A `
    (Join-Path $root 'native\test_launcher.cpp') "/Fe:$launcherExe" `
    wintrust.lib bcrypt.lib advapi32.lib userenv.lib ole32.lib
  if ($LASTEXITCODE -ne 0) { throw "launcher compile failed: $LASTEXITCODE" }
  & $compiler.Source /nologo /std:c++17 /EHsc /W4 /D_WIN32_WINNT=0x0A00 `
    (Join-Path $root 'native\synthetic_worker.cpp') "/Fe:$workerExe" ws2_32.lib
  if ($LASTEXITCODE -ne 0) { throw "worker compile failed: $LASTEXITCODE" }
  Write-Host 'PASS: native source compiled. Neither binary was executed.'
} finally {
  Pop-Location
  Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue
}
