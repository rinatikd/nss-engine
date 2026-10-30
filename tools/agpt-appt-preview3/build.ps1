param(
    [ValidateSet('Build', 'Run', 'Install')][string]$Mode = 'Build',
    [string]$AcadDir = '',
    [switch]$AllUsers
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
$lock = $null
$scratch = $null

function Publish-Directory([string]$Source, [string]$Destination) {
    $backup = $Destination + '.previous-' + [guid]::NewGuid().ToString('N')
    $hadPrevious = Test-Path -LiteralPath $Destination
    if ($hadPrevious) { [IO.Directory]::Move($Destination, $backup) }
    try {
        [IO.Directory]::Move($Source, $Destination)
    } catch {
        if ($hadPrevious) { [IO.Directory]::Move($backup, $Destination) }
        throw
    }
    if ($hadPrevious) {
        try { Remove-Item -LiteralPath $backup -Recurse -Force }
        catch { Write-Warning "Previous files retained at $backup; close AutoCAD before removing them." }
    }
}

function Get-AcadBundleHost([version[]]$Versions) {
    if ($Versions.Count -ne 3) { throw 'Expected all three AutoCAD API reference versions.' }
    $selected = $null
    foreach ($version in $Versions) {
        if ($null -eq $version -or $version.Major -ne 25 -or $version.Minor -notin @(0, 1)) {
            throw "Unsupported AutoCAD API version $version; expected R25.0/R25.1."
        }
        $series = 'R' + $version.Major + '.' + $version.Minor
        if ($null -ne $selected -and $selected -ne $series) {
            throw 'All three AutoCAD API references must use the same major/minor version.'
        }
        $selected = $series
    }
    $year = if ($selected -eq 'R25.0') { '2025' } else { '2026' }
    return [pscustomobject]@{
        Year = $year
        Series = $selected
        ModuleName = './Contents/Windows/' + $year + '/AGPT.dll'
    }
}

function Read-BundleManifest([string]$Path) {
    $document = New-Object System.Xml.XmlDocument
    # Load bytes using the XML declaration/BOM, including on Windows PowerShell 5.1.
    $document.Load($Path)
    return ,$document
}

function Set-BundleHostManifest([xml]$Manifest, $HostInfo) {
    $requirements = @($Manifest.SelectNodes('//RuntimeRequirements'))
    $entries = @($Manifest.SelectNodes('//ComponentEntry'))
    if ($requirements.Count -eq 0) { throw 'Bundle has no runtime requirements.' }
    if ($entries.Count -eq 0) { throw 'Bundle has no module entries.' }
    foreach ($runtime in $requirements) {
        $runtime.SetAttribute('SeriesMin', $HostInfo.Series)
        $runtime.SetAttribute('SeriesMax', $HostInfo.Series)
    }
    foreach ($entry in $entries) { $entry.SetAttribute('ModuleName', $HostInfo.ModuleName) }
}

function Assert-SourceResources {
    $directory = Join-Path $root 'blocks'
    if (!(Test-Path -LiteralPath $directory -PathType Container)) {
        throw 'Restore the original blocks library before building this source-only kit.'
    }
    $frames = @('ММХ_Штамп.dwg', 'MMH_Stamp.dwg', 'AGPT_Frame_A3.dwg', 'AGPT_Frame_A3.dxf')
    $symbols = @('Садик_UGO_source.dwg', 'Садик.dwg')
    foreach ($name in @($frames + $symbols)) {
        $file = Join-Path $directory $name
        if ((Test-Path -LiteralPath $file -PathType Leaf) -and (Get-Item -LiteralPath $file).Length -eq 0) {
            throw "Empty recognized CAD resource can shadow another candidate: $name"
        }
    }
    foreach ($group in @($frames, $symbols)) {
        $present = @($group | Where-Object {
            $file = Join-Path $directory $_
            (Test-Path -LiteralPath $file -PathType Leaf) -and (Get-Item -LiteralPath $file).Length -gt 0
        })
        if ($present.Count -eq 0) {
            throw 'Restore nonempty frame and UGO CAD resources from the original blocks library; text instructions alone are insufficient.'
        }
    }
}

function Assert-Resources([string]$Directory) {
    Assert-SourceResources
    if (!(Test-Path -LiteralPath (Join-Path $Directory 'AGPT.dll') -PathType Leaf)) {
        throw "Missing AGPT.dll in $Directory"
    }
    if (!(Test-Path -LiteralPath (Join-Path $Directory 'AGPT.InputCore.dll') -PathType Leaf)) {
        throw "Missing AGPT.InputCore.dll in $Directory"
    }
    foreach ($hostDll in @('AcCoreMgd.dll', 'AcDbMgd.dll', 'AcMgd.dll')) {
        if (Test-Path -LiteralPath (Join-Path $Directory $hostDll)) { throw "Host DLL must not be redistributed: $hostDll" }
    }
    $sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $root 'blocks') -File -Recurse)
    if ($sourceFiles.Count -eq 0) { throw 'The blocks library is empty.' }
    foreach ($source in $sourceFiles) {
        $relative = $source.FullName.Substring($root.Length + 1)
        $target = Join-Path $Directory $relative
        if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing resource: $relative" }
        if ((Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) {
            throw "Resource hash mismatch: $relative"
        }
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher requires Windows and AutoCAD 2025/2026.' }
    if (!(Test-Path -LiteralPath (Join-Path $root 'AGPT.csproj'))) { throw 'AGPT.csproj not found.' }
    if ([string]::IsNullOrWhiteSpace($AcadDir)) {
        foreach ($year in @('2026', '2025')) {
            $candidate = Join-Path $env:ProgramFiles "Autodesk\AutoCAD $year"
            if (Test-Path -LiteralPath (Join-Path $candidate 'AcCoreMgd.dll')) {
                $AcadDir = $candidate
                break
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($AcadDir)) { throw 'Specify an AutoCAD 2025/2026 directory.' }
    $AcadDir = (Resolve-Path -LiteralPath $AcadDir).Path
    $apiVersions = @(foreach ($name in @('AcCoreMgd.dll', 'AcDbMgd.dll', 'AcMgd.dll')) {
        $reference = Join-Path $AcadDir $name
        if (!(Test-Path -LiteralPath $reference -PathType Leaf)) { throw "Missing AutoCAD reference: $reference" }
        [Reflection.AssemblyName]::GetAssemblyName($reference).Version
    })
    $bundleHost = Get-AcadBundleHost -Versions $apiVersions
    $dotnet = (Get-Command dotnet -CommandType Application -ErrorAction Stop).Source
    $sdkVersion = & $dotnet --version
    if ($LASTEXITCODE -ne 0 -or $sdkVersion -notmatch '^([89]|[1-9][0-9]+)\.') {
        throw 'A usable .NET SDK supporting net8.0-windows is required (minimum .NET 8).'
    }
    Assert-SourceResources
    $bin = Join-Path $root 'bin'
    [IO.Directory]::CreateDirectory($bin) | Out-Null
    $lock = [IO.File]::Open((Join-Path $bin 'AGPT.build.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $scratch = Join-Path $bin ('.build-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($scratch) | Out-Null
    $buildArgs = @('build', (Join-Path $root 'AGPT.csproj'), '-c', 'Release',
        '-p:Platform=x64', ('-p:AcadDir=' + $AcadDir), '--no-incremental', '-o', $scratch)
    Write-Host "Building against $AcadDir (SDK $sdkVersion)"
    & $dotnet @buildArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; the previous Release directory was preserved.' }
    Assert-Resources $scratch
    $release = Join-Path $bin 'Release'
    Publish-Directory $scratch $release
    $scratch = $null
    $dll = Join-Path $release 'AGPT.dll'
    Write-Host "Build completed: $dll"
    Write-Host ('SHA256: ' + (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash)

    if ($Mode -eq 'Install') {
        $base = if ($AllUsers) { $env:ProgramData } else { $env:APPDATA }
        $plugins = Join-Path $base 'Autodesk\ApplicationPlugins'
        [IO.Directory]::CreateDirectory($plugins) | Out-Null
        $scratch = Join-Path $plugins ('.AGPT-staging-' + [guid]::NewGuid().ToString('N'))
        Copy-Item -LiteralPath (Join-Path $root 'bundle\AGPT.bundle') -Destination $scratch -Recurse
        # Retain only the single runtime path referenced by PackageContents.xml.
        $windows = Join-Path $scratch 'Contents\Windows'
        if (Test-Path -LiteralPath $windows) { Remove-Item -LiteralPath $windows -Recurse -Force }
        $module = Join-Path $windows $bundleHost.Year
        [IO.Directory]::CreateDirectory($module) | Out-Null
        Get-ChildItem -LiteralPath $release | Copy-Item -Destination $module -Recurse
        Assert-Resources $module
        $manifestPath = Join-Path $scratch 'PackageContents.xml'
        [xml]$manifest = Read-BundleManifest -Path $manifestPath
        Set-BundleHostManifest -Manifest $manifest -HostInfo $bundleHost
        $manifest.Save($manifestPath)
        $entries = @($manifest.SelectNodes('//ComponentEntry'))
        foreach ($entry in $entries) {
            $modulePath = [IO.Path]::GetFullPath((Join-Path $scratch ([string]$entry.ModuleName)))
            if (!$modulePath.StartsWith($scratch + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
                !(Test-Path -LiteralPath $modulePath -PathType Leaf)) { throw 'Invalid bundle ModuleName.' }
        }
        $destination = Join-Path $plugins 'AGPT.bundle'
        Publish-Directory $scratch $destination
        $scratch = $null
        Write-Host "Bundle installed: $destination. Restart AutoCAD and verify loading."
    }
    if ($Mode -eq 'Run') {
        $acad = Join-Path $AcadDir 'acad.exe'
        if (!(Test-Path -LiteralPath $acad -PathType Leaf)) { throw "acad.exe not found: $acad; the build is available for manual NETLOAD." }
        $script = Join-Path ([IO.Path]::GetTempPath()) ('AGPT-netload-' + [guid]::NewGuid().ToString('N') + '.scr')
        $lines = @('_.NETLOAD', ('"' + $dll.Replace('\', '/') + '"'), '_.ZOOM', '_E', '')
        [IO.File]::WriteAllLines($script, $lines, [Text.UTF8Encoding]::new($false))
        if (!(Test-Path -LiteralPath $script -PathType Leaf)) { throw 'NETLOAD script was not created.' }
        Start-Process -FilePath $acad -ArgumentList ('/nologo /b "' + $script + '"') -ErrorAction Stop | Out-Null
        Write-Host "AutoCAD launch requested; loading is not verified. Type AGPT_ALBUM in a new drawing."
        Write-Host "Temporary script retained for asynchronous AutoCAD: $script"
    }
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
    if ($scratch -and (Test-Path -LiteralPath $scratch)) {
        try { Remove-Item -LiteralPath $scratch -Recurse -Force }
        catch { Write-Warning "Could not remove staging directory: $scratch" }
    }
}
