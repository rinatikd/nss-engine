# Read-only verification of an already staged disposable Chrome Bridge lab fixture.
# Does not access any live browser, server token, tunnel, or installed extension.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$LabRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($LabRoot)
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Lab directory does not exist' }
$manifestPath=Join-Path $root 'manifest.json'
$adapterPath=Join-Path $root 'adapters.js'
$pagePath=Join-Path $root 'page.js'
foreach($file in @($manifestPath,$adapterPath,$pagePath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Lab fixture missing: '+[IO.Path]::GetFileName($file)) }
}
$m=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($m.manifest_version -ne 3 -or $m.background.service_worker -ne 'background.js') { throw 'Unexpected MV3 background entry' }
if ($m.background.type -ne 'module') { throw 'MV3 background must be module' }
$hosts=@($m.host_permissions)
if ($hosts -notcontains 'http://127.0.0.1:17481/*') { throw 'Lab host 17481 not permitted' }
foreach($hostPattern in @('http://127.0.0.1/*','http://127.0.0.1:17381/*','https://*/*','<all_urls>')) {
  if ($hosts -contains $hostPattern) { throw ('Broad/production host permission in lab: '+$hostPattern) }
}
$adapters=[IO.File]::ReadAllText($adapterPath)
if (-not $adapters.Contains('button[data-testid="chat-input-send"]')) { throw 'Updated Claude selector missing' }
if (-not $adapters.Contains('button[mattooltip="Send"]')) { throw 'Updated Gemini selector candidates missing' }
$page=[IO.File]::ReadAllText($pagePath)
if (-not $page.Contains('r.diagnostics.sendCandidates = Object.fromEntries')) { throw 'Read-only send census missing' }
$files=Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName
foreach($file in $files) {
  if ($file.Extension -eq '.js') {
    $txt=[IO.File]::ReadAllText($file.FullName)
    if ($txt.Contains('http://127.0.0.1:17381')) { throw ('Production endpoint in staged JavaScript: '+$file.Name) }
  }
}
Write-Output ('[PASS] Isolated adapter package checks: files='+$files.Count)
foreach($file in $files) {
  $relative=$file.FullName.Substring($root.TrimEnd('\').Length+1).Replace('\','/')
  $sha=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Output ('[SHA256] '+$sha+'  '+$relative)
}
Write-Output '[NOTE] Checks packaged source only. No Chrome send, approval or remote provider reply was tested.'
