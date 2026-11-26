# R4 — Operator Quarantine Recovery Design

**Status: DESIGN PROPOSAL — NOT IMPLEMENTED.** This document defines a fail-closed recovery protocol for the durable Revoke/quarantine work in PRs #165–#168. It does not authorize clearing existing quarantine, changing runtime behavior, or deploying to production.

## 1. Problem statement

The coordinator persists per-tab quarantine (`bridgeMutationQuarantinedTabs`) and a global quarantine lock (`bridgeMutationQuarantineLock`). It also persists pending per-tab/global Revoke fences. These records survive MV3 service-worker replacement, unlike in-memory mutation lanes and flags.

A replacement Worker cannot infer that an old page action stopped merely because its own in-memory lane map is empty. The old Worker may have disappeared while an injected page script or provider action was still running. Therefore:
- Worker restart is not completion evidence.
- An empty in-memory mutation lane is not completion evidence.
- A timeout is not completion evidence.
- A successful later Revoke/Clear is not completion evidence for a prior ambiguous page action.
- Deleting a marker or manually editing Chrome storage is never an accepted recovery method.

The recovery protocol must distinguish **permission revocation** from **resolution of an uncertain side effect**. Revoking access prevents future work; it does not undo or explain an already accepted action.

## 2. Existing execution semantics that recovery must preserve

The current mutation dispatcher accepts `browser_click`, `browser_fill`, `agent_send`, `provider_prepare`, and `provider_commit` as mutation classes. Provider operations are bound to request/task IDs, provider, tab, origin, conversation, epoch, prepared ID, payload hash, and (for commit) fencing token.

Important distinctions:
- A `provider_prepare` action is designed never to click Send. If its response is lost after injection, the dispatcher can classify the submission as `NOT_PERFORMED`, but the composer draft may remain unverified.
- A `provider_commit` action is a submission side effect. If execution started and the receipt is missing/invalid, the outcome remains `UNKNOWN`; it must not be retried automatically.
- Generic page mutations may have their own side effects and require operation-specific reconciliation. Do not infer their semantics from provider_prepare.

Any recovery ledger must retain this operation classification and avoid flattening all UNKNOWN states into one generic "safe" state.

## 3. Threat model

Recovery must resist:
1. MV3 Worker termination between page-action admission and completion receipt.
2. A delayed old page script completing after a replacement Worker starts.
3. Concurrent per-tab Revoke, global Session Revoke, Stop, clear-background-controls, and recovery attempts.
4. Local/session storage partial failure, stale replicas, conflicting tokens, and lost writes.
5. Stale or replayed operator confirmation.
6. Tab ID reuse, navigation, origin changes, SPA conversation changes, and document replacement.
7. Duplicate provider commit after a lost receipt.
8. UI spoofing, untrusted message senders, and recovery requests not originating from the trusted extension Control UI.
9. Audit persistence failure or truncation.
10. A compromised or stale recovery path clearing a newer quarantine record.

Security objective: no recovery transition may admit new page mutations or grants unless the old operation state and the relevant permission state have been reconciled with authoritative evidence.

## 4. State model

Use a versioned, durable per-scope recovery record. Proposed logical states:

- `QUARANTINED`: mutations and grants denied; reason and evidence references retained.
- `RECONCILING`: an operator has started a bounded reconciliation attempt; all fences remain active.
- `RESOLVED_SAFE`: evidence proves no unresolved side effect remains and old execution context cannot continue.
- `RESOLVED_SIDE_EFFECT_UNKNOWN`: the old action may have taken effect; this is terminal for automatic recovery and remains blocked pending a separate domain-specific resolution.
- `UNLOCKED`: only the exact reconciled quarantine generation was cleared after audit commit.

Do not represent these states using a single boolean alone. Each record should include:
- schema version;
- scope (`tab` or `global`) and exact affected tab IDs;
- monotonically increasing generation and random recovery token;
- originating Revoke token/epoch and quarantine reason;
- accepted operation IDs and operation classes, where available;
- tab/document identity captured at admission (tab ID, origin, URL identity, document/frame identity when supported);
- timestamps for admission, uncertainty, reconciliation start and completion;
- references to operation-journal receipts, not message bodies or secrets;
- current state and bounded machine-readable reason code.

