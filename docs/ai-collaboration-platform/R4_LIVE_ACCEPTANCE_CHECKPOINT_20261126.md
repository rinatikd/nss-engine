# R4 live acceptance checkpoint — 2026-11-26

**Decision: DRAFT / NO-GO for Production.**  
**Source candidate:** `platform/ai-windows-control-release-20261114`  
**Latest platform head:** `28161bd7680115080bfaccc8d5d9810cc0ab4e55`  
**Previously accepted source head:** `92ac1d8392805cc8accb2b25efc9012fc21bff29`  
**Checkpoint branch:** `docs/r4-live-acceptance-checkpoint-20261126`

This checkpoint separates current source/CI evidence from observations on the target Windows workstation. It does not authorize deployment, provider messaging, Production changes, or local mutation.

## 1. Source integration and CI

- PR #152, #153, #155, #156, #157 and #158 are merged into the R4 platform branch.
- PR #161 is now merged: the Windows ProviderJournal tab-fencing test no longer assumes one process will win a simultaneous lock race inside the finite 62 ms production lock budget. The separate multi-process append test remains the concurrent-writer test.
- PR #160 is now merged: extension upgrade/rollback reports `INSTALLED_CLEANUP_PENDING` / `RESTORED_CLEANUP_PENDING` if post-swap cleanup fails, instead of reporting an already-committed replacement as a failed operation.
- PR #158 adds fail-closed verification that the existing and staged PR102 Lab manifest public key derives the expected unpacked extension ID `nhflbnfcaicihaepdcjacdmaddagcmcj`.
- The platform branch currently points to `28161bd7680115080bfaccc8d5d9810cc0ab4e55`. The earlier accepted integration head `92ac1d8392805cc8accb2b25efc9012fc21bff29` had **17/17 exact-head check-runs SUCCESS**.
- CI for the latest platform merge commit `28161bd7680115080bfaccc8d5d9810cc0ab4e55` is running; do not carry forward the earlier 17/17 result as if it were the result for this newer head.
- PR #162 remains Draft: server cutover now separates healthy cutover from displaced-tree cleanup and retains the durable backup on cleanup failure. Its current exact-head checks are **14/15 success, 1 still running**; no merge until the final check completes.
- The legacy combined commit-status endpoint returned `pending` with no status contexts. This is not a failed check-run; report the two channels separately and do not claim that the legacy aggregate status is green.
- The platform branch compares to current `main` as **1485 commits ahead / 0 behind**. The merge base is current main `5bb86dff8f8a50483956fac5237d1f6942926855`. This is the intentionally separate R4 release track, not a claim that all 1485 commits are new feature changes.

## 2. Windows Maintenance / Work PC

Latest read-only `maintenance_status` response:

- service reports version `0.4.1`;
- mode `approval-required`;
- `executionEnabled=true`, with per-operation local approval required;
- R2 port `17488` is TCP reachable.

A previous checkpoint described version `0.4.3`. The version discrepancy is unresolved and must be reconciled against the actual process/package identity before acceptance.

The advertised read-only `maintenance_inspect` operation could not be executed: the backend returned `Unknown tool` / uninitialized-server errors. Consequently, this checkpoint does **not** verify R2 PID/image/command line, R4 staging metadata, PR102 StateRoot existence/ownership/ACL, extension directory identity, or listener-to-process association.

PowerShell Direct Work PC availability/probing remains deferred until 2026-11-27, per the operator's previously stated timing. No alternate shell or arbitrary command was used to bypass that deferral.

## 3. Chrome Bridge PR102 Lab observations

Latest PR102 Lab connector observations:

- `browser_status.connected=true`;
- `queued=0`;
- tabs are listed for Claude, Gemini, DeepSeek, Grok, Kimi and Qwen, plus restore/duplicate tabs.

These facts prove browser transport/tab enumeration only. They do not prove the expected extension ID, StateRoot/port identity, effective Control grant, provider authentication, or send/reply E2E.

