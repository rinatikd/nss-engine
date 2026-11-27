# R4 — Cooperative MV3 Mutation Cancellation

## Scope

This increment adds a best-effort, exact-document cancellation handshake for a journaled page mutation that has not crossed its first side-effect boundary. It is not a browser kill switch, does not undo a click, and does not authorize quarantine unlock.

## Identity contract

Every mutation has a unique durable journal `operationId`, captured `tabId`, `origin`, and exact main-frame `documentId`. The final page action receives that same operation ID and runs in the extension's `ISOLATED` world.

The page keeps a bounded per-document registry. Each cancellation receipt echoes the operation ID. The background dispatcher accepts a receipt only when:

- the tab is still on the captured exact origin;
- Chrome executed the cancel function against the exact recorded `documentId` and main frame;
- the receipt echoes the exact `operationId`;
- the receipt reports one of the two allowed no-side-effect terminal states; and
- `sideEffectStarted` is exactly `false`.

A missing, mismatched, late, timed-out, or malformed receipt is not permission to release a fence.

## The pre-injection race

There is a window after the durable `INJECTING` write and before Chrome begins the original `executeScript`. A Revoke during that window may reach the document before the original operation has registered itself.

To close that race, `cancel_operation` writes an operation-specific tombstone into the exact document's isolated-world registry when no operation entry exists. The later original injection checks that tombstone before it can cross any side-effect boundary and terminates as `MUTATION_CANCELLED_BEFORE_SIDE_EFFECT`. The tombstone is pinned in the bounded registry until the original operation consumes it; registry exhaustion rejects further operations rather than evicting a pending tombstone.

An operation ID already present in the registry cannot be overwritten or replayed. A previous terminal entry causes a duplicate page action to fail with `MUTATION_OPERATION_ALREADY_SEEN`.

## Side-effect boundary

The tracked page actions are:

- `browser_click`;
- `browser_fill`;
- `agent_send`;
- `provider_prepare`;
- `provider_commit`.

The operation checks its cancellation flag, then synchronously marks the side-effect boundary immediately before the first operation-specific DOM effect. There is no asynchronous yield between the final check and that mark.

Before the boundary, a matching terminal receipt can be recorded as `CANCELLED_BEFORE_SIDE_EFFECT`, outcome `NOT_PERFORMED`, side effect `none`. After the boundary, cancellation is refused. The existing command-specific receipt/journal rules remain authoritative:

- A provider commit or agent send after the boundary may already have been submitted; its status remains UNKNOWN if a validated receipt is lost. No retry is permitted.
- A provider prepare may leave an unsent composer draft; its draft status must not be silently cleared or described as no side effect.
- A generic click/fill may trigger asynchronous site handlers even after the injected function returns; function completion is not proof that the external effect settled.

## Revoke integration

Per-tab Revoke, Global Revoke/Clear, Session Revoke, and Stop enumerate outstanding `INJECTING` operation records and request exact-document cancellation before draining their mutation lanes. They retain the existing durable fences and quarantine behavior. A failed or unsafe cancellation does not clear a fence, restore a grant, or claim a clean stop.

The journal's new `CANCELLED_BEFORE_SIDE_EFFECT` terminal phase is accepted only from `INJECTING`. Recovery does not quarantine that proven no-effect terminal state. If the worker dies before the terminal event is durably written, the record remains `INJECTING` and is recovered as UNKNOWN; this is deliberately conservative.

## Test evidence required

The Visual RC includes a disposable real Chrome MV3 fixture for three distinct points:

1. Revoke before the page action registers: the exact operation tombstone blocks the subsequently delivered action; click count remains zero.
2. Revoke after registration but before the effect boundary: the original action acknowledges cancellation; click count remains zero; repeat Revoke returns the same safe terminal result.
3. Cancellation after a click: the receipt refuses safe release; the click count remains one; replaying the same operation ID is rejected.

Unit tests also verify the exact document target, operation ID echo, origin/tab change denial, malformed receipt denial, terminal journal transition, and restart recovery.

## Explicit limitations

- This does not cancel arbitrary website event handlers, fetch/XHR, provider generation or a request already accepted by a provider.
- A worker restart, empty lane map, missing target, timeout, navigation, BFCache transition, or tab ID alone is not quiescence evidence.
- A positive cancellation receipt is operation-specific evidence that this isolated-world function did not cross its first side-effect boundary; it is not evidence for any separate provider transaction.
- If the exact document is unavailable or a side effect has started, the operation remains unresolved/quarantined.
- No quarantine unlock, audit-driven operator recovery, grant restoration, automatic retry, or blanket clear is introduced.
- The per-document registry is deliberately bounded; if it cannot safely allocate an operation/tombstone slot, mutation fails closed.

## Release status

This feature is a prerequisite for reducing pre-side-effect races, not a release approval. Scenario A-D, the new cancellation integration, all unit/source/control-gate workflows, independent review, operator evidence/reconciliation, bounded journal retention/export, and isolated installation/rollback acceptance must all pass before R4 is declared ready.
