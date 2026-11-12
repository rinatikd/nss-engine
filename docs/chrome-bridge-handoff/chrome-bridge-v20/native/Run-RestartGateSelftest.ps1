# IPC v1.5 lab-only restart reservation model. Does not launch Codex or touch production.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("chrome-bridge-ipc15-gate-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$marker = Join-Path $root 'unclean.json'
$lockPath = Join-Path $root 'reservation.lock'
$script:passes = 0
function Assert([bool]$condition, [string]$name) {
    if (-not $condition) { throw "GATE_TEST_FAIL: $name" }
    $script:passes++
    Write-Host "GATE_PASS: $name"
}
function Enter-Gate {
    # Lock protects all marker transitions against concurrent gate clients.
    $fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    return $fs
}
function Reserve {
    $fs = Enter-Gate
    try {
        if (Test-Path -LiteralPath $marker) { return $false }
        # Durable reservation must precede any process creation.
        $record = '{"state":"unclean","reason":"reserved","schema":1}'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($record)
        $fsMarker = [System.IO.File]::Open($marker, [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $fsMarker.Write($bytes, 0, $bytes.Length); $fsMarker.Flush($true) }
        finally { $fsMarker.Dispose() }
        return $true
    } finally { $fs.Dispose() }
}
function Release-Verified([bool]$cleanupVerified) {
    $fs = Enter-Gate
    try {
        if (-not $cleanupVerified) { return $false }
        if (-not (Test-Path -LiteralPath $marker)) { return $false }
        # This API must only be called after independent OS process-tree cleanup proof.
        Remove-Item -LiteralPath $marker -Force
        return $true
    } finally { $fs.Dispose() }
}
try {
    Assert (Reserve) 'first reservation granted'
    Assert (-not (Reserve)) 'overlapping reservation denied'
    Assert (-not (Release-Verified $false)) 'unverified cleanup cannot release'
    Assert (-not (Reserve)) 'failed cleanup blocks restart'
    # Simulate controller crash by leaving marker in place while no gate handle is open.
    Assert ((Test-Path -LiteralPath $marker) -and -not (Reserve)) 'orphaned marker survives controller restart'
    Assert (Release-Verified $true) 'explicit verified cleanup releases reservation'
    Assert (Reserve) 'restart permitted after verified cleanup'
    Write-Host "RESTART_GATE_MODEL_PASS: $script:passes/7"
} finally {
    # Lab test owns this unique temp directory. Cleanup here is test teardown,
    # not production recovery or an example of clearing an unverified job.
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