No prompt text, message bodies, access tokens, cookies, browser keys, or provider secrets may be copied into this record or the audit trail.

## 5. Required durable operation journal

Before introducing an unlock action, add a durable operation journal (or prove an existing journal provides equivalent guarantees) that is written before page-action injection. It must be shared across Worker replacement and use atomic/serialized updates.

Minimum record:
- unique operation ID and idempotency key;
- operation class and provider adapter version;
- tab ID + document binding + origin + conversation binding;
- request/task/prepared IDs and payload hash only;
- Revoke generation/fencing token at admission;
- phase: `ACCEPTED`, `INJECTING`, `PAGE_ACKNOWLEDGED`, `COMPLETED`, `ABORTED_BEFORE_INJECTION`, or `UNKNOWN`;
- validated receipt type and timestamp;
- terminal-state writer and journal generation.

Rules:
- Persist `ACCEPTED` before any page mutation is injected.
- Persist `INJECTING` immediately before injection.
- Persist a validated terminal receipt after injection returns.
- A journal write failure before injection must prevent injection.
- A journal write failure after injection must leave the operation UNKNOWN and preserve quarantine.
- Never retry an UNKNOWN `provider_commit` based solely on absence of a receipt.
- Duplicate operation IDs with different payload hashes or bindings are conflicts and fail closed.
- Journal records are not deleted as part of ordinary recovery; retention/compaction is a separate audited policy.

If the current ProviderJournal does not support these exact transitions and guarantees, extend it in a separately reviewed PR before building the UI unlock flow.

## 6. Reconciliation protocol

### Phase A — enter recovery

1. Require a trusted user gesture from the extension Control UI and an authenticated coordinator sender.
2. Read local and session copies of the global/per-tab fences and quarantine records.
3. If either store is unreadable, records disagree, schema is unknown, generation/token conflicts, or an affected tab list cannot be reconstructed, stop with UNKNOWN and keep the global lock.
4. Acquire a durable recovery lease using compare-and-swap against the exact quarantine generation/token. The lease blocks other recovery attempts; it does not relax mutation fences.
5. Persist an audit `RECOVERY_STARTED` event before displaying that reconciliation has begun. If the audit write fails, abort and retain quarantine.

### Phase B — reconcile accepted operations

For every operation accepted under the affected tab/global generation:
1. Read the authoritative operation journal.
2. Require a valid terminal receipt or a proof that injection never began.
3. For `provider_prepare`, distinguish "submission not performed" from "composer draft may remain". The draft is not a sent message, but must be disclosed to the operator and must not be silently erased.
4. For `provider_commit`, require a validated commit receipt or an authoritative provider-side reconciliation that identifies whether the exact request was submitted. A missing receipt is not proof of non-submission.
5. For generic page actions, require a command-specific terminal proof. If no such proof exists, the operation remains UNKNOWN.
6. If a page execution context may still be active, require evidence that it has been terminated. A Worker restart or a missing in-memory lane is insufficient. If this cannot be proven non-destructively, keep quarantine. Do not silently reload or close the user's tab as a recovery shortcut.

### Phase C — reconcile tab and permission identity

For each affected tab:
1. Verify the tab still exists and is bound to the same expected origin/provider/document identity. Tab ID alone is insufficient because IDs and page state can change.
2. Verify no pending per-tab or global Revoke record remains for the generation being reconciled.
3. Revoke all old per-tab grants and Session Authorization leases using the normal serialized control-store path.
4. Read back the authoritative grant/session stores and verify the old grant/lease is absent.
5. Any mismatch, partial write, storage fallback disagreement, navigation race, or newer Revoke generation aborts recovery.

A successful permission revoke is necessary but is not sufficient to resolve an ambiguous page side effect.

### Phase D — operator decision and unlock

