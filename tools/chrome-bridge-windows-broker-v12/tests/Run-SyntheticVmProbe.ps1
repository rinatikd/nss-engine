[CmdletBinding()]
param([Parameter(Mandatory = $true)][switch]$DisposableVmAcknowledged)

$ErrorActionPreference = 'Stop'
$ConfirmPreference = 'None'
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

function Write-ProbeStage([string]$Name) {
    $line = "$( [DateTime]::UtcNow.ToString('o') ) PROBE_STAGE=$Name"
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    if (-not [string]::IsNullOrWhiteSpace($env:CB_V12_PROBE_LOG)) {
        try {
            [IO.File]::AppendAllText($env:CB_V12_PROBE_LOG, "$line`r`n", [Text.UTF8Encoding]::new($false))
        } catch {
            # Diagnostics must never convert a failed probe into a pass or hide
            # the original failure; console output remains the primary log.
        }
    }
}

function Invoke-BoundedProcess([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [int]$TimeoutSec, [string]$Stage) {
    $psi = [Diagnostics.ProcessStartInfo]::new($Executable)
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    # Do not redirect compiler pipes: MSVC's vctip child can outlive cl.exe
    # and hold inherited pipe handles open, which would block ReadToEnd forever.
    $psi.CreateNoWindow = $false
    foreach ($argument in $Arguments) { $psi.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($psi)
    if (-not $process.WaitForExit($TimeoutSec * 1000)) {
        try { $process.Kill($true) } catch { }
        [void]$process.WaitForExit(10000)
        throw "${Stage}_WATCHDOG_TIMEOUT"
    }
    if ($process.ExitCode -ne 0) { throw "${Stage}_FAILED:$($process.ExitCode)" }
}

try {
    Write-ProbeStage 'probe-start'
    Write-ProbeStage 'prepare-canary'
    # Keep MSVC and certificate tooling on the runner's normal scratch path.
    # Probe outputs and fixtures remain explicitly pinned under $tempRoot.
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

    Write-ProbeStage 'generate-worker-pins'
    & (Join-Path $PSScriptRoot 'Write-WorkerTestPins.ps1') -SyntheticCredentialPath $canary -LoopbackPort $port -OperatorConfirmedDisposableVm
    if (-not $?) { throw 'WORKER_PINS_FAILED' }

    $vsCompiler = (Get-Command cl.exe -ErrorAction Stop).Source
    Write-ProbeStage 'compile-worker'
    Invoke-BoundedProcess $vsCompiler @('/nologo', '/std:c++17', '/EHsc', '/W4', '/D_WIN32_WINNT=0x0A00', (Join-Path $native 'synthetic_worker.cpp'), "/Fe:$worker", 'ws2_32.lib') $tempRoot 120 'WORKER_COMPILE'

    Write-ProbeStage 'create-ephemeral-certificate'
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=ChromeBridge disposable synthetic worker' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddHours(2)
    $publicCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificate.RawData)
    $rootCertificatePath = Join-Path $tempRoot 'synthetic-root.cer'
    [IO.File]::WriteAllBytes($rootCertificatePath, $publicCertificate.RawData)
    $certutil = (Get-Command certutil.exe -ErrorAction Stop).Source
    Write-ProbeStage 'install-ephemeral-root-with-bounded-certutil'
    Invoke-BoundedProcess $certutil @('-user', '-addstore', '-f', 'Root', $rootCertificatePath) $tempRoot 30 'ROOT_STORE_ADD'
    Write-ProbeStage 'sign-synthetic-worker'
    $signature = Set-AuthenticodeSignature -FilePath $worker -Certificate $certificate -HashAlgorithm SHA256
    if ($signature.Status -ne 'Valid') { throw 'SYNTHETIC_SIGNATURE_INVALID' }

    Write-ProbeStage 'prepare-launcher-pins'
    & (Join-Path $PSScriptRoot 'Prepare-DisposablePins.ps1') -WorkerPath $worker -SignerThumbprint $certificate.Thumbprint -SyntheticCredentialPath $canary -LoopbackPort $port -OperatorConfirmedDisposableVm
    if (-not $?) { throw 'LAUNCHER_PINS_FAILED' }

    Write-ProbeStage 'compile-launcher'
    Invoke-BoundedProcess $vsCompiler @('/nologo', '/std:c++17', '/EHsc', '/W4', '/D_WIN32_WINNT=0x0A00', '/DNTDDI_VERSION=0x0A00000A', '/DCHROME_BRIDGE_V12_DISPOSABLE_VM_BUILD', (Join-Path $native 'test_launcher.cpp'), "/Fe:$launcher", 'wintrust.lib', 'bcrypt.lib', 'advapi32.lib', 'userenv.lib', 'ole32.lib') $tempRoot 180 'LAUNCHER_COMPILE'

    Write-ProbeStage 'launch-synthetic-only'
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
    Write-ProbeStage 'synthetic-result-pass'
    [pscustomobject]@{ status = 'PASS_SYNTHETIC_ONLY'; launcherExitCode = $exitCode; canaryUnchanged = $true; canaryAclProtected = $true; loopbackListenerSawNoConnection = $true; codexLaunched = $false; independentHostAttestation = $false } | ConvertTo-Json -Compress
} catch {
    Write-ProbeStage 'probe-error'
    throw
} finally {
    Write-ProbeStage 'cleanup-start'
    if ($listener) { $listener.Stop() }
    if ($certificate) {
        $cleanupFailed = $false
        try {
            Write-ProbeStage 'remove-ephemeral-root-with-bounded-certutil'
            Invoke-BoundedProcess $certutil @('-user', '-delstore', 'Root', $certificate.Thumbprint) $tempRoot 30 'ROOT_STORE_REMOVE'
        } catch {
            $cleanupFailed = $true
            Write-ProbeStage 'ephemeral-root-cleanup-failed'
        }
        $myStore = [Security.Cryptography.X509Certificates.X509Store]::new([Security.Cryptography.X509Certificates.StoreName]::My, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
        try { $myStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite); $myStore.Remove($certificate) }
        catch { $cleanupFailed = $true; Write-ProbeStage 'ephemeral-signing-cert-cleanup-failed' }
        finally { $myStore.Close() }
        if ($publicCertificate) { $publicCertificate.Dispose() }
        if ($cleanupFailed) { throw 'EPHEMERAL_CERT_CLEANUP_FAILED' }
    }
    foreach ($pin in $pinPaths) { Remove-Item -LiteralPath $pin -Force -ErrorAction SilentlyContinue }
    if ([IO.Directory]::Exists($tempRoot) -and $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-ProbeStage 'cleanup-complete'
}

