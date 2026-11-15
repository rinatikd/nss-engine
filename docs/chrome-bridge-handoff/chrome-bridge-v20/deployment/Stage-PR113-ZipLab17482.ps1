# Stage PR113 ZIP sources for a NEW isolated port 17482, reserved separately from PR102:17484.
# No Git required; no server launch, Chrome extension installation, tokens, or production modification.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$SourceRoot,
 [string]$OutputRoot='C:\Engineering\ChromeBridge-PR113-ZIP-Lab17482-Stage'
)
$ErrorActionPreference='Stop'
$node='C:\Program Files\nodejs\node.exe'
if(!(Test-Path -LiteralPath $node -PathType Leaf)){throw 'TRUSTED_NODE_NOT_FOUND'}
$source=(Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).ProviderPath.TrimEnd([char]92)
$target=[IO.Path]::GetFullPath($OutputRoot).TrimEnd([char]92)
$base='C:\Engineering\'
if(!$source.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or
   !$target.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'SOURCE_AND_TARGET_REQUIRE_C_ENGINEERING'}
if($source -match '(?i)production|recovery-install|pr102' -or
   $target -match '(?i)production|recovery-install|pr102|17381|17382|17484'){
 throw 'PROTECTED_SOURCE_OR_TARGET'
}
if($target -ieq $source -or
 $target.StartsWith(($source+'\'),[StringComparison]::OrdinalIgnoreCase) -or
 $source.StartsWith(($target+'\'),[StringComparison]::OrdinalIgnoreCase)){
 throw 'OVERLAPPING_SOURCE_AND_TARGET_DENIED'
}
if(Test-Path -LiteralPath $target){throw 'TARGET_ALREADY_EXISTS_NO_OVERWRITE'}
$test=Join-Path $source 'deployment\Test-PR113-ZipSource.ps1'
$server=Join-Path $source 'server\bridge.mjs'
$ext=Join-Path $source 'extension'
$extManifest=Join-Path $ext 'manifest.json'
foreach($f in @($test,$server,$extManifest)){
 if(!(Test-Path -LiteralPath $f -PathType Leaf)){throw "REQUIRED_SOURCE_MISSING: $f"}
}
# Test from original ZIP prior to creating output.
& $test -SourceRoot $source -Node $node
if($LASTEXITCODE -ne 0 -or -not $?){throw 'PR113_ZIP_TESTS_FAILED_NO_STAGE'}
$sourceServer=[IO.File]::ReadAllText($server)
$needle='export const PORT = Number(process.env.CHROME_BRIDGE_PORT || 17381);'
if(!$sourceServer.Contains($needle)){throw 'UNEXPECTED_SERVER_PORT_ANCHOR'}
$sourceManifest=Get-Content -LiteralPath $extManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if($sourceManifest.manifest_version -ne 3){throw 'UNEXPECTED_EXTENSION_MANIFEST'}
# Stage source copies only, leaving source and installed extensions unchanged.
New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
$serverDest=Join-Path $target 'server'
$extDest=Join-Path $target 'extension-17482'
Copy-Item -LiteralPath (Join-Path $source 'server') -Destination $serverDest -Recurse -ErrorAction Stop
Copy-Item -LiteralPath $ext -Destination $extDest -Recurse -ErrorAction Stop
$state=Join-Path $target 'state'
New-Item -ItemType Directory -Path $state -ErrorAction Stop | Out-Null
$quotedState=ConvertTo-Json -Compress $state
$guard="if (process.env.CHROME_BRIDGE_PORT !== '17482' || process.env.CHROME_BRIDGE_HOME !== $quotedState) throw Error('LAB17482_ENV_REQUIRED');"+[Environment]::NewLine
$serverCopy=Join-Path $serverDest 'bridge.mjs'
$rewritten=$sourceServer.Replace('process.env.CHROME_BRIDGE_PORT || 17381','process.env.CHROME_BRIDGE_PORT || 17482')
$enc=New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($serverCopy,($guard+$rewritten),$enc)
$mFile=Join-Path $extDest 'manifest.json'
$m=Get-Content -LiteralPath $mFile -Raw -Encoding UTF8 | ConvertFrom-Json
$m.name='Chrome Bridge PR113 LAB 17482'
$m.description='ISOLATED PR113 LAB ONLY - loopback 17482'
$m.host_permissions=@('http://127.0.0.1:17482/*')
[IO.File]::WriteAllText($mFile,($m|ConvertTo-Json -Depth 16),$enc)
Get-ChildItem -LiteralPath $extDest -Recurse -File |
 Where-Object {$_.Extension -in '.js','.json','.html'} |
 ForEach-Object {
   $raw=[IO.File]::ReadAllText($_.FullName)
   $changed=$raw.Replace('127.0.0.1:17381','127.0.0.1:17482')
   if($raw -cne $changed){[IO.File]::WriteAllText($_.FullName,$changed,$enc)}
 }
$leak=@(Get-ChildItem -LiteralPath $extDest -Recurse -File |
 Where-Object {$_.Extension -in '.js','.json','.html'} |
 Select-String -SimpleMatch '127.0.0.1:17381')
if($leak.Count){throw 'PRODUCTION_ENDPOINT_IN_STAGED_EXTENSION'}
$verifyManifest=Get-Content -LiteralPath $mFile -Raw -Encoding UTF8|ConvertFrom-Json
if($verifyManifest.host_permissions -notcontains 'http://127.0.0.1:17482/*' -or
 $verifyManifest.host_permissions -contains 'http://127.0.0.1:17381/*' -or
 $verifyManifest.host_permissions -contains 'http://127.0.0.1:17484/*'){
 throw 'LAB_MANIFEST_ENDPOINT_MISMATCH'
}
$files=@(Get-ChildItem -LiteralPath $target -Recurse -File | Sort-Object FullName)
$hashes=@($files|ForEach-Object{
 [pscustomobject]@{
   path=$_.FullName.Substring($target.Length+1);
   bytes=$_.Length;
   sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
 }
})
$evidence=[pscustomobject]@{
 status='PR113_LAB17482_STAGED_NOT_STARTED';
 sourceRoot=$source;port=17482;
 sourceProvenance='PINNED_GITHUB_ZIP_CLAIM_UNVERIFIED';
 targetRoot=$target;serverPath=$serverDest;extensionPath=$extDest;
 productionTouched=$false;serverStarted=$false;extensionInstalled=$false;
 files=$hashes
}
[IO.File]::WriteAllText((Join-Path $target 'pair-manifest.json'),($evidence|ConvertTo-Json -Depth 6),$enc)
Write-Output 'PR113_LAB17482_STAGED_NOT_STARTED'
Write-Output ('STAGE_ROOT: '+$target)
Write-Output ('STAGED_FILES: '+$hashes.Count)
Write-Output 'PR102_17484_UNCHANGED; PRODUCTION_UNCHANGED; E2E_NOT_RUN'
