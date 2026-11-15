# Pair-stage PR113 browser extension + server into a NEW isolated directory.
# This is a build/test tool, not a production updater. It never starts services.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCommit,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [string]$SourceRoot=(Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference='Stop'
$node='C:\Program Files\nodejs\node.exe'
$git='C:\Program Files\Git\cmd\git.exe'
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'TRUSTED_NODE_NOT_FOUND'}
if(-not (Test-Path -LiteralPath $git -PathType Leaf)){throw 'TRUSTED_GIT_NOT_FOUND'}
$source=(Resolve-Path -LiteralPath $SourceRoot).ProviderPath
$repoRoot=(& $git -C $source rev-parse --show-toplevel 2>$null)
if($LASTEXITCODE -ne 0 -or !$repoRoot){throw 'SOURCE_NOT_IN_GIT'}
$head=(& $git -C $repoRoot rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $head -cne $ExpectedCommit){throw 'SOURCE_COMMIT_MISMATCH'}
$dirty=@(& $git -C $repoRoot status --porcelain --untracked-files=no)
if($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){throw 'SOURCE_TRACKED_FILES_DIRTY'}
$base='C:\Engineering'
$normalized=[System.IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
if(!$normalized.StartsWith(($base+'\'),[StringComparison]::OrdinalIgnoreCase) -or
    $normalized -match '(?i)production|pr102|chrome-bridge-pr113-e2e-build-v2|chrome-bridge-recovery-install'){
  throw 'OUTPUT_MUST_BE_NEW_ISOLATED_ENGINEERING_DIRECTORY'
}
if(Test-Path -LiteralPath $normalized){throw 'OUTPUT_EXISTS_NO_OVERWRITE'}
$testFiles=@(
 'tests\claude-bootstrap.test.mjs',
 'tests\gemini-bootstrap.test.mjs',
 'tests\discovery-only-agents.test.mjs',
 'tests\bootstrap-context.test.mjs',
 'tests\one-click-session.test.mjs'
)
foreach($rel in $testFiles){
 if(!(Test-Path -LiteralPath (Join-Path $source $rel) -PathType Leaf)){
   throw "TEST_FILE_MISSING: $rel"
 }
}
$testPaths=@($testFiles|ForEach-Object {Join-Path $source $_})
& $node --test @testPaths
if($LASTEXITCODE -ne 0){throw 'LAB_NODE_TESTS_FAILED_NO_STAGE'}
$serverSource=Join-Path $source 'server'
$extSource=Join-Path $source 'extension'
if(!(Test-Path (Join-Path $serverSource 'bridge.mjs')) -or
   !(Test-Path (Join-Path $extSource 'manifest.json'))){
 throw 'PAIR_SOURCE_MISSING'
}
New-Item -ItemType Directory -Path $normalized -ErrorAction Stop|Out-Null
$serverDestination=Join-Path $normalized 'server'
Copy-Item -LiteralPath $serverSource -Destination $serverDestination -Recurse -ErrorAction Stop
$build=Join-Path $PSScriptRoot 'Build-OneClick-Lab.ps1'
& $build -LabPort 17484 -SourceRoot $source -OutputRoot $normalized
if($LASTEXITCODE -ne 0){throw 'EXTENSION_BUILD_FAILED'}
$extensionDestination=Join-Path $normalized 'extension-17484'
$manifest=Get-Content -LiteralPath (Join-Path $extensionDestination 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.host_permissions -notcontains 'http://127.0.0.1:17484/*' -or
   $manifest.host_permissions -contains 'http://127.0.0.1:17381/*'){
 throw 'STAGED_EXTENSION_HOST_PERMISSIONS_UNSAFE'
}
# Build an immutable inventory. Any later edit invalidates source hashes.
$files=@(Get-ChildItem -LiteralPath $normalized -Recurse -File | Sort-Object FullName)
$inventory=@($files|ForEach-Object{
 [pscustomobject]@{path=$_.FullName.Substring($normalized.Length+1);
   bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$result=[pscustomobject]@{
 status='PAIR_STAGED_NOT_INSTALLED';pr113Commit=$head;labPort=17484;
 serverPath=$serverDestination;extensionPath=$extensionDestination;
 testCount=$testFiles.Count;fileCount=$inventory.Count;
 installedLabTouched=$false;productionTouched=$false;
 notes='Do not start this server on port 17484 while another lab server is listening. Pairing and credentials require a separate operator-reviewed plan.'
 files=$inventory
}
$utf8=New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $normalized 'pair-manifest.json'),
 ($result|ConvertTo-Json -Depth 8),$utf8)
$result|Select-Object status,pr113Commit,labPort,serverPath,extensionPath,testCount,fileCount,installedLabTouched,productionTouched|ConvertTo-Json
