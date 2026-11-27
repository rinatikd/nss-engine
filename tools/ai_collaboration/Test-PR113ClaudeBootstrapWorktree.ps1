# Run PR113 Claude/Gemini bootstrap tests in a separate detached worktree.
# Requires a previously fetched exact commit. Never modifies the active branch,
# production services, credentials, or Chrome extension.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = 'C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$worktree = 'C:\Engineering\ChromeBridge-PR113-Bootstrap-Test'
$commit = '33bb43e9f9b4b67d91ba43de19b74ab1723adc47'
$relative = 'docs\chrome-bridge-handoff\chrome-bridge-v20'
$branch = 'platform/ai-windows-control-release-20261114'
if ((Get-Location).Path -ne $repo) { Set-Location -LiteralPath $repo }
$actualBranch=(& git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $actualBranch -cne $branch) { throw 'ACTIVE_BRANCH_UNEXPECTED' }
$state=@(& git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $state.Count -ne 0) { throw 'ACTIVE_WORKTREE_NOT_CLEAN' }
if (Test-Path -LiteralPath $worktree) { throw 'TEST_WORKTREE_ALREADY_EXISTS' }
# Download the exact branch into FETCH_HEAD without switching or resetting
# the current branch; then require the reviewed immutable SHA.
& git -c core.hooksPath=NUL -c protocol.ext.allow=never -c protocol.file.allow=never fetch --no-tags origin refs/heads/feature/chrome-bridge-one-click-all-tabs-20261114
if ($LASTEXITCODE -ne 0) { throw 'PR113_FETCH_FAILED' }
& git cat-file -e ($commit + '^{commit}')
if ($LASTEXITCODE -ne 0) { throw 'EXPECTED_PR113_COMMIT_NOT_FETCHED' }
& git -c core.hooksPath=NUL worktree add --detach $worktree $commit
if ($LASTEXITCODE -ne 0) { throw 'WORKTREE_CREATE_FAILED' }
$root=Join-Path $worktree $relative
$head=(& git -C $worktree rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $commit) { throw 'UNEXPECTED_TEST_COMMIT' }
$tests=Join-Path $root 'tests'
$targets=@('claude-bootstrap.test.mjs','gemini-bootstrap.test.mjs',
  'discovery-only-agents.test.mjs','bootstrap-context.test.mjs','one-click-session.test.mjs') |
  ForEach-Object {Join-Path $tests $_}
foreach($target in $targets){
 if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw 'BOOTSTRAP_TEST_NOT_FOUND' }
}
& node --test @($targets)
if ($LASTEXITCODE -ne 0) { throw 'BOOTSTRAP_TESTS_FAILED' }
$all=@(Get-ChildItem -LiteralPath $tests -Filter '*.test.mjs' -File | Sort-Object Name)
if ($all.Count -eq 0) { throw 'TESTS_NOT_FOUND' }
& node --test @($all.FullName)
if ($LASTEXITCODE -ne 0) { throw 'PR113_REGRESSION_FAILED' }
[pscustomobject]@{
 Result='PR113_CLAUDE_GEMINI_TESTS_PASS'
 Commit=$head
 TestFileCount=$all.Count
 MainBranchUnaffected=$true
 ChromeBridgeTouched=$false
 WorktreePath=$worktree
}|ConvertTo-Json -Compress
