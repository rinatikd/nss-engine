# PowerShell 5.1 compatibility and safe local diagnostics

Status: engineering guidance for NSS Engine, APS Expert, and Chrome Bridge. Target shell: **Windows PowerShell 5.1** unless a script explicitly requires PowerShell 7+. This document records observed failures and tested alternatives from the local Chrome Bridge lab; it is not a claim that every snippet has passed automated tests.

## Known compatibility pitfalls

| Operation | Avoid in Windows PowerShell 5.1 | Compatible alternative |
| --- | --- | --- |
| Clear clipboard | `Set-Clipboard -Value ''` (throws `ArgumentNullException` in the tested environment) | `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()` |
| Generate secure random bytes | `[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)` (method unavailable) | `$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }` |
| Read a DPAPI-protected secure string | Piping `Get-Content -Raw` directly to `ConvertTo-SecureString` (trailing newline caused `FormatException`) | `$encrypted = [System.IO.File]::ReadAllText($path).Trim(); $secure = ConvertTo-SecureString -String $encrypted` |
| Stop a lab server by PID | Reuse a hard-coded PID from a previous session | Resolve the current listener PID, verify its executable and full command line, then stop only that process |

## Clipboard

```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::Clear()
```

Clear clipboard **after** the token has been pasted into its intended destination. Clipboard clearing does not guarantee that clipboard history, third-party clipboard managers, logs, screenshots, or other copies have been erased.

## Cryptographically secure token generation

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
} finally {
    $rng.Dispose()
}
$token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
# Store securely; never echo $token to the console or commit it.
[Array]::Clear($bytes, 0, $bytes.Length)
```

## DPAPI-protected token files

For a token previously saved with `ConvertFrom-SecureString` under the current Windows user:

```powershell
$encrypted = [System.IO.File]::ReadAllText($tokenFile).Trim()
$secure = ConvertTo-SecureString -String $encrypted
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    # Use the token only for the intended local operation; never print it.
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Variable token,secure,encrypted,bstr -ErrorAction SilentlyContinue
}
```

DPAPI protects the saved file for the current Windows account on the same machine; it does **not** encrypt a token once placed in a plain-text JSON configuration, a process's memory, or the clipboard. Keep backups containing secrets out of Git. Limit access to configuration files and remove temporary secrets after verifying recovery. A rollback copy of an exposed token must not become the permanent credential.

## Verify a lab listener before stopping anything

```powershell
$port = 17481
$expectedScript = 'C:\Engineering\chrome-bridge-rc-final-clean\docs\chrome-bridge-handoff\chrome-bridge-v20\server\bridge.mjs'
$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
if ($listeners.Count -ne 1) { throw 'UNEXPECTED_LISTENER_COUNT' }
$labPid = $listeners[0].OwningProcess
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$labPid"
if (-not $proc -or $proc.Name -ne 'node.exe' -or
    -not $proc.CommandLine.Contains($expectedScript)) {
    throw 'LAB_PROCESS_VERIFICATION_FAILED'
}
# Only after these checks may a separately authorized restart stop $labPid.
```

Never use a previously observed PID as proof of process identity. Avoid touching production ports **17381/17382**, credentials, or tunnels during isolated lab work. Do not print bearer tokens or include them in diagnostic screenshots.

## Script review checklist

1. Specify the minimum PowerShell/.NET version and avoid assuming PowerShell 7 APIs.
2. Reuse alternatives already validated on the target machine; do not reintroduce a known failing command.
3. Use `$ErrorActionPreference = 'Stop'` where appropriate and validate preconditions before writes.
4. Separate read-only checks from configuration edits and service restarts.
5. Verify the current process identity, port, state directory, and extension origin before a lab restart.
6. Back up secrets securely; plan rollback and check for partial writes. Prefer atomic file replacement when implementing production-grade scripts.
7. Redact tokens, API keys, authorization headers, local private data, and configuration secrets from logs and issue comments.
8. Report what was actually executed and verified; do not call a connectivity check a full E2E test.

## Scope and maintenance

Applies to scripts used by ChatGPT, Codex CLI, Claude, Gemini, and other project contributors working on NSS Engine, APS Expert, and Chrome Bridge. Add a regression note whenever a new compatibility failure is reproduced; review proposed commands against this file before sending them to a Windows PowerShell 5.1 user.
