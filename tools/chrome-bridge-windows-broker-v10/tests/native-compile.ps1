$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'vswhere.exe missing on Windows CI image' }
$vs = & $vswhere -latest -products '*' -property installationPath
if (-not $vs) { throw 'Visual Studio C++ toolchain missing' }
Import-Module (Join-Path $vs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $vs -DevCmdArguments '-arch=x64' -ErrorAction Stop | Out-Null
$out = Join-Path $env:RUNNER_TEMP 'chrome-bridge-image-inspector.exe'
$fixture = Join-Path $env:RUNNER_TEMP 'unsigned-inspector-fixture.bin'
$null = Set-Content -LiteralPath $fixture -Value 'synthetic unsigned fixture' -NoNewline
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NativeFinalPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder p, uint n, uint flags);
}
'@
try {
  & cl.exe /nologo /std:c++17 /EHsc /W4 /WX /DUNICODE /D_UNICODE /Fe:$out .\native\image_inspector.cpp
  if ($LASTEXITCODE -ne 0) { throw "MSVC compile failed: $LASTEXITCODE" }
  $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $fs = [System.IO.File]::Open($fixture, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
  try {
    $pathBuffer = [System.Text.StringBuilder]::new(32768)
    $pathLength = [NativeFinalPath]::GetFinalPathNameByHandleW($fs.SafeFileHandle, $pathBuffer, 32768, 1)
    if ($pathLength -eq 0 -or $pathLength -ge 32768) { throw 'Could not obtain volume GUID path for negative probe' }
    $finalPath = $pathBuffer.ToString()
  } finally { $fs.Dispose() }
  $zeroPin = '0' * 64
  $json = & $out $fixture $zeroPin $zeroPin $ownerSid $finalPath 2>$null
  $exit = $LASTEXITCODE
  if ($exit -ne 10) { throw "Unsigned/wrong-pin candidate expected fail-closed exit 10, got $exit" }
  $report = $json | ConvertFrom-Json
  if ($report.executionAuthorized -ne $false -or $report.authenticodeTrusted -ne $false -or $report.sha256PinMatches -ne $false) {
    throw 'Negative probe unexpectedly reported trusted or authorized execution'
  }
  Write-Host 'PASS: native source compiled and synthetic unsigned fixture was rejected; no child process launched.'
} finally {
  Remove-Item -LiteralPath $fixture -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $PWD 'image_inspector.obj') -Force -ErrorAction SilentlyContinue
}