The Control UI must show, for each tab:
- tab ID plus a safe display label/origin;
- quarantine reason and time;
- operation IDs/classes and their terminal/UNKNOWN state;
- whether a provider prepare draft may remain;
- whether a commit or other side effect is confirmed, not performed, or unresolved;
- evidence sources and any missing evidence.

The operator must confirm the exact displayed scope. Global recovery requires a separate confirmation after every affected tab has independently passed reconciliation. No "unlock all" shortcut.

Before clearing:
1. Persist audit `RECOVERY_RESOLVED` with evidence references and operator confirmation.
2. Re-read the exact quarantine generation/token and pending Revoke state.
3. Clear only the exact reconciled entries using compare-and-swap. Never clear a newer or unrelated entry.
4. Keep the global quarantine lock while any tab remains unresolved.
5. Verify local and session stores agree after the write.
6. Persist audit `RECOVERY_UNLOCKED`. If this final audit write fails, restore/retain the lock where safely possible; otherwise write failure must be surfaced as UNKNOWN and the system must not admit new mutations.
7. Only then permit a new explicit Grant/Session Authorization. Recovery itself never restores grants.

## 7. Mandatory fail-closed outcomes

| Condition | Required outcome |
| --- | --- |
| Worker restarted; no terminal operation receipt | UNKNOWN; quarantine retained |
| `provider_commit` injected; receipt lost | UNKNOWN; no retry; quarantine retained |
| `provider_prepare` injected; response lost | Submission NOT_PERFORMED only if adapter contract proves no Send; disclose draft uncertainty |
| Journal missing/corrupt/unreadable | UNKNOWN; global lock retained |
| Local/session storage disagreement | UNKNOWN; global lock retained |
| Tab identity changed or tab ID reused | UNKNOWN; quarantine retained; require new scope review |
| Old page execution may still be active | UNKNOWN; quarantine retained |
| Old grant/lease still present | Recovery fails; revoke and verify before any unlock |
| Newer Revoke generation appears during recovery | Abort stale recovery; newer fence wins |
| Audit persistence fails | Abort/UNKNOWN; do not unlock |
| Operator declines or closes dialog | No state change; quarantine retained |

## 8. Concurrency and fencing requirements

- Reconciliation must use the same serialized fence lane as Revoke/clear operations, or a strictly ordered successor lane with explicit generation checks.
- Stop, global Revoke, per-tab Revoke, and new Grant must invalidate any in-progress recovery lease.
- A recovery lease must never clear a fence created after the lease began.
- New page mutation and Grant paths must check durable quarantine and recovery state immediately before admission and again before injection.
- A recovery command must be idempotent for the same token and generation. A replay with a stale token must fail.
- Partial writes must never produce an unlocked state in one store while the other still reports quarantine. If atomic cross-store commit is unavailable, use a monotonic two-phase protocol whose intermediate state remains blocked.

## 9. Audit requirements

Append-only audit events:
- `RECOVERY_STARTED`
- `OPERATION_RECONCILED`
- `GRANTS_REVOKED_AND_VERIFIED`
- `RECOVERY_RESOLVED`
- `RECOVERY_UNLOCKED`
- `RECOVERY_ABORTED`

Each event includes schema version, event ID, timestamp, operator/session identity available from the trusted extension context, scope, quarantine generation/token hash, operation IDs, reason codes, evidence references, and outcome. Do not log message bodies, prompts, tokens, cookies, or secrets. Audit append failure is a hard failure.

## 10. Test plan before implementation approval

### Unit and fault-injection tests
- Journal persistence before injection; no injection on journal failure.
- Crash at every transition: ACCEPTED, INJECTING, page receipt, terminal journal write, grant revoke, quarantine CAS, audit append.
- Duplicate/replayed recovery token; stale generation; conflicting local/session copies.
- Concurrent per-tab/global Revoke, Stop, clear, Grant, and recovery.
- Tab ID reuse, navigation, origin/provider/conversation change.
- Missing/corrupt journal, unavailable storage, quota errors, partial writes.
- UNKNOWN commit never retried; prepare draft uncertainty is surfaced.
- Exact-scope unlock cannot remove unrelated/newer quarantine entries.
- Audit append failure never unlocks.
- Global lock remains while any affected tab is unresolved.

