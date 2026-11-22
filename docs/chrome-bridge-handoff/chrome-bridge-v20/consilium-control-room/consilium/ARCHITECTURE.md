# Consilium Control Room — MVP component architecture

## Components

- `consilium/control-room.mjs`: loopback HTTP server, bearer authentication, origin/host guards, API routes and process lifecycle.
- `consilium/event-ledger.mjs`: append-only JSONL event log, single-writer lock, sequence/hash validation, idempotent append, projections and state-transition validation.
- `consilium/web/index.html`, `app.js`, `style.css`: browser interface, event timeline, session controls, decision review, task creation and contributor comments.
- `tests/`: Node built-in test suite. No real provider account or live browser is used.

## Data ownership

The event ledger is the durable source of truth. UI views are projections. Each write includes a stable request ID; repeated identical writes return the prior event, while reuse with a different payload returns `IDEMPOTENCY_CONFLICT`.

Actor identity is derived from the bearer token. Request bodies cannot assign or escalate actor roles. The required identities are the owner, ChatGPT operator and Claude operator. Other providers are participants with equal contributor capabilities.

## Decision flow

A contributor may propose a decision. ChatGPT and Claude each submit their own review verdict. Routine reversible decisions become accepted only after both support. Consequential decisions move to `READY_FOR_OWNER` after both support and require a distinct owner approval event. Objections and missing evidence remain visible; a revised verdict references its previous review event and preserves the old verdict in history.

Tasks can be created only from accepted decisions. The assigned contributor may update their task. Marking a task `VERIFIED` requires a 40- or 64-character commit SHA and at least one evidence reference.

## Stop contract

The prototype can write `session.stop_requested`, increment the orchestration epoch and block future council dispatch when a real dispatcher is connected. It cannot recall a committed DOM click. The confirmation endpoint intentionally remains disabled until Bridge supplies an independently authenticated, signed, nonce- and epoch-bound quiescence attestation.

## Security notes

- Bind only to `127.0.0.1`.
- Require independently provisioned bearer secrets of at least 32 characters.
- Enforce exact Host and same-origin write checks.
- Set restrictive CSP and no-store headers.
- Reject common secret patterns in submitted event data.
- Use a single-writer lock and fsync each journal append.
- Verify the entire hash chain and semantic state during recovery.
- Treat external AI content as untrusted data, never as tool instructions.
