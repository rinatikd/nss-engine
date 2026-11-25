# Requires Windows PowerShell 5.1 or PowerShell 7. No build or AutoCAD execution.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$roundTripPath = $null
$roundTripPath = $null

try {
    $sourceRoot = Split-Path -Parent $PSScriptRoot
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $sourceRoot 'build.ps1'), [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -ne 0) { throw 'build.ps1 has parse errors.' }
    foreach ($name in @('Get-AcadBundleHost', 'Read-BundleManifest', 'Set-BundleHostManifest')) {
        $functions = @($ast.FindAll({ param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true))
        if ($functions.Count -ne 1) { throw "Expected exactly one $name function." }
        # Load only production helpers; never execute the launcher body.
        . ([scriptblock]::Create($functions[0].Extent.Text))
    }
    $manifestPath = Join-Path $sourceRoot 'bundle/AGPT.bundle/PackageContents.xml'
    $original = [IO.File]::ReadAllText($manifestPath)
    $expectedDescription = ([xml]$original).ApplicationPackage.Description
    if ($expectedDescription -cne 'AGPT/APPT — газовое и порошковое пожаротушение') {
        throw 'Source description must retain its original Unicode text.'
    }
    $roundTripPath = Join-Path ([IO.Path]::GetTempPath()) ('AGPT-bundle-' + [guid]::NewGuid().ToString('N') + '.xml')
    $passed = 0
    foreach ($case in @(
        @{ Year = '2025'; Series = 'R25.0'; Versions = @('25.0.0.0', '25.0.1.0', '25.0.2.0') },
        @{ Year = '2026'; Series = 'R25.1'; Versions = @('25.1.0.0', '25.1.1.0', '25.1.2.0') }
    )) {
        $hostInfo = Get-AcadBundleHost -Versions ([version[]]$case.Versions)
        if ($hostInfo.Year -ne $case.Year -or $hostInfo.Series -ne $case.Series) { throw 'Wrong API host selection.' }
        # Exercise the production reader with UTF-8 without BOM, as in the source template.
        [IO.File]::WriteAllText($roundTripPath, $original, [Text.UTF8Encoding]::new($false))
        [xml]$manifest = Read-BundleManifest -Path $roundTripPath
        if ($manifest.ApplicationPackage.Description -cne $expectedDescription) { throw 'Unicode description changed during read.' }
        $commandsBefore = $manifest.SelectSingleNode('//Commands').OuterXml
        Set-BundleHostManifest -Manifest $manifest -HostInfo $hostInfo
        foreach ($runtime in @($manifest.SelectNodes('//RuntimeRequirements'))) {
            if ($runtime.SeriesMin -ne $case.Series -or $runtime.SeriesMax -ne $case.Series) {
                throw "Bundle advertises another API series for $($case.Year)."
            }
            if ($runtime.OS -ne 'Win64' -or $runtime.Platform -ne 'AutoCAD*') { throw 'Runtime platform changed.' }
        }
        $expectedModule = './Contents/Windows/' + $case.Year + '/AGPT.dll'
        foreach ($entry in @($manifest.SelectNodes('//ComponentEntry'))) {
            if ($entry.ModuleName -ne $expectedModule -or $hostInfo.ModuleName -ne $expectedModule) {
                throw "Wrong module path for $($case.Year)."
            }
        }
        if ($manifest.SelectSingleNode('//Commands').OuterXml -ne $commandsBefore) { throw 'Bundle commands changed.' }
        # Use the production save/read sequence on disk, including Windows PowerShell 5.1 encoding behavior.
        $manifest.Save($roundTripPath)
        [xml]$roundTrip = Read-BundleManifest -Path $roundTripPath
        if ($roundTrip.SelectNodes('//ComponentEntry').Count -eq 0) { throw 'Serialized bundle lost its module.' }
        if ($roundTrip.ApplicationPackage.Description -cne $expectedDescription) { throw 'Unicode description changed during save/read.' }
        $passed++
        Write-Host "PASS: host $($case.Year) manifest, module path and Unicode disk roundtrip"
    }
    foreach ($case in @(
        @{ Name = 'mixed-minors'; Versions = @('25.0.0.0', '25.1.0.0', '25.0.0.0') },
        @{ Name = 'mixed-third-reference'; Versions = @('25.1.0.0', '25.1.0.0', '25.0.0.0') },
        @{ Name = 'unsupported-major'; Versions = @('24.1.0.0', '24.1.0.0', '24.1.0.0') },
        @{ Name = 'unsupported-minor'; Versions = @('25.2.0.0', '25.2.0.0', '25.2.0.0') },
        @{ Name = 'one-unsupported-reference'; Versions = @('25.1.0.0', '26.0.0.0', '25.1.0.0') },
        @{ Name = 'missing-reference'; Versions = @('25.1.0.0', '25.1.0.0') },
        @{ Name = 'null-reference'; Versions = @('25.1.0.0', $null, '25.1.0.0') }
    )) {
        $rejected = $false
        try { $null = Get-AcadBundleHost -Versions ([version[]]$case.Versions) }
        catch { $rejected = $true }
        if (!$rejected) { throw "Invalid API selection accepted: $($case.Name)" }
        $passed++
        Write-Host "PASS: reject $($case.Name)"
    }
    foreach ($xmlText in @(
        '<ApplicationPackage><ComponentEntry ModuleName="./AGPT.dll" /></ApplicationPackage>',
        '<ApplicationPackage><RuntimeRequirements SeriesMin="R25.0" SeriesMax="R25.1" /></ApplicationPackage>'
    )) {
        [xml]$invalid = $xmlText
        $rejected = $false
        try { Set-BundleHostManifest -Manifest $invalid -HostInfo $hostInfo }
        catch { $rejected = $true }
        if (!$rejected) { throw 'Incomplete manifest accepted.' }
        $passed++
        Write-Host 'PASS: reject incomplete manifest'
    }
    if ([IO.File]::ReadAllText($manifestPath) -cne $original) { throw 'Public source manifest was modified.' }
    Write-Host "Passed: $passed"
    Write-Host 'API version selection and XML staging only; no CAD build or host loading is verified.'
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally {
    if ($roundTripPath -and (Test-Path -LiteralPath $roundTripPath)) {
        Remove-Item -LiteralPath $roundTripPath -Force
    }
}
