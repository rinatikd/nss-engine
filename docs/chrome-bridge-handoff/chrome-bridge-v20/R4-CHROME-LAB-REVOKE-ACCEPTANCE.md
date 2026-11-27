# R4 Chrome Lab — Revoke, Worker Recovery and Quarantine Acceptance

**Status: NOT EXECUTED — release gate.** This document defines the isolated Chrome MV3 acceptance run for the R4 Revoke-fence stack (#165–#167). It is a test plan, not evidence of a PASS. Keep all PRs Draft and do not merge or deploy until the gates below are closed.

## Safety boundary

- Use only the disposable Chrome Lab profile, isolated extension build, and isolated lab server.
- Do not use the production profile, production ports, credentials, provider sessions, live AI chats, or production tunnel.
- Use a deterministic local test page / fixture for page mutations. No real message submission.
- Record the exact extension artifact SHA, source commit, Chrome version, lab server endpoint, test start/end time, and sanitized logs.
- Any uncertain result is **UNKNOWN** and remains blocked. Never convert timeout, Worker termination, storage failure, or missing evidence into SUCCESS.
- Do not clear quarantine by editing Chrome storage manually or by deleting markers in DevTools.

## Current implementation finding

The coordinator persists per-tab quarantine in `bridgeMutationQuarantinedTabs` and a global fail-closed lock in `bridgeMutationQuarantineLock`. The Control UI reports failed clear/revoke outcomes and affected tab IDs. The reviewed coordinator/UI paths do not expose a dedicated operator reconciliation workflow that proves an uncertain page action has ended and then safely clears quarantine/global lock.

The existing `clear-background-controls` command is a Revoke/Clear operation; it is **not** proof that an earlier UNKNOWN action completed. It must not be treated as a quarantine-unlock operation.

**Release blocker:** define, implement, independently review, and test an explicit operator recovery/reconciliation path before R4 production release. Until then, quarantine is intentionally sticky. No automatic unlock is permitted.

## Acceptance scenarios

For every scenario capture: expected result, actual result, timestamped coordinator/UI logs, persisted local/session storage state, and test artifact SHA. Mark PASS only when all assertions are directly observed.

### A. Per-tab Revoke fence

1. Start the isolated background transport and grant temporary Control to one disposable fixture tab.
2. Start a deliberately held page mutation; verify it is admitted and visible as in-flight.
3. Issue per-tab Revoke while the mutation is held.
4. Verify the Revoke admission marker is durably written before waiting for the grant-store operation.
5. Attempt a second page mutation and a new Grant for the same tab. Both must be rejected while Revoke is pending.
6. Terminate/restart the MV3 service worker while the fence is pending. The replacement Worker must still reject page mutations and Grants using durable state.
7. Release the held mutation. Verify Revoke completes, grant removal is confirmed, and only then are the per-tab pending markers cleared.
8. Verify a fresh Grant is possible only after the confirmed Revoke has completed and no quarantine/global lock applies.

**PASS criteria:** no post-Revoke admission; replacement Worker preserves the fence; no premature marker deletion; no false SUCCESS.

### B. Per-tab uncertain completion and quarantine

1. Inject a controlled timeout or storage/grant-store failure at each Revoke boundary: marker write, grant-store revoke, and marker cleanup.
2. Verify the response is `UNKNOWN`, includes the affected tab ID, and the tab is durably quarantined (local storage preferred; session fallback accepted only as specified by the implementation).
3. Restart the Worker and repeat page mutation and Grant attempts. Both must remain blocked.
4. Simulate local and session storage read/write failures and conflicting state. The coordinator must fail closed; it must not infer an empty quarantine set from unreadable state.
5. Verify the UI does not display a successful revoke or imply that the tab is safe to reuse.

**PASS criteria:** uncertainty remains visible and durable; all mutation and Grant paths deny; no automatic quarantine removal.

### C. Global Session Revoke

1. Open at least two disposable fixture tabs with temporary grants; start one held page mutation.
2. Dispatch `session_revoke`.
3. Verify the global pending record (token and affected tab IDs) is persisted before draining.
4. Attempt new page mutations, new Grants, and `session_authorize`. All must be rejected while global Revoke is pending.
5. Restart the Worker during the drain. Verify the replacement Worker continues to reject those operations.
6. Release the held mutation and allow the revoke/cleanup path to finish.
7. Verify the global marker is cleared only after the revoke is confirmed and affected tabs are not silently restored.
8. If the replacement Worker cannot prove completion of the prior Worker’s action, it must quarantine affected tabs and report `UNKNOWN`.

**PASS criteria:** global fence covers all tabs and Grant entry points; authorization cannot race through; uncertain recovery quarantines every recorded affected tab.

### D. Control UI clear-background-controls

1. With multiple disposable grants, invoke the UI Revoke-all action.
2. Verify no new page mutation or Grant is admitted during the clear.
3. Restart the Worker with a global clear pending and verify the durable fence remains effective.
4. Verify successful clear is shown only after all accepted mutations drain, all grants are cleared, and the global pending marker is safely removed.
5. Force a timeout, partial storage failure, or uncertain cleanup. UI must show failure/UNKNOWN and affected tab IDs; no success toast/status is allowed.
6. Retry the clear operation only as a Revoke/Clear attempt. Confirm it does not erase an existing quarantine or global quarantine lock.

**PASS criteria:** UI status matches coordinator outcome; retry cannot silently unlock quarantined tabs.

### E. Quarantine recovery / operator reconciliation — currently NOT IMPLEMENTED

Before release, define a separately authorized recovery action with all of these safeguards:

- Explicit operator initiation from the trusted Control UI; no background or timer-driven recovery.
- Show exact affected tab IDs, quarantine reason, originating Revoke token/epoch when available, and time of the uncertain operation.
- Prove the old page operation is no longer in flight. A Worker restart, elapsed timeout, successful Revoke-all, tab inactivity, or missing in-memory lane is not sufficient proof by itself.
- Reconcile authoritative grant/session state and verify no pending global or per-tab Revoke marker remains.
- Require a fresh explicit confirmation scoped to the displayed tab(s); global unlock requires a separate explicit confirmation and proof for every affected tab.
- Persist an append-only audit record of operator, scope, evidence, decision, and result. If audit persistence fails, keep quarantine.
- Clear only the exact reconciled quarantine entries using compare-and-swap/token matching; preserve unrelated or newer quarantine entries.
- On any missing evidence, storage disagreement, stale token, or partial write, retain quarantine and report UNKNOWN.
- Never clear the global quarantine lock while any tab remains unresolved.

**Acceptance criteria:** positive recovery test with authoritative proof; negative tests for stale token, missing proof, partial storage failure, unrelated quarantine entry, and concurrent new Revoke; audit record verified; all failures remain fail-closed.

## Evidence and release decision

| Gate | Evidence required | Status |
| --- | --- | --- |
| Source/CI for #165–#167 | Exact-head green checks; retain check-run URLs and SHAs | CI reported green; independent review pending |
| Per-tab Revoke in real Chrome MV3 | Scenarios A and B with logs and storage snapshots | NOT RUN |
| Global Session Revoke in real Chrome MV3 | Scenario C with Worker restart | NOT RUN |
| Control UI clear/retry | Scenario D with UI and coordinator evidence | NOT RUN |
| Operator quarantine recovery | Scenario E implemented, independently reviewed, and tested | BLOCKED — workflow absent |
| Independent security/lifecycle review | Signed or attributable PASS/FAIL review of the combined stack | PENDING |
| Release packaging/rollback | Immutable artifact inventory, isolated install, rollback rehearsal | PENDING |

## Release rule

R4 is **NO-GO** while any real Chrome Lab scenario is unrun, operator recovery is absent, any independent review is missing, or any result is UNKNOWN. Green CI alone does not close these gates. Do not remove Draft status, merge, tag, or deploy based solely on this checklist.
