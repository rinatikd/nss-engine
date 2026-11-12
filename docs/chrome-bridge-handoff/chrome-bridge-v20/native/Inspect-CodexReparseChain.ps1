# Read-only Codex junction-chain inventory. Does not execute Codex or alter links.
[CmdletBinding()]
param([string]$Executable = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
if (!$Executable) {
    $Executable = (Get-Command codex.exe -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
}
$expected = '9D563EE4E0441FF9D59D612013E0460DDF8E5709735C2D9F6B98B7EF8CA4EB42'
$queue = [System.Collections.Generic.Queue[string]]::new()
$queue.Enqueue($Executable)
$seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$links = 0
while ($queue.Count -gt 0) {
    $path = $queue.Dequeue()
    if (!$seen.Add($path)) { throw "CODEX_CHAIN_CYCLE: $path" }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    $cursorPath = $item.FullName
    while ($cursorPath) {
        $part = Get-Item -LiteralPath $cursorPath -Force -ErrorAction Stop
        if (($part.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $links++
            if ($links -gt 16) { throw 'CODEX_CHAIN_TOO_MANY_LINKS' }
            Write-Host "LINK_PATH: $cursorPath"
            Write-Host "LINK_TYPE: $($part.LinkType)"
            Write-Host "LINK_TARGET: $($part.Target -join '; ')"
            if ($part.LinkType -ne 'Junction' -and $part.LinkType -ne 'SymbolicLink') {
                throw "CODEX_CHAIN_UNSUPPORTED_LINK: $cursorPath"
            }
            $targets = @($part.Target)
            if ($targets.Count -ne 1 -or !$targets[0] -or
                $targets[0] -notmatch '^[A-Za-z]:\\') {
                throw "CODEX_CHAIN_INVALID_TARGET: $cursorPath"
            }
            $suffix = $path.Substring($cursorPath.Length).TrimStart('\')
            $next = if ($suffix) { Join-Path $targets[0] $suffix } else { $targets[0] }
            $queue.Enqueue($next)
            break
        }
        $parentPath = Split-Path -Path $cursorPath -Parent
        if (!$parentPath -or $parentPath -eq $cursorPath) { break }
        $cursorPath = $parentPath
    }
}
$hash = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
$signature = Get-AuthenticodeSignature -LiteralPath $Executable
Write-Host "LINKS_DISCOVERED: $links"
Write-Host "SHA256_MATCH: $($hash -ieq $expected)"
Write-Host "SIGNATURE_STATUS: $($signature.Status)"
Write-Host "SIGNER: $($signature.SignerCertificate.Subject)"
Write-Host 'CHAIN_DIAGNOSTIC_ONLY: NO_ALLOWLIST_CHANGE'
Write-Host 'CODEX_EXECUTION: DISABLED'
