$ErrorActionPreference = 'Stop'
$vc = 'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/VC/Tools/MSVC/14.51.36231'
$sdk = 'C:/Program Files (x86)/Windows Kits/10'
$version = '10.0.26100.0'
$env:PATH = "$vc/bin/Hostx64/x64;$env:PATH"
$env:INCLUDE = "$vc/include;$sdk/Include/$version/ucrt;$sdk/Include/$version/shared;$sdk/Include/$version/um"
$env:LIB = "$vc/lib/x64;$sdk/Lib/$version/ucrt/x64;$sdk/Lib/$version/um/x64"
Push-Location $PSScriptRoot
try {
    & "$vc/bin/Hostx64/x64/cl.exe" /nologo /std:c++17 /EHsc /W4 /MT /DUNICODE /D_UNICODE broker.cpp /Fe:broker.exe
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
    & "$vc/bin/Hostx64/x64/cl.exe" /nologo /W4 /O1 /GS- /DUNICODE /D_UNICODE worker.c /Fe:worker.exe /Fo:worker.obj /link /NODEFAULTLIB /ENTRY:entry /SUBSYSTEM:WINDOWS kernel32.lib
    if ($LASTEXITCODE -ne 0) { throw "Probe build failed: $LASTEXITCODE" }
} finally { Pop-Location }



