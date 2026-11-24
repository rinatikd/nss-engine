# Consilium Control Room — MVP component architecture

## Components

- `consilium/control-room.mjs`: loopback HTTP server, bearer authentication, origin/host guards, API routes and process lifecycle.
- `consilium/event-ledger.mjs`: append-only JSONL event log, single-writer lock, sequence/hash validation, idempotent append, projections and state-transition validation.
- `consilium/provider-transport-v1.mjs`: versioned transport boundary for prepare/commit/status/reply-wait/stop/revoke/events, bound to provider origin, tab, conversation and fencing epoch.
- `consilium/chrome-bridge-provider-adapter.mjs`: concrete loopback MCP adapter. It requires an explicit endpoint and agent token; it never defaults to Production.
- `consilium/web/index.html`, `app.js`, `style.css`: browser interface, event timeline, session controls, decision review, task creation and contributor comments.
- `tests/`: Node built-in test suite. No real provider account or live browser is used.

## Data ownership

The event ledger is the durable source of truth. UI views are projections. Each write includes a stable request ID; repeated identical writes return the prior event, while reuse with a different payload returns `IDEMPOTENCY_CONFLICT`.

Actor identity is derived from the bearer token. Request bodies cannot assign or escalate actor roles. The owner is separate. All seven AI identities share the single authorization role `ai_member` and the same session-control, round-proposal, round-launch, review, task and evidence permissions; there is no operator/participant permission tier. ChatGPT and Claude remain the mandatory co-operator pair for independent dual review and coordination, not a higher trust or permission tier. Any AI member OBJECT / NEEDS_EVIDENCE verdict blocks progression until explicitly revised by that same member.

## Decision flow

A contributor may propose a decision. ChatGPT and Claude each submit their own review verdict. Routine reversible decisions become accepted only after both support. Consequential decisions move to `READY_FOR_OWNER` after both support and require a distinct owner approval event. Objections and missing evidence remain visible; a revised verdict references its previous review event and preserves the old verdict in history.

Tasks can be created only from accepted decisions. Any of the seven AI identities may update a task; assignee remains ownership metadata rather than an access restriction. Marking a task `VERIFIED` requires a 40- or 64-character commit SHA and at least one evidence reference.

## Round and transport flow

Any of the seven AI identities may propose and launch a previously proposed round while the session is RUNNING. Both proposal and launch are separate immutable journal events. ChatGPT and Claude remain the mandatory independent review pair, not an execution-authority tier.

`ProviderTransport` v1 defines prepare / commit / status / stop / revoke / events. It validates the exact provider-origin-tab-conversation-epoch identity, requires a prepared no-send side effect and fencing token, requires click evidence for SENT, preserves UNKNOWN with a quarantine ID, and refuses STOPPED_CLEAN without an independently verified epoch-bound quiescence attestation. The transport can be injected into Control Room as `providerTransport`. The optional `/api/provider/reply/wait` route accepts only the transaction identity, calls the transport's read-only correlated reply operation, validates the result via ProviderTransport, and appends the trusted receipt to the event ledger. It never initiates a send. CLI configuration requires both `CONSILIUM_CHROME_BRIDGE_ENDPOINT` and `CONSILIUM_CHROME_BRIDGE_AGENT_TOKEN`; the endpoint is explicit loopback and must be a disposable Lab port. If either setting is absent, the reply route remains disabled with HTTP 503.

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
