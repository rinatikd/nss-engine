# Chrome Bridge PR #97 — isolated adapter acceptance

**State:** source and Windows CI package checks PASS; live Gemini send button and end-to-end message delivery **NOT TESTED**.

## Observed non-mutating evidence

On the installed, **older** production extension, ChatGPT MCP `browser_status` and `agent_list` returned connected, with alive Claude/Gemini/DeepSeek tabs. The old `agent_selftest` reported composer 1 for Claude and Gemini, send 0 for both. A Claude `button[data-testid="chat-input-send"]` element was independently seen in metadata and remained disabled while input was empty. Seven specific Gemini candidate selectors returned zero matches while composer was empty. No text was entered or sent.

GitHub Actions on `8ddb0dbe706627a80d7a3e0fc6d76ab76521b033`: Source checks, Chrome Bridge Visual RC and RC1 Control Gates PASS. Windows PowerShell 5.1 CI staged the extension and ran `verify-adapter-lab.ps1` to check the selectors, diagnostics, isolated `17481` manifest/JS and inventory SHA-256. Synthetic source tests and CI are **not** live browser acceptance.

## Read-only local preparation (never overwrite production)

Use a **separate** checked-out PR #97 worktree and a **new empty** lab output directory. Example, adapted to a verified local repository checkout:

```powershell
$repo = 'C:\Engineering\ChromeBridge-RC1-Source'
$branch = 'fix/bridge-claude-gemini-send-adapters-20261106'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$worktree = "C:\Engineering\ChromeBridge-Adapters-Source-$stamp"
$lab = "C:\Engineering\ChromeBridge-Adapters-Lab-$stamp"
git -C $repo fetch origin $branch
if ($LASTEXITCODE -ne 0) { throw 'Fetch failed' }
git -C $repo worktree add --detach $worktree "origin/$branch"
if ($LASTEXITCODE -ne 0) { throw 'Isolated worktree setup failed' }
$candidate = Join-Path $worktree 'docs\chrome-bridge-handoff\chrome-bridge-v20'
& (Join-Path $candidate 'deployment\stage-background-lab.ps1') -BridgeRoot 'C:\Engineering\chrome-bridge' -CandidateRoot $candidate -OutputRoot $lab
if ($LASTEXITCODE -ne 0) { throw 'Dry run failed' }
& (Join-Path $candidate 'deployment\stage-background-lab.ps1') -BridgeRoot 'C:\Engineering\chrome-bridge' -CandidateRoot $candidate -OutputRoot $lab -Apply
if ($LASTEXITCODE -ne 0) { throw 'Stage failed' }
& (Join-Path $candidate 'deployment\verify-adapter-lab.ps1') -LabRoot $lab
if ($LASTEXITCODE -ne 0) { throw 'Isolated lab verification failed' }
```

The script only reads the installed MV3 manifest and a limited set of declared icon images. It does not modify the installed extension, credentials, server, tunnel, or any Chrome profile. **Do not load this lab package into the production Chrome profile**. Any new extension ID needs separate lab-only server origin pinning before connection; do not repin production.

## Remaining real browser gates

1. Load the staged lab extension in a **disposable Chrome profile**, with the lab server on `127.0.0.1:17481` pinned to the resulting extension ID and isolated keys. No production port changes.
2. With a non-sensitive approved test chat, run the **read-only** `agent_selftest` for Claude/Gemini, inspect `sendCandidates` metadata; confirm no accidental selection of unrelated buttons.
3. Only with a fresh per-action local approval, test a single explicit test message, verify `agent_wait` and independently attribute a response. No automatic retries on UNKNOWN.
4. Verify deny, revoke, expiry, navigation and rollback. Capture source SHA and redacted proof. Until then, keep PR in draft and production unchanged.

This document grants no blanket permission to send messages to external AI services.
