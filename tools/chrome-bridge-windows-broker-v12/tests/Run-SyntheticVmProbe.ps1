[CmdletBinding()]
param([Parameter(Mandatory = $true)][switch]$DisposableVmAcknowledged)

$ErrorActionPreference = 'Stop'
if (-not $DisposableVmAcknowledged -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'BLOCKED: this probe is restricted to an explicitly acknowledged disposable hosted Windows runner.'
}

$package = Split-Path -Parent $PSScriptRoot
$native = Join-Path $package 'native'
$tempBase = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
$tempRoot = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP ('cb-v12-synthetic-' + [guid]::NewGuid().ToString('N'))))
if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'TEMP_PATH_BOUNDARY_FAILED'
}
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null

$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$listener = $null
$certificate = $null
$canary = Join-Path $tempRoot 'synthetic-canary.bin'
$worker = Join-Path $tempRoot 'synthetic_worker.exe'
$launcher = Join-Path $tempRoot 'test_launcher.exe'
$pinPaths = @((Join-Path $native 'worker_test_pins.h'), (Join-Path $native 'test_pins.h'))
$port = 47231
$exitCode = 99
$networkAccepted = $false
$canaryBefore = $null
$canaryAfter = $null

try {
    Write-Host 'PROBE_STAGE=prepare-canary'
    $env:TEMP = $tempRoot
    $env:TMP = $tempRoot
    [IO.File]::WriteAllBytes($canary, [Text.Encoding]::UTF8.GetBytes('synthetic-only-' + [guid]::NewGuid().ToString('N')))
    $canaryBefore = (Get-FileHash -LiteralPath $canary -Algorithm SHA256).Hash.ToLowerInvariant()

    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $sddl = 'O:{0}D:P(A;;FA;;;{0})(A;;FA;;;SY)' -f $ownerSid.Value
    $canaryAcl = New-Object Security.AccessControl.FileSecurity
    $canaryAcl.SetSecurityDescriptorSddlForm($sddl)
    Set-Acl -LiteralPath $canary -AclObject $canaryAcl
    $observedAcl = Get-Acl -LiteralPath $canary
    $rules = @($observedAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $observedAcl.AreAccessRulesProtected -or $rules.Count -ne 2 -or
        @($rules | Where-Object { $_.IdentityReference.Value -notin @($ownerSid.Value, 'S-1-5-18') -or $_.IsInherited -or $_.AccessControlType -ne 'Allow' }).Count -ne 0) {
        throw 'SYNTHETIC_CANARY_ACL_INVALID'
    }

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    $listener.Start()

    Write-Host 'PROBE_STAGE=compile-worker'
    & (Join-Path $PSScriptRoot 'Write-WorkerTestPins.ps1') -SyntheticCredentialPath $canary -LoopbackPort $port -OperatorConfirmedDisposableVm
    if (-not $?) { throw 'WORKER_PINS_FAILED' }

    $vsCompiler = (Get-Command cl.exe -ErrorAction Stop).Source
    Push-Location $tempRoot
    try {
        & $vsCompiler /nologo /std:c++17 /EHsc /W4 /D_WIN32_WINNT=0x0A00 (Join-Path $native 'synthetic_worker.cpp') "/Fe:$worker" ws2_32.lib
        if ($LASTEXITCODE -ne 0) { throw "WORKER_COMPILE_FAILED:$LASTEXITCODE" }
    } finally { Pop-Location }

    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=ChromeBridge disposable synthetic worker' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddHours(2)
    $rootCer = Join-Path $tempRoot 'synthetic-test-root.cer'
    Export-Certificate -Cert $certificate -FilePath $rootCer -Force | Out-Null
    Import-Certificate -FilePath $rootCer -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
    $signature = Set-AuthenticodeSignature -FilePath $worker -Certificate $certificate -HashAlgorithm SHA256
    if ($signature.Status -ne 'Valid') { throw 'SYNTHETIC_SIGNATURE_INVALID' }

    Write-Host 'PROBE_STAGE=prepare-launcher-pins'
    & (Join-Path $PSScriptRoot 'Prepare-DisposablePins.ps1') -WorkerPath $worker -SignerThumbprint $certificate.Thumbprint -SyntheticCredentialPath $canary -LoopbackPort $port -OperatorConfirmedDisposableVm
    if (-not $?) { throw 'LAUNCHER_PINS_FAILED' }

    Push-Location $tempRoot
    try {
        & $vsCompiler /nologo /std:c++17 /EHsc /W4 /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A /DCHROME_BRIDGE_V12_DISPOSABLE_VM_BUILD (Join-Path $native 'test_launcher.cpp') "/Fe:$launcher" wintrust.lib bcrypt.lib advapi32.lib userenv.lib ole32.lib
        if ($LASTEXITCODE -ne 0) { throw "LAUNCHER_COMPILE_FAILED:$LASTEXITCODE" }
    } finally { Pop-Location }

    Write-Host 'PROBE_STAGE=launch-synthetic-only'
    $startInfo = [Diagnostics.ProcessStartInfo]::new($launcher)
    $startInfo.WorkingDirectory = $tempRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $probeProcess = [Diagnostics.Process]::Start($startInfo)
    if (-not $probeProcess.WaitForExit(70000)) {
        $probeProcess.Kill()
        [void]$probeProcess.WaitForExit(10000)
        throw 'SYNTHETIC_LAUNCHER_WATCHDOG_TIMEOUT'
    }
    $exitCode = $probeProcess.ExitCode
    $networkAccepted = $listener.Pending()
    $canaryAfter = (Get-FileHash -LiteralPath $canary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($exitCode -ne 0 -or $networkAccepted -or $canaryBefore -ne $canaryAfter) {
        throw 'SYNTHETIC_VM_PROBE_FAILED'
    }
    [pscustomobject]@{ status = 'PASS_SYNTHETIC_ONLY'; launcherExitCode = $exitCode; canaryUnchanged = $true; canaryAclProtected = $true; loopbackListenerSawNoConnection = $true; codexLaunched = $false; independentHostAttestation = $false } | ConvertTo-Json -Compress
} finally {
    if ($listener) { $listener.Stop() }
    if ($certificate) {
        Remove-Item -LiteralPath (Join-Path 'Cert:\CurrentUser\My' $certificate.Thumbprint) -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path 'Cert:\CurrentUser\Root' $certificate.Thumbprint) -Force -ErrorAction SilentlyContinue
    }
    foreach ($pin in $pinPaths) { Remove-Item -LiteralPath $pin -Force -ErrorAction SilentlyContinue }
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
    if ([IO.Directory]::Exists($tempRoot) -and $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
