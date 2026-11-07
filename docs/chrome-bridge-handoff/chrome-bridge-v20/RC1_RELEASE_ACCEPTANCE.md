# Chrome Bridge RC1 — Release Acceptance and Rollback

**Status:** NO-GO pending site-specific Windows end-to-end evidence. Do not deploy or merge as a final production release merely because source/CI tests are green.

## Scope and isolation

- Candidate: PR #97 `fix/bridge-claude-gemini-send-adapters-20261106` based on the Chrome Bridge RC1 integration PR #95.
- Lab only: separate Windows Chrome profile, unpacked extension, localhost `127.0.0.1:17481`, independent synthetic/lab credentials.
- Production `127.0.0.1:17381`, MCP proxy `127.0.0.1:17382`, production tokens, tunnel, normal Chrome profile and personal AI conversations must remain untouched throughout acceptance.
- Every potentially destructive action requires a backup first, a documented restoration path, and explicit scope.
- Never retry `agent_send` automatically after `UNKNOWN`; reuse the exact `requestId` for idempotent inspection, not a different ID.

## Automated evidence — verified 2026-11-07

| Release gate | Evidence | State |
| --- | --- | --- |
| Source checks, Control Gates, Visual RC | GitHub Actions commit `f2604248e54f07479489cc42bec2e4b67112df71` | PASS |
| Real Linux Chrome for Testing MV3 service worker | `node --test tests/mv3-browser-smoke.test.mjs` | PASS |
| Real offscreen document and extension reload | `node --test tests/mv3-offscreen-recovery.test.mjs` | PASS |
| Real panel close/reopen, background persistence, Stop | `node --test tests/mv3-background-lifecycle.test.mjs` | PASS |
| Real loopback synthetic server restart/recovery | `mv3-offscreen-recovery.test.mjs` | PASS |
| Concurrent send, loss of ACK, persisted journal after server restart | `node --test tests/agent-send-concurrency.test.mjs` | PASS |
| Control negative tests: deny, expiry, revoke, tab and conversation changes | `node --test tests/mutation-dispatch.test.mjs` (mock Chrome APIs) | PASS |
| Windows PowerShell stage/rollback and manifest isolation | Native Windows Actions job (disposable fixture) | PASS |
| Lab artifact file-hash manifest | `deployment/write-lab-release-manifest.ps1` and CI attachment | Verify current-head workflow and artifact |

The real-browser tests above use **isolated synthetic servers and no real provider send**. Their PASS does not close the following release gates.

## Mandatory independent acceptance — not yet proven

All items below require **actual evidence** from the isolated Windows lab (or a similarly authorized disposable Windows Chrome environment). Do not use personal production chats as substitutes.

1. Confirm isolated extension ID and that its manifest can access only 17481, never 17381. Capture sanitized version and SHA-256 of the staged source package.
2. Confirm background connection with panel open, panel closed, and panel reopened. Restart isolated Chrome and verify state and one offscreen context. Stop/revoke, then confirm no unintended reconnect.
3. Check a dedicated new provider conversation in Claude and Gemini with stable verified origin and conversation ID. Clear drafts. On each send, require opt-in background Control, time-scoped grant and **a separate local approval**. Prove one send and matching response through `agent_send` / `agent_wait`.
4. Repeat authorization-negative scenarios against the actual installed extension: user denial, revoked Control, expired grant, revoked host permission, navigation / conversation switch while approval is pending, and rejection of a stale pending command. Count actual browser actions, not just UI messages.
5. Check DeepSeek independently, including its adapter self-test, verified conversation ID, permitted send, reply attribution and error handling. Mark BLOCKED if authentication, page state or adapter prevents verification.
6. Stop the isolated 17481 process in the lab and restart it. Verify background recovery and absence of duplicates or unintended replay after missing result ACK.
7. Test installation + rollback of the exact staged candidate on a **disposable installation**, compare hashes and verify restored original manifest and files. Do not modify the production installation.
8. Obtain attributable independent assistant reviews and address blocking findings; unacknowledged GitHub comments are assignments, not reviews.

## Release rule

**GO** only if every mandatory gate has a timestamped PASS and a command/output or screenshot-backed record, all known high/critical bugs are fixed and regression tested, all applicable CI workflows are successful on the exact intended release commit, and rollback is verified. **NO-GO** if any mandatory gate is FAIL, BLOCKED, or NOT RUN.

## Evidence protocol

For each test record: UTC timestamp, environment (OS, Chrome build, extension ID, exact commit, lab-only port), command invoked, sanitized output, observed vs expected result, PASS/FAIL/BLOCKED, issue and fix commit where applicable. Never print or commit access tokens, user messages or personal site content.

The staged release is verified by the SHA-256 entries in `chrome-bridge-rc1-lab-evidence.json`. This manifest is **not a deployed production package**. The candidate package is source-only; the separate Windows lab staging process generates `manifest.json` from the pre-existing allowed installed manifest and excludes production access.

## Rollback

1. Capture a backup and SHA-256 of the current disposable lab extension before applying the candidate.
2. Disconnect and stop only the disposable lab Bridge and Control; verify no pending approved mutations.
3. Revert the isolated extension to the backup; restore its original manifest and local settings; ensure no secrets are copied to the release artifact.
4. Reopen the disposable Chrome profile and verify that the old lab version works, and that there is no production port leakage.
5. Record restoration output and hashes. Never roll back the production instance as part of lab acceptance.

See `deployment/upgrade-windows.ps1` for source backup/restore behavior and `deployment/stage-background-lab.ps1` for the isolated lab fixture. Both should be run with **explicit paths** so the default production `BridgeRoot` cannot be selected accidentally.
