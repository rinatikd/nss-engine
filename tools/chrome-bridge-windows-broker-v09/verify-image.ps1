[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{40,64}$')][string]$ExpectedSignerThumbprint
)
$ErrorActionPreference = 'Stop'
try {
    if (-not [IO.Path]::IsPathRooted($ImagePath) -or $ImagePath.StartsWith('\\')) { throw 'PATH_INVALID' }
    $item = Get-Item -LiteralPath $ImagePath -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'IMAGE_TYPE_OR_REPARSE_DENIED' }
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
    $hashOk = $hash -ieq $ExpectedSha256
    $signatureOk = $signature.Status.ToString() -eq 'Valid' -and
        $null -ne $signature.SignerCertificate -and
        $signature.SignerCertificate.Thumbprint -ieq $ExpectedSignerThumbprint
    [pscustomobject]@{
        imagePresent = $true
        sha256Matches = $hashOk
        authenticodeValid = ($signature.Status.ToString() -eq 'Valid')
        signerMatches = $signatureOk
        imageStarted = $false
    } | ConvertTo-Json -Compress
    if (-not ($hashOk -and $signatureOk)) { exit 2 }
    exit 0
}
catch {
    Write-Output '{"imagePresent":false,"sha256Matches":false,"authenticodeValid":false,"signerMatches":false,"imageStarted":false}'
    exit 3
}
