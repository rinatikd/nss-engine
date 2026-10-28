# Windows wrapper smoke only: no bridge server, Chrome, clipboard or registration.
# Run on a fresh CI runner after reconstruction with CANDIDATE_DIR set.
$ErrorActionPreference = 'Stop'

function Invoke-WrapperCaptured {
    param([string]$ScriptPath, [hashtable]$Arguments = @{})
    # Capture every stream: even a regression that prints a token must not put it
    # into the CI log. Callers inspect the captured value privately.
    $captured = & $ScriptPath @Arguments *>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'Wrapper command failed.' }
    return $captured
}

function Assert-NoTokens {
    param([string]$Captured, [string]$AgentToken, [string]$BrowserToken)
    if ($Captured.Contains($AgentToken) -or $Captured.Contains($BrowserToken)) {
        throw 'Wrapper exposed a private token.'
    }
}

$environmentNames = @('CHROME_BRIDGE_HOME', 'CHROME_BRIDGE_PORT', 'CHROME_BRIDGE_EXTENSION_ID')
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$smokeStage = 'prerequisites'
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows runner required.' }
    if (-not $env:CANDIDATE_DIR -or -not (Test-Path -LiteralPath $env:CANDIDATE_DIR -PathType Container)) {
        throw 'Reconstructed candidate required.'
    }
    $candidate = [IO.Path]::GetFullPath($env:CANDIDATE_DIR)
    $setup = Join-Path $candidate 'Setup-Windows.ps1'
    $doctor = Join-Path $candidate 'Doctor-Bridge.ps1'
    $connect = Join-Path $candidate 'Connect-Agents.ps1'
    foreach ($wrapper in @($setup, $doctor, $connect)) {
        if (-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) { throw 'Required wrapper missing.' }
    }
    $tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
    # A unique directory owned by this smoke is the only writable state. Do not
    # remove any existing path; the disposable runner will retire this directory.
    $state = Join-Path $tempRoot ('chrome bridge smoke Кириллица-' + [Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $state) { throw 'Isolated state directory already exists.' }
    $null = New-Item -ItemType Directory -Path $state
    $env:CHROME_BRIDGE_HOME = $state
    $env:CHROME_BRIDGE_PORT = '17381'
    [Environment]::SetEnvironmentVariable('CHROME_BRIDGE_EXTENSION_ID', $null, 'Process')
    $extensionId = 'a' * 32

    $smokeStage = 'setup'
    $setupOutput = Invoke-WrapperCaptured -ScriptPath $setup -Arguments @{ExtensionId = $extensionId}
    $configPath = Join-Path $state 'config.json'
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $agentToken = [string]$config.agentToken
    $browserToken = [string]$config.browserToken
    if ($agentToken -notmatch '^[a-f0-9]{64}$' -or $browserToken -notmatch '^[a-f0-9]{64}$' -or
        $config.extensionId -ne $extensionId) { throw 'Setup produced invalid isolated configuration.' }
    Assert-NoTokens -Captured $setupOutput -AgentToken $agentToken -BrowserToken $browserToken
    Write-Output 'PASS: Windows setup creates isolated pinned configuration.'

    $smokeStage = 'doctor'
    $doctorOutput = Invoke-WrapperCaptured -ScriptPath $doctor
    Assert-NoTokens -Captured $doctorOutput -AgentToken $agentToken -BrowserToken $browserToken
    if (-not $doctorOutput.Contains('PASS: Node version, release files, local configuration, extension pin and port.')) {
        throw 'Offline doctor did not confirm local prerequisites.'
    }
    Write-Output 'PASS: Windows offline doctor validates local prerequisites.'

    $smokeStage = 'preview'
    $previewOutput = Invoke-WrapperCaptured -ScriptPath $connect
    Assert-NoTokens -Captured $previewOutput -AgentToken $agentToken -BrowserToken $browserToken
    # Connect-Agents emits doctor status, JSON, then preview instructions. Parse
    # its JSON so escaped Windows separators are checked as an actual state path.
    $jsonStart = $previewOutput.IndexOf('{')
    $jsonEnd = $previewOutput.LastIndexOf('}')
    if ($jsonStart -lt 0 -or $jsonEnd -le $jsonStart -or -not $previewOutput.Contains('Preview only. No user MCP configuration changed.')) {
        throw 'Agent preview output is incomplete.'
    }
    $preview = $previewOutput.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json
    $definition = $preview.mcpServers.'chrome-bridge'
    if ($definition.env.CHROME_BRIDGE_HOME -cne [IO.Path]::GetFullPath($state) -or
        $definition.env.CHROME_BRIDGE_PORT -ne '17381' -or
        $definition.args.Count -ne 1 -or
        $definition.args[0] -cne (Join-Path $candidate 'server\stdio.mjs')) {
        throw 'Agent preview does not use isolated state and candidate proxy.'
    }
    Write-Output 'PASS: Windows agent preview uses isolated state without exposing tokens.'

    $smokeStage = 'repeat-setup'
    $repeatOutput = Invoke-WrapperCaptured -ScriptPath $setup -Arguments @{ExtensionId = $extensionId}
    Assert-NoTokens -Captured $repeatOutput -AgentToken $agentToken -BrowserToken $browserToken
    $repeatConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ([string]$repeatConfig.agentToken -cne $agentToken -or
        [string]$repeatConfig.browserToken -cne $browserToken -or
        $repeatConfig.extensionId -ne $extensionId) { throw 'Repeated setup changed existing tokens or extension pin.' }
    Write-Output 'PASS: Repeated Windows setup preserves both private tokens.'
} catch {
    # Never echo caught wrapper output, configuration, paths or exception details.
    throw "FAIL: Isolated Windows wrapper smoke failed at $smokeStage; private diagnostic output suppressed."
} finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    # Do not retain private tokens in this script scope after environment restore.
    Remove-Variable config, repeatConfig, agentToken, browserToken, setupOutput, doctorOutput, previewOutput, preview, repeatOutput -ErrorAction SilentlyContinue
}
