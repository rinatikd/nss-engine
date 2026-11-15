# Run PR113 Claude bootstrap tests in a separate detached worktree.
# Requires a previously fetched exact commit. Never modifies the active branch,
# production services, credentials, or Chrome extension.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = 'C:\Engineering\ChromeBridge-Recovery-Install-20261114'
$worktree = 'C:\Engineering\ChromeBridge-PR113-Bootstrap-Test'
$commit = 'e3282f6f0b9157ee6028edbbbe896e1466d0f957'
$relative = 'docs\chrome-bridge-handoff\chrome-bridge-v20'
$branch = 'platform/ai-windows-control-release-20261114'
if ((Get-Location).Path -ne $repo) { Set-Location -LiteralPath $repo }
$actualBranch=(& git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $actualBranch -cne $branch) { throw 'ACTIVE_BRANCH_UNEXPECTED' }
$state=@(& git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $state.Count -ne 0) { throw 'ACTIVE_WORKTREE_NOT_CLEAN' }
if (Test-Path -LiteralPath $worktree) { throw 'TEST_WORKTREE_ALREADY_EXISTS' }
# The earlier fetch wrote the commit to FETCH_HEAD, but did not create
# refs/remotes/origin/feature/... . We pin the exact reviewed commit instead.
& git cat-file -e ($commit + '^{commit}')
if ($LASTEXITCODE -ne 0) { throw 'EXPECTED_PR113_COMMIT_NOT_FETCHED' }
& git -c core.hooksPath=NUL worktree add --detach $worktree $commit
if ($LASTEXITCODE -ne 0) { throw 'WORKTREE_CREATE_FAILED' }
$root=Join-Path $worktree $relative
$head=(& git -C $worktree rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $commit) { throw 'UNEXPECTED_TEST_COMMIT' }
$tests=Join-Path $root 'tests'
$target=Join-Path $tests 'claude-bootstrap.test.mjs'
if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw 'CLAUDE_TEST_NOT_FOUND' }
& node --test $target
$claudeExit=$LASTEXITCODE
if ($claudeExit -ne 0) { throw 'CLAUDE_BOOTSTRAP_TEST_FAILED' }
$all=@(Get-ChildItem -LiteralPath $tests -Filter '*.test.mjs' -File | Sort-Object Name)
if ($all.Count -eq 0) { throw 'TESTS_NOT_FOUND' }
& node --test @($all.FullName)
if ($LASTEXITCODE -ne 0) { throw 'PR113_REGRESSION_FAILED' }
[pscustomobject]@{
 Result='PR113_CLAUDE_BOOTSTRAP_TESTS_PASS'
 Commit=$head
 TestFileCount=$all.Count
 MainBranchUnaffected=$true
 ChromeBridgeTouched=$false
 WorktreePath=$worktree
}|ConvertTo-Json -Compress
