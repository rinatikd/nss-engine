# R4 MV3 Mutation Operation Journal

## Purpose

The journal supplies a durable write-ahead record for page mutations that previously had only an in-memory lane and a document-bound executeScript receipt. It is an evidence and quarantine mechanism. It is **not** an operator unlock mechanism and does not by itself prove that a provider-side effect has settled.

## Record model

Each operation has a separate chrome.storage.local record under the bridgeMutationOperation.v1. namespace. Only trusted extension contexts may access the store. The record contains:

- operation id, command class, tab id, origin, document id and main-frame id;
- SHA-256 of the exact tab URL (the URL itself is not persisted);
- conversation / provider request identifiers and payload hash where applicable;
- append-only, bounded phase events: ACCEPTED, INJECTING, then one terminal event;
- an immutable-identity SHA-256 digest bound into every event, event sequence, timestamp, previous-event hash, current hash, bounded result code and a fixed side-effect classification;
- a global operation index that hashes each operation identity in append order and detects missing, replaced or orphan records.

Message bodies, prompt text, field values, selectors, DOM text, tokens, cookies and provider response contents are not journal fields.

The current format has a maximum of 5,000 operation records and deliberately does not silently prune history. On capacity exhaustion, writes fail closed before page injection. A separate retention/export/compaction policy with its own integrity and recovery proof remains required before long-term production deployment.

The immutable operation identity is hashed separately and its digest is included in every event in the per-operation SHA-256 chain. A second global index hash-chain binds every operation id and identity digest in append order, so deletion of a whole record, loss of the index, or an orphan record is detected. Edits to tab/document/request identity or event metadata are also detected. This detects accidental corruption and simple field tampering. It is not a keyed MAC or an authenticity guarantee against a hostile local administrator or an actor able to rewrite extension storage and recompute hashes. Server-side HMAC journals remain the authoritative evidence for provider prepare/commit and agent-send transactions.

## Write-ahead and recovery rules

1. ACCEPTED is persisted before user approval is requested. If a worker restarts while only ACCEPTED exists, recovery records ABORTED_BEFORE_INJECTION; this proves this executor did not cross its injection boundary.
2. INJECTING is persisted with the exact Chrome documentId immediately before the one document-bound page mutation injection. A replacement worker converts an interrupted INJECTING operation to UNKNOWN and quarantines the tab.
3. A missing or ambiguous receipt after injection becomes UNKNOWN; automatic retries are prohibited.
4. A provider prepare may leave an unsent composer draft. That condition is recorded as composer-draft-state-unverified and quarantines the tab until the draft is reconciled.
5. A generic browser_click or browser_fill returning from the injected function is only evidence that the function returned. It is **not** proof that asynchronous site event handlers, navigation, requests or external side effects have settled. Such tabs are quarantined before the successful dispatch is acknowledged, and remain quarantined on recovery and during Stop/Revoke.
6. Provider commit / agent send retain their separate Bridge-side journals and receipt validation. The extension journal does not override a server-side UNKNOWN and never authorizes a retry.

Journal read, parse, integrity or write failures prevent new mutation admission. If quarantine cannot be persisted, a global quarantine lock is attempted. Neither a clean MV3 worker restart nor an empty in-memory lane is treated as proof that an old page execution context has stopped.

## Explicit limitations / release blockers

This increment intentionally does not ship a quarantine-clear or unlock control. Before a tab may be released, the separate operator-recovery design must be implemented and validated, including:

- exact document-execution quiescence / stale-generation fencing;
- operation-specific side-effect reconciliation, not merely an executeScript ACK;
- authoritative provider evidence for provider-side transactions; unresolved UNKNOWN operations remain permanently blocked;
- grant and session-lease revocation verification for the exact affected scope;
- append-only operator audit, a fail-closed UI, restart/race/storage-failure tests and a documented escalation path;
- a bounded retention/export/compaction policy for the local journal.

No manual storage edits, reload-only unlock, automatic grant restoration, repeated click, Send retry or blanket quarantine clear is permitted as a substitute.

## Validation

The automated suite covers write-ahead phase order, hash-chain validation, pre-injection abort, worker-restart recovery, generic page-side-effect quarantine, unsent-draft quarantine, invalid transitions, and storage read/write failures. The Visual RC workflow also checks module syntax and includes the new module in the isolated extension package.

These checks are not production acceptance. They do not test the user's installed Chrome extension identity/manifest or prove external provider-side completion. Production remains disabled until the full R4 release gates and operator recovery acceptance are complete.