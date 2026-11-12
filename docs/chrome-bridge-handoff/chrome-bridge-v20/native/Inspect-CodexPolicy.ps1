# Read-only Codex policy diagnostics. Does not print secret values or change configuration.
[CmdletBinding()]
param(
    [string]$BridgeRoot = 'C:\Engineering\chrome-bridge',
    [string]$CheckoutRoot = 'C:\Engineering\chrome-bridge-pr103-local'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Write-Host '=== CODEX POLICY DIAGNOSTIC (READ ONLY) ==='
$names = @('CODEX_DISABLED','CODEX_EXECUTION','CODEX_ENABLED','CODEX_WORKSPACE','CODEX_WORKSPACES','CODEX_POLICY','ISOLATED_EXECUTION')
foreach ($scope in @('Process','User','Machine')) {
    foreach ($name in $names) {
        $v = [Environment]::GetEnvironmentVariable($name,$scope)
        if ($null -ne $v) {
            # Never print values: workspace paths, flags and secrets are not needed for this step.
            Write-Host ("ENV {0} {1}: PRESENT" -f $scope,$name)
        }
    }
}
foreach ($root in @($BridgeRoot,$CheckoutRoot)) {
    if (!(Test-Path -LiteralPath $root -PathType Container)) {
        Write-Host ("ROOT_MISSING: {0}" -f $root)
        continue
    }
    Write-Host ("ROOT: {0}" -f $root)
    $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FullName -notmatch '[\\/](node_modules|\.git|bin|obj|dist|build)[\\/]' -and
            $_.Length -le 2MB -and
            $_.Extension -in @('.js','.cjs','.mjs','.ts','.json','.ps1','.md','.yml','.yaml')
        })
    $matches = @($files | Select-String -Pattern 'CODEX_DISABLED|isolated local execution policy|required|codex_submit' -ErrorAction SilentlyContinue)
    foreach ($m in $matches | Select-Object -First 80) {
        $relative = $m.Path.Substring($root.Length).TrimStart('\','/')
        # Only show file and line number; matching source lines might contain secrets.
        Write-Host ("MATCH: {0}:{1}" -f $relative,$m.LineNumber)
    }
    Write-Host ("MATCHES_SHOWN: {0}" -f [Math]::Min(80,$matches.Count))
}
Write-Host 'DIAGNOSTIC_COMPLETE: no configuration changed'
