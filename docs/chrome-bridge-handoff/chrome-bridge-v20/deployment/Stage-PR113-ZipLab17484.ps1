# Stage a paired PR113 lab from a verified-in-place ZIP extraction.
# No Git requirement, no service start, no Chrome installation, no token copy.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$OutputRoot
)
$ErrorActionPreference='Stop'
$node='C:\Program Files\nodejs\node.exe'
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'TRUSTED_NODE_NOT_FOUND'}
$source=(Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).ProviderPath.TrimEnd([char]92)
$target=[IO.Path]::GetFullPath($OutputRoot).TrimEnd([char]92)
$engineering='C:\Engineering'
if(-not $source.StartsWith(($engineering+'\'),[StringComparison]::OrdinalIgnoreCase) -or
   -not $target.StartsWith(($engineering+'\'),[StringComparison]::OrdinalIgnoreCase)){
  throw 'SOURCE_AND_OUTPUT_MUST_BE_INSIDE_C_ENGINEERING'
}
if($source -match '(?i)production|recovery-install|pr102' -or
   $target -match '(?i)production|recovery-install|pr102|17381|17382'){
  throw 'PROTECTED_PATH_DENIED'
}
if($target -ieq $source -or
   $target.StartsWith(($source+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase) -or
   $source.StartsWith(($target+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){
  throw 'OVERLAPPING_SOURCE_AND_OUTPUT_DENIED'
}
if(Test-Path -LiteralPath $target){throw 'OUTPUT_EXISTS_NO_OVERWRITE'}
$testRunner=Join-Path $source 'deployment\Test-PR113-ZipSource.ps1'
$build=Join-Path $source 'deployment\Build-OneClick-Lab.ps1'
$server=Join-Path $source 'server\bridge.mjs'
$manifest=Join-Path $source 'extension\manifest.json'
foreach($needed in @($testRunner,$build,$server,$manifest)){
  if(-not (Test-Path -LiteralPath $needed -PathType Leaf)){
    throw "ZIP_STAGE_REQUIRED_SOURCE_MISSING: $needed"
  }
}
# Always execute the exact unmodified repository tests before copying.
& $testRunner -SourceRoot $source -Node $node
if(-not $?){throw 'ZIP_SOURCE_TEST_RUNNER_FAILED'}
$serverRaw=[IO.File]::ReadAllText($server)
$portNeedle='export const PORT = Number(process.env.CHROME_BRIDGE_PORT || 17381);'
if(-not $serverRaw.Contains($portNeedle)){throw 'SERVER_SOURCE_PORT_ANCHOR_CHANGED'}
# Only the new stage root may be created; no source edits, no activation.
New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
$destServer=Join-Path $target 'server'
Copy-Item -LiteralPath (Join-Path $source 'server') -Destination $destServer -Recurse -ErrorAction Stop
$destState=Join-Path $target 'state'
New-Item -ItemType Directory -Path $destState -ErrorAction Stop | Out-Null
$stagedBridge=Join-Path $destServer 'bridge.mjs'
$expectedState=ConvertTo-Json -Compress $destState
$prefix="if (process.env.CHROME_BRIDGE_PORT !== '17484' || process.env.CHROME_BRIDGE_HOME !== $expectedState) throw Error('LAB17484_ENV_REQUIRED');"+[Environment]::NewLine
$serverRaw=$serverRaw.Replace('process.env.CHROME_BRIDGE_PORT || 17381','process.env.CHROME_BRIDGE_PORT || 17484')
[IO.File]::WriteAllText($stagedBridge,($prefix+$serverRaw),(New-Object Text.UTF8Encoding($false)))
& $build -LabPort 17484 -SourceRoot $source -OutputRoot $target
if(-not (Test-Path -LiteralPath (Join-Path $target 'extension-17484\manifest.json') -PathType Leaf)){
  throw 'EXTENSION_STAGE_INCOMPLETE'
}
$extManifest=Get-Content (Join-Path $target 'extension-17484\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($extManifest.host_permissions -notcontains 'http://127.0.0.1:17484/*' -or
   $extManifest.host_permissions -contains 'http://127.0.0.1:17381/*'){
  throw 'UNSAFE_STAGED_HOST_PERMISSION'
}
$items=@(Get-ChildItem -LiteralPath $target -Recurse -File | Sort-Object FullName)
$inventory=@($items | ForEach-Object {
  [pscustomobject]@{
    path=$_.FullName.Substring($target.Length+1);
    sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant();
    bytes=$_.Length
  }
})
$info=[pscustomobject]@{
  status='PR113_ZIP_PAIR_STAGED_NOT_INSTALLED';
  provenance='PINNED_COMMIT_ZIP_CLAIM_NOT_CRYPTOGRAPHICALLY_VERIFIED';
  sourceRoot=$source;
  outputRoot=$target;
  port=17484;
  serverPath=$destServer;
  extensionPath=(Join-Path $target 'extension-17484');
  productionTouched=$false;
  labStarted=$false;
  files=$inventory
}
[IO.File]::WriteAllText((Join-Path $target 'pair-manifest.json'),($info|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
Write-Output 'PR113_ZIP_PAIR_STAGED_NOT_INSTALLED'
Write-Output ('STAGE_ROOT: '+$target)
Write-Output ('FILE_COUNT: '+$inventory.Count)
Write-Output 'PRODUCTION_NOT_TOUCHED; NO_START_NO_INSTALL_NO_PAIRING'