### Real disposable Chrome MV3 tests
- Terminate Worker immediately before and after page injection.
- Terminate Worker after page side effect but before receipt persistence.
- Restart Worker while page script is deliberately held.
- Attempt page mutation, Grant, Session Authorization, Stop, and second Revoke during reconciliation.
- Verify UI shows evidence and refuses unlock when any proof is missing.
- Positive unlock only after all journal, document, permission, and audit checks pass.
- Verify a new explicit Grant is required after recovery.

No real provider chat submission is permitted for these tests. Use a local deterministic fixture and a fake provider adapter.

## 11. Rollout sequence / approval gates

1. Independent design review of this document (security + MV3 lifecycle + provider-journal semantics).
2. Inspect the actual ProviderJournal implementation and prove whether it can support the required write-ahead and terminal-receipt guarantees.
3. Implement journal changes in a separate PR with crash/fault-injection tests.
4. Implement coordinator reconciliation state machine in a separate PR; keep unlock disabled by default.
5. Implement Control UI evidence display and explicit per-scope confirmation.
6. Independent code review and full CI.
7. Disposable Chrome Lab acceptance using the scenarios above.
8. Only after all gates pass, enable the operator unlock action in a separately versioned release candidate.

**Current decision: NO-GO for quarantine unlock implementation that relies only on existing in-memory lanes or current Revoke markers.** The durable operation journal and command-specific side-effect reconciliation are prerequisites. Until then, keep quarantine sticky and R4 unreleased.


## 12. Source review update — existing ProviderJournal

A focused review of `server/provider-journal.mjs` on the #167 code head found that the repository already has a substantial durable provider transaction journal. The design above must reuse and extend this mechanism where appropriate rather than creating a second unrelated provider journal.

Observed capabilities in the current source:
- JSONL append-only transaction records with sequence numbers, previous-record hash, HMAC record validation, and fail-closed handling for malformed, oversized, or unreadable journal files.
- Inter-process lock around load/append and projection refresh; append path uses fsync.
- Provider transaction states include `PREPARING`, `PREPARED`, `COMMITTING`, `SENT`, `REPLIED`, `UNKNOWN`, `NOT_PERFORMED`, `BLOCKED`, `REVOKED`, `STOP_REQUESTED`, `STOPPED_CLEAN`, and `STOP_AFTER_COMMIT`.
- Startup recovery converts transactions found in `PREPARING`, `PREPARED`, or `COMMITTING` to `UNKNOWN` with reason `BRIDGE_RESTART`.
- `beginPrepare` / `completePrepare` and `beginCommit` / `completeCommit` persist provider transaction boundaries; commit completion requires a validated clicked-send receipt.
- `status`, per-tab outstanding transaction counts, epoch revocation, and stop/quiescence methods exist. `STOPPED_CLEAN` carries a signed quiescence attestation, and unresolved transaction states prevent a clean stop.
- Epoch revocation converts uncertain in-flight provider transactions to `UNKNOWN`, not a clean terminal success.

### Important limitations still to close

1. This is a **server-side provider transaction journal**, not proof that every extension-side page mutation (including generic `browser_click`, `browser_fill`, or `agent_send`) is durably journaled before injection.
2. The ProviderJournal's restart recovery marks in-flight provider transactions UNKNOWN; it does not prove that an old injected page script has ceased execution.
3. The journal's per-tab stop/quiescence evidence is provider-transaction scoped. It is not automatically a global Chrome page-execution quiescence proof for every mutation type.
4. A `REQUEST_NOT_FOUND` status is only useful as evidence when the caller has established the correct journal lineage, bridge epoch, exact identity, and complete authoritative journal. It must not be used as a generic absence-means-not-performed shortcut.
5. The existing journal does not itself implement the Control UI operator reconciliation/unlock workflow for `bridgeMutationQuarantinedTabs` or `bridgeMutationQuarantineLock`.

