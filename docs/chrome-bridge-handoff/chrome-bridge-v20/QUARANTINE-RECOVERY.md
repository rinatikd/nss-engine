# Chrome Bridge R4 — Operator Quarantine Reconciliation

**Implementation state:** candidate on `fix/r4-operator-quarantine-reconciliation-20261127`  
**Acceptance state:** PENDING — exact-head CI and independent review required  
**Production state:** NOT APPROVED

## Purpose and safety invariant

A provider action can cross an irreversible boundary (for example, a Send click) while its receipt is lost because an MV3 worker, Bridge process, or transport is interrupted. In that case the provider delivery result is `UNKNOWN`. The tab and, where applicable, the global mutation lane are quarantined.

This workflow permits an operator to reconcile *the admission fence* only after positively proving that the original page action has terminated. It does not turn an unknown delivery into a success or failure, does not alter ProviderJournal, and never retries the request.

**UNKNOWN remains UNKNOWN. A click attempt means DO NOT REPLAY.**

## Persisted operation identity

When a mutation is admitted, the coordinator captures a minimal identity record (no prompt text or provider reply text): tab ID, request ID, command, task/provider IDs, origin, conversation ID, epoch, payload digest, prepared ID, and admission timestamp.

A global pending-Revoke record stores the affected tab IDs and the corresponding minimal operation identities before lane draining begins. This allows a replacement MV3 worker to reconstruct reconcilable quarantine records after a restart. Legacy records without these bindings remain non-reconcilable and fail closed.

Per-tab quarantine metadata is written to local storage with session storage as the worker-lifetime fallback. The tab-ID deny list and its identity records are checked by mutation admission; malformed or conflicting state is treated as unavailable, never as an empty set.

## Positive terminal evidence

The provider page-action code owns an isolated-world lock while `provider_prepare` or `provider_commit` is executing. Its `finally` path writes a terminal marker only when that exact execution reaches the end of its control flow, then removes the matching lock.

The terminal marker binds:
- request ID and command;
- provider origin and conversation ID;
- page-action start and completion timestamps;
- terminal class (`COMMIT_CLICK_ATTEMPTED`, `COMMIT_NOT_CLICKED`, `PREPARE_MUTATION_FINISHED`, or `PREPARE_NO_MUTATION`);
- Send click attempted/returned flags;
- payload digest and prepared ID.

The coordinator probes the exact main frame in the extension isolated world. It requires the matching tab URL, origin, conversation, terminal identity, command-appropriate state, timestamps, payload digest and prepared ID. It rejects a live lock, absent marker, changed tab/document, probe timeout, stale token, storage conflict, or any mismatch.

A worker restart, elapsed timeout, successful Revoke-all, inactive tab, absent in-memory lane, or Bridge reconnect is not terminal evidence. If the original document was destroyed and its terminal marker is gone, the record cannot be reconciled through this workflow.

## Operator procedure

1. Open the trusted Chrome Bridge Control page and inspect **Восстановление карантина**.
2. Confirm the exact tab ID, request ID, command, reason, and conversation identity shown in the row.
3. Choose **Проверить завершение и снять карантин…**. The confirmation dialog warns that delivery is not verified and replay is forbidden.
4. The coordinator re-reads local/session state, validates the token and current approved provider tab, probes the original page-action lock/terminal marker, and re-reads the quarantine token before changing state.
5. It writes the operator audit event before removing any deny marker. The event includes operator confirmation/local gesture, scope, global fence token, terminal evidence, timestamps and document ID. The current event does not authenticate a named human; it proves only the trusted local Control UI confirmation/gesture. A production deployment must explicitly accept that local-machine trust boundary or integrate a verified operator identity source.
6. It removes only the exact quarantine token and corresponding per-tab fence. A recovered global fence is cleared only after every tab in its affected set has a matching audit event. Until then, global mutation admission remains blocked.
7. The UI reports that quarantine was reconciled while the source delivery outcome remains `UNKNOWN`. It never invokes `provider_prepare`, `provider_commit`, or any send action.

If the original action is still running, the marker is missing, or any check fails, the UI retains the quarantine and reports a blocking result. A storage write failure during audit or fence cleanup also retains a visible, retryable record. Audit writes are append-only through the supported Control UI path; storage exhaustion prevents reconciliation rather than dropping older audit entries.

## Special handling and non-recoverable cases

- **Commit click attempted:** delivery remains `UNKNOWN`; do not replay. Check the provider conversation manually before creating a new request.
- **Prepare-only action:** delivery was not committed by this action, but an exact composer draft may remain. Inspect and clear it before beginning a new request.
- **Global quarantine lock:** a separate `bridgeMutationQuarantineLock` caused by storage failures is not cleared by this workflow. It requires separate investigation.
- **Legacy or incomplete quarantine metadata:** no request binding means no operator unlock. Quarantine stays.
- **Page navigated/reloaded or isolated-world terminal marker lost:** no positive proof; quarantine stays.
- **Multiple affected tabs:** each tab requires its own terminal proof and audit. One tab's reconciliation cannot clear the global admission fence while another remains unresolved.
- **Partial cleanup:** records remain visible and the same token can be retried. A stale or replaced token cannot remove a newer quarantine.
- **Audit persistence failure:** no quarantine or global fence is removed.

## Validation required

The following tests are required on the exact candidate PR head:

1. Unit: active mutation lock blocks reconciliation.
2. Unit: absent/mismatched terminal evidence, stale token, changed identity and separate global quarantine lock block reconciliation.
3. Unit: global fence remains until all affected tabs have their own audit events.
4. Unit: partial local/session global-fence cleanup leaves the quarantine visible and retry succeeds after the storage failure is removed.
5. Real disposable Chrome MV3 + HTTP MCP Scenario D: lose the post-click receipt, perform Revoke, restart worker and Bridge, verify ProviderJournal remains UNKNOWN, prove reconciliation is denied while the old page action is held, release it, then reconcile using its terminal marker. Assert one Send click, no replay, exact audit, removal of the appropriate fences, and unchanged ProviderJournal UNKNOWN state.
6. Independent security/lifecycle review of source, test hooks, persistence ordering, and all partial-write paths.

Passing this checklist does not establish live provider send/reply acceptance, local Windows operator acceptance, or Production readiness. Those remain separate release gates.
