# Read-only Windows lab Codex identity check. Does NOT execute Codex.
[CmdletBinding()]
param(
    [string]$Executable = '',
    [string]$ExpectedSha256 = '9D563EE4E0441FF9D59D612013E0460DDF8E5709735C2D9F6B98B7EF8CA4EB42'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
function Deny([string]$Reason) { throw "CODEX_IDENTITY_DENIED: $Reason" }
if (!$Executable) {
    $cmd = Get-Command codex.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $Executable = $cmd.Source
}
if (!$Executable -or $Executable -notmatch '^[A-Za-z]:\\' -or
    $Executable -match '^[\\/]{2}' -or
    [IO.Path]::GetFileName($Executable) -cne 'codex.exe') {
    Deny 'INVALID_LOCAL_EXECUTABLE_PATH'
}
if ($ExpectedSha256 -notmatch '^[0-9A-Fa-f]{64}$') { Deny 'INVALID_EXPECTED_HASH' }
$canonical = [IO.Path]::GetFullPath($Executable)
if ($canonical -ine $Executable -or $Executable.Substring(2).Contains(':')) {
    Deny 'NONCANONICAL_PATH'
}
$entry = Get-Item -LiteralPath $Executable -Force -ErrorAction Stop
if ($entry.PSIsContainer) { Deny 'NOT_A_FILE' }
# FileInfo in Windows PowerShell 5.1 does not expose .Parent.
# Traverse using literal parent paths, checking each directory through the drive root.
$cursorPath = $entry.FullName
while ($cursorPath) {
    $cursorItem = Get-Item -LiteralPath $cursorPath -Force -ErrorAction Stop
    if (($cursorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Deny 'REPARSE_POINT_IN_PATH'
    }
    $parentPath = Split-Path -Path $cursorPath -Parent
    if (!$parentPath -or $parentPath -eq $cursorPath) { break }
    $cursorPath = $parentPath
}
$before = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
if ($before -ine $ExpectedSha256) { Deny 'HASH_MISMATCH' }
$signature = Get-AuthenticodeSignature -LiteralPath $Executable
if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate) { Deny 'SIGNATURE_INVALID' }
$subject = $signature.SignerCertificate.Subject
if ($subject -notmatch '(?:^|,\s*)O="?OpenAI OpCo, LLC"?(?:,|$)') {
    Deny 'UNEXPECTED_SIGNER'
}
$after = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
if ($after -ine $before) { Deny 'FILE_CHANGED_DURING_CHECK' }
Write-Host 'CODEX_IDENTITY_CHECK_PASS'
Write-Host 'SIGNATURE_STATUS: Valid'
Write-Host "SIGNER: $subject"
Write-Host "SHA256: $after"
Write-Host 'CODEX_EXECUTION: DISABLED'
Write-Host 'NOTE: This check is not atomic with a future launch.'
