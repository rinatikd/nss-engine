# Read-only diagnostics of installed Chrome Bridge. No credentials are read or printed.
[CmdletBinding()]
param(
  [string]$BridgeRoot = 'C:\Engineering\chrome-bridge',
  [switch]$SkipPorts,
  [int[]]$Ports = @(17381, 17382)
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$failed = 0
function Check([string]$Name, [bool]$Ok, [string]$Info = '') {
  if (-not $Ok) { $script:failed++ }
  $state = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Output ("[{0}] {1}{2}" -f $state, $Name, $(if ($Info) { ': ' + $Info } else { '' }))
}
Write-Output 'CHROME_BRIDGE_READ_ONLY_PREFLIGHT'
$root = [IO.Path]::GetFullPath($BridgeRoot)
Check 'root-exists' (Test-Path -LiteralPath $root -PathType Container)
if (-not (Test-Path -LiteralPath $root -PathType Container)) { exit 2 }

$extension = Join-Path $root 'extension'
$manifestPath = Join-Path $extension 'manifest.json'
Check 'extension-dir' (Test-Path -LiteralPath $extension -PathType Container)
Check 'manifest-exists' (Test-Path -LiteralPath $manifestPath -PathType Leaf)
foreach ($name in @('control.html', 'control.js', 'background.js', 'permissions.js')) {
  Check ("source-" + $name) (Test-Path -LiteralPath (Join-Path $extension $name) -PathType Leaf)
}

if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
  try {
    $m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Check 'manifest-v3' ($m.manifest_version -eq 3)
    $permissions = @($m.permissions)
    Check 'permission-storage' ($permissions -contains 'storage')
    Check 'permission-scripting' ($permissions -contains 'scripting')
    # Absence of activeTab blocks the new screenshot feature, not read-only Bridge.
    $hasActiveTab = $permissions -contains 'activeTab'
    Write-Output ("[INFO] activeTab-for-screenshots: " + $(if ($hasActiveTab) {'YES'} else {'NO — needed before photo acceptance'}))
    $hosts = @($m.host_permissions)
    Check 'no-permanent-all-urls' (-not ($hosts -contains '<all_urls>' -or $hosts -contains 'https://*/*'))
    $worker = [string]$m.background.service_worker
    Check 'background-worker' (-not [string]::IsNullOrWhiteSpace($worker))
    if (-not [string]::IsNullOrWhiteSpace($worker)) {
      Check 'background-worker-exists' (Test-Path -LiteralPath (Join-Path $extension $worker) -PathType Leaf)
    }
    if ($m.version) { Write-Output ('[INFO] extension-version: ' + [string]$m.version) }
  } catch {
    Check 'manifest-valid' $false 'Cannot parse installed manifest'
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Write-Output '[INFO] node executable: unavailable (JavaScript syntax not checked)'
} else {
  foreach ($name in @('background.js','control.js','permissions.js')) {
    $file = Join-Path $extension $name
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      & $node.Source --check $file 2>$null
      Check ("node-syntax-" + $name) ($LASTEXITCODE -eq 0)
    }
  }
}

if (-not $SkipPorts) {
  foreach ($port in $Ports) {
    $tcp = [Net.Sockets.TcpClient]::new()
    try {
      $promise = $tcp.ConnectAsync('127.0.0.1', $port)
      $ok = $promise.Wait(700) -and $tcp.Connected
      Check ("local-port-" + $port) $ok
    } catch {
      Check ("local-port-" + $port) $false
    } finally { $tcp.Dispose() }
  }
}
Write-Output ("[RESULT] checks_failed=" + $failed)
if ($failed -ne 0) { exit 1 }
exit 0