The current `control_status` and `agent_list` calls returned `UNKNOWN_TOOL`; effective grants and pending approval count therefore remain unverified.

Read-only selector preflight results available in this session:

- Claude: composer 1 visible, Send 1 visible, reply selector 3 visible, Stop 0. This is selector evidence only, not a send/reply test.
- Qwen: composer selector matched 2 visible elements; configured Send/Stop/reply selectors matched 0. Adapter is not calibrated.
- Self-test calls for Gemini, DeepSeek, Grok and Kimi returned `UNKNOWN_TOOL`; no selector conclusion is drawn for those providers.
- DeepSeek's listed tab title indicates an inaccessible link. One Gemini tab is an inaccessible-link page; a separate Gemini home tab exists.
- Kimi's tab is readable and shows a prior PR148 work conversation, but that does not establish a current calibrated adapter or a new task response.

## 4. Source-level adapter safety

At the exact source head:

- Claude, Gemini and DeepSeek have non-empty default composer/Send/Stop/reply selectors.
- Grok, Qwen and Kimi default Send/Stop/reply selectors are intentionally empty pending live calibration. Their composer selectors exist.
- Kimi conversation identity routing for `https://www.kimi.ai/chat/<id>` is present.
- `page.js` rejects `provider_prepare` before composer mutation if the Send selector is empty or not unique. This is the intended fail-closed guard; do not bypass it by adding guessed selectors.
- Kimi contenteditable handling and identity regression coverage are present in the source/CI, but live Kimi send/reply remains unaccepted.

## 5. Release gate matrix

| Gate | Current status | Evidence still required |
|---|---|---|
| G1 Windows | BLOCKED / PARTIAL | Reconcile Maintenance version; restore working read-only inventory; verify R2 PID/image/command line; verify 17484 extension path, 17485 StateRoot, ACLs and exact extension ID; run approved Windows suites and record exact SHA/results |
| G2 Chrome | PARTIAL | Verify live extension ID, manifest host permission, isolated StateRoot/port, profile separation and reconnect/reboot behavior |
| G3 Providers | NOT ACCEPTED | Per-provider authenticated, explicitly approved single send → correlated reply → revoke for Claude, Gemini, DeepSeek, Grok, Qwen and Kimi; no retries after UNKNOWN |
| G4 Safety | CI PASS / LIVE PARTIAL | Real Chrome Stop/Revoke races, expiry, navigation, restart, tunnel loss/recovery, quarantine and no-duplicate-send evidence |
| G5 Packaging | CI PASS / LIVE PARTIAL | Exact packaged artifact inventory/SHA256, Windows upgrade/rollback rehearsal and operator evidence |
| G6 Acceptance | NOT DONE | Independent review, complete evidence ledger and explicit operator GO decision |

## 6. Current decision and next order

**R4 remains DRAFT / NO-GO for Production.** This is not a source-code rejection: the exact current source head's 17 GitHub check-runs passed. The blockers are live Work PC identity/inventory, provider E2E, live recovery/rollback and operator acceptance.

Next sequence:

1. Restore the read-only Maintenance inventory path and reconcile the reported 0.4.1/0.4.3 version discrepancy.
2. Verify the PR102 Lab extension directory, 17485 StateRoot, process/listener identity, ACLs and manifest-derived extension ID without changing either Lab or Production.
3. Run Lab-only recovery/upgrade and rollback on the exact source head after inventory is complete.
4. Verify reconnect/reboot and Stop/Revoke behavior.
5. Calibrate provider adapters only from observed live DOM evidence; then perform separately authorized per-provider E2E, one message at a time.
6. Close G1–G6 with dated evidence and independent review before preparing a final R4 release artifact.

No Production ports 17381/17382, credentials, tunnels, provider sessions, local files or Windows processes were changed by this checkpoint.
