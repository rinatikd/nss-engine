# R4 live acceptance checkpoint — 2026-11-26

**Decision: DRAFT / NO-GO for Production.**  
**Source candidate:** `platform/ai-windows-control-release-20261114`  
**Latest platform head:** `b782d49bd4aec910862183f98d35a491884e8fd4`  
**Previously accepted source head:** `92ac1d8392805cc8accb2b25efc9012fc21bff29`  
**Checkpoint branch:** `docs/r4-live-acceptance-checkpoint-20261126`

This checkpoint separates current source/CI evidence from observations on the target Windows workstation. It does not authorize deployment, provider messaging, Production changes, or local mutation.

## 1. Source integration and CI

- PR #152, #153, #155, #156, #157 and #158 are merged into the R4 platform branch.
- PR #161 is now merged: the Windows ProviderJournal tab-fencing test no longer assumes one process will win a simultaneous lock race inside the finite 62 ms production lock budget. The separate multi-process append test remains the concurrent-writer test.
- PR #160 is merged: extension upgrade/rollback reports `INSTALLED_CLEANUP_PENDING` / `RESTORED_CLEANUP_PENDING` if post-swap cleanup fails, instead of reporting an already-committed replacement as a failed operation.
- PR #162 is merged: server cutover/rollback now treats successful health verification as the commit point; cleanup failure keeps the healthy server running, reports `UPGRADED_CLEANUP_PENDING` / `ROLLED_BACK_CLEANUP_PENDING`, and retains the durable backup rather than rolling back through a possibly partial displaced tree.
- PR #158 adds fail-closed verification that the existing and staged PR102 Lab manifest public key derives the expected unpacked extension ID `nhflbnfcaicihaepdcjacdmaddagcmcj`.
- The platform branch currently points to `b782d49bd4aec910862183f98d35a491884e8fd4`. The earlier accepted integration head `92ac1d8392805cc8accb2b25efc9012fc21bff29` had **17/17 exact-head check-runs SUCCESS**.
- PR #162 exact-head CI completed **15/15 SUCCESS**, including Windows PowerShell 5.1 server cutover/rollback tests and the cleanup-failure fixtures.
- CI for the latest platform merge commit `b782d49bd4aec910862183f98d35a491884e8fd4` has six checks in progress; do not carry forward the earlier 17/17 result as if it were the result for this newer head.
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


## 7. Follow-up Windows inventory reconciliation — 2026-11-26

A second, current connector path (WM43 Unified Approval Lab) was used for read-only inspection after the earlier Windows Maintenance backend returned `Unknown tool`.

### Current WM43 observations

- `maintenance_status` reports Windows Maintenance **0.4.3**, mode `approval-required`, `executionEnabled=true`, and per-operation local approval. R2 TCP port **17488** is reachable.
- `maintenance_inspect(service=R2)` reports the R2 listener owner is PID **17324**, `node.exe`, created **2026-11-19 00:09:30**. It also reports the R4 orchestrator directory present and the cutover manifest present (1170 bytes).
- The manifest SHA256 is deliberately not exposed by this inspection action; its result says it is available only through the file-proposal workflow. No file proposal or write was initiated.
- The inspect response labels its own execution context `executionEnabled=false` and `diagnosticsReadOnly=true`. Keep that separate from the service-level `maintenance_status` response (`executionEnabled=true`, per-operation local approval); neither grants unrestricted shell or mutation authority.

### Version discrepancy resolved

The earlier `Windows_Maintenance___Work_PC` connector path reported **0.4.1** but its inspect action returned `Unknown tool` / uninitialized-server errors. The current WM43 Unified Approval Lab path reports **0.4.3** and successfully returns the read-only process/staging inventory. Both report R2 port 17488 as reachable. The evidence therefore points to a stale/older connector backend or tool registry on the legacy path, not a verified downgrade of the active WM43 service. Use WM43 0.4.3 as the current observed path; retain the 0.4.1 response as historical connector evidence.

### Remaining inventory gap

This WM43 inspect action confirms R2 owner and basic R4 staging metadata, but it does **not** expose the PR102 Lab extension directory, 17485 StateRoot owner/ACL, manifest-derived extension ID, or the relationship between R2 and the PR102 Bridge process. Those are still unverified. PowerShell Direct Work PC probing remains deferred until 2026-11-27; do not bypass that timing through another execution route.

## 8. Latest platform CI reconciliation — 2026-11-26

The platform branch now points to `18dd9d23a035d794734eb7279f26a83c4f3ab33a`, the merge commit for the updated R4 acceptance checkpoint. Its exact-head GitHub check-runs are **17/17 SUCCESS**.

This closes the source/CI verification for the current platform head, but does not close G1–G6 live acceptance. R4 remains **DRAFT / NO-GO for Production** until the remaining Work PC identity/ACL, real provider E2E, recovery/reboot, and operator acceptance evidence is collected.


## 9. Prepared next read-only PR102 inventory sequence

The current repository includes two post-cutover read-only PowerShell Direct inspectors, both pinned to the approved workspace `C:\Engineering\ChromeBridge-Recovery-Install-20261114`:

1. `tools/powershell-direct/Inspect-PR102LabRoots.ps1`
   - Verifies the server root, unpacked extension root and dedicated 17485 StateRoot.
   - Reports reparse-point status, ACL owner/access summaries, manifest SHA256, manifest-derived extension ID, exact host permissions, endpoint literals, token lengths (never token values), backup directory names, and listeners on 17381/17382/17484/17485/17486/17487.
2. `tools/powershell-direct/Inspect-PR102LabRuntime.ps1`
   - Pins the loopback listener on 17485 to its owning process.
   - Reports executable, entry-point kind, working directory, `CHROME_BRIDGE_HOME`, port and extension-ID environment, config hash/token lengths, Chrome Secure Preferences extension-to-directory mapping, and extension/StateRoot ACL summaries.
3. `tools/powershell-direct/Probe-PR102AgentAdapters.ps1`
   - Performs authenticated, read-only MCP `tools/list`, `agent_list`, and `agent_selftest` calls.
   - Explicitly performs no drafts, sends, grants or provider mutations; checks config hash and listener identity before/after.
   - Expected to resolve the earlier connector-level `UNKNOWN_TOOL` ambiguity and establish the actual server registry and adapter selector evidence.

**Execution timing:** these Work PC PowerShell Direct checks remain deferred until **2026-11-27** as previously specified. Do not invoke them through another shell or approval path before then.

**Do not run** `Prepare-PR145LabPort17485.ps1` as a post-cutover inventory: its header explicitly marks it PRE-CUTOVER ONLY and it expects the old 17484 extension/StateRoot identity. The current target intentionally uses a legacy extension directory label `ChromeBridge-PR102-17484-Lab` with endpoint/StateRoot 17485. Use the two current inspectors above to avoid conflating directory name with runtime port.

## 10. Documentation PR and latest platform head

- PR #163 merged the WM43 inventory reconciliation and passed **12/12 exact-head check-runs**.
- Latest platform branch head after that documentation merge: `9230f0a0a1dec1cd152003c84e8bd3fcfcf3998f`.
- The PR #163 head's 12/12 checks passed; GitHub has not exposed additional check-runs for the resulting documentation merge commit at the time of this checkpoint.
- R4 remains **DRAFT / NO-GO for Production**. The next permitted step on 2026-11-27 is the three read-only inspections above, followed by evidence review before any Lab-only mutation is considered.