### Revised implementation sequence

1. Add an explicit adapter/service contract that correlates coordinator mutation admission with ProviderJournal transaction identity and epoch. Verify the correlation survives Worker replacement.
2. Extend durable write-ahead coverage to generic page mutation classes, or explicitly exclude them from automatic recovery and require persistent quarantine.
3. Reuse ProviderJournal terminal states and signed quiescence attestations for provider operations; do not mint a second conflicting source of truth.
4. Define a separate, narrowly scoped browser-execution quiescence proof for injected page scripts. Until this exists, a provider journal terminal record alone is insufficient to unlock a tab if an old page execution may still be active.
5. Add recovery state and audit records in a separate layer, with exact generation/token compare-and-swap and no grant restoration.
6. Only then implement the Control UI flow and real Chrome Lab tests.

**Updated decision:** ProviderJournal is a strong existing foundation, so a wholly new provider journal is not required. However, it is not sufficient by itself to unlock Chrome tab quarantine. Generic mutation coverage and browser execution quiescence remain prerequisites; otherwise keep the affected tab/global lock quarantined.


## 13. Source review update — Bridge orchestration and SendJournal

Further inspection of `server/bridge.mjs`, `server/send-journal.mjs`, and `server/tools.mjs` refines the coverage map:

- `provider_prepare` and `provider_commit` are orchestrated through `ProviderJournal`. The server writes the provider transaction boundary before enqueueing the corresponding page action, validates the page receipt, then persists the terminal state. Startup recovery marks in-flight provider transactions UNKNOWN.
- `agent_send` is separately protected by `SendJournal`. It writes a request entry with initial status UNKNOWN before enqueueing `agent_send`; duplicate request IDs are not dispatched again; the journal stores HMAC fingerprints and transport metadata, not message bodies or replies. Writes use a lock, temporary file, fsync, and atomic rename. A failed settle leaves the write-ahead UNKNOWN record in place.
- The Bridge command queue retains the single-writer slot after a dispatched timeout and marks the command UNKNOWN until a late acknowledgement arrives or the Bridge process is deliberately restarted. This avoids overlapping a still-running DOM action within that process.
- The documented tool surface exposes provider status/revoke/stop/events, including signed provider quiescence evidence. These mechanisms are useful inputs to recovery, not a general browser-tab unlock operation.

### Corrected mutation coverage matrix

| Mutation class | Existing durable evidence | Remaining recovery limitation |
| --- | --- | --- |
| `provider_prepare` | ProviderJournal write-ahead and validated prepare receipt; restart converts in-flight state to UNKNOWN | May leave an unsent composer draft; journal state alone does not terminate a still-running old page script |
| `provider_commit` | ProviderJournal write-ahead, validated click receipt, UNKNOWN on ambiguity; no automatic retry | UNKNOWN means submission may have happened; requires provider-side reconciliation and execution-context quiescence |
| `agent_send` | SendJournal write-ahead UNKNOWN, duplicate suppression, HMAC fingerprints, durable settle | Transport/delivery ambiguity remains UNKNOWN; does not itself prove old page script stopped |
| `browser_click` / `browser_fill` | Coordinator mutation lanes/fences and Bridge single-writer queue | No equivalent durable operation journal found in the reviewed path; keep quarantine sticky unless separate durable evidence is added |
| Session-wide Revoke / Control UI clear | Durable coordinator global pending record and affected tab list | Does not resolve each operation's side effect or prove browser execution quiescence |

### Updated prerequisite

Do not build a duplicate journal for provider_prepare/provider_commit or agent_send. First expose a narrow read-only recovery evidence API over the existing ProviderJournal and SendJournal, with exact identity checks and authenticated access. Add write-ahead operation coverage for `browser_click` / `browser_fill` if these remain supported mutation paths under the relevant control scope. Then add browser execution quiescence evidence. Until all evidence for an affected tab is terminal and consistent, do not unlock that tab.
