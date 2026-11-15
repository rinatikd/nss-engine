# Execute the exact Node test files from an extracted GitHub source ZIP.
# No git metadata required. Does NOT stage, install, connect, or start anything.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [string]$Node = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference='Stop'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'TRUSTED_NODE_NOT_FOUND' }
$source=(Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).ProviderPath
$source=[IO.Path]::GetFullPath($source).TrimEnd([char]92)
if ($source -notmatch '(?i)^[a-z]:\\Engineering\\' -or
    $source -match '(?i)production|recovery-install|pr102') {
  throw 'SOURCE_MUST_BE_ISOLATED_C_ENGINEERING_FOLDER'
}
$required=@(
 'extension\package.json',
 'extension\manifest.json',
 'server\bridge.mjs',
 'tests\claude-bootstrap.test.mjs',
 'tests\gemini-bootstrap.test.mjs',
 'tests\discovery-only-agents.test.mjs',
 'tests\bootstrap-context.test.mjs',
 'tests\one-click-session.test.mjs',
 'tests\one-click-control-gate.test.mjs',
 'tests\paired-stage-paths.test.mjs',
 'tests\background-recovery-permissions.test.mjs',
 'tests\background-coordinator.test.mjs',
 'tests\transport-control-ack.test.mjs'
)
foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
    throw "PR113_ZIP_SOURCE_MISSING: $file"
  }
}
$meta=Get-Content -LiteralPath (Join-Path $source 'extension\package.json') -Raw -Encoding UTF8 |
  ConvertFrom-Json
if ($meta.type -ne 'module') { throw 'EXTENSION_ESM_METADATA_MISSING' }
# Release must run every checked-in Node unit test, not an outdated subset.
$tests=@(Get-ChildItem -LiteralPath (Join-Path $source 'tests') -Filter '*.test.mjs' -File |
  Sort-Object Name | ForEach-Object { $_.FullName })
if($tests.Count -lt 1){throw 'PR113_TEST_DISCOVERY_EMPTY'}
Write-Output "PR113_ZIP_UNIT_TESTS_START; Source: $source; Count: $($tests.Count)"
# Keep Node's assertion output and exit code verbatim.
& $Node --test @tests
$result=$LASTEXITCODE
if ($result -ne 0) { throw "PR113_ZIP_UNIT_TESTS_FAILED: exit=$result" }
Write-Output 'PR113_ZIP_UNIT_TESTS_PASS'
Write-Output 'SOURCE_PROVENANCE_NOTE: Directory contents were not verified against a Git commit; use only an archive downloaded directly from a pinned GitHub commit URL.'
Write-Output 'NOT_E2E_NOT_INSTALLED_NOT_STAGED'
