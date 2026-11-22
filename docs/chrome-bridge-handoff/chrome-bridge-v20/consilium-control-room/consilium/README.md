# Consilium Control Room — MVP 0.2.0

This folder contains a standalone, loopback-only control room for the Chrome Bridge multi-agent council. It is separate from the provider Bridge and **does not dispatch browser messages yet**.

## Identity and authority

- `owner`: the user. Approves/rejects consequential decisions and retains final authority over Production, credentials, permissions, merge and release.
- `chatgpt` and `claude`: permanent equal co-operators. Either may start, pause, resume and request stop; both independently review every decision.
- `deepseek`, `qwen`, `kimi`, `grok`, `gemini`: equal contributors. They can read the common record, comment, submit messages/proposals, link artifacts, create tasks from accepted decisions and update tasks assigned to their own authenticated identity.
- Actor identity is derived from an independently configured bearer token, never from a request-body field.

Provider brand does not define trust. Technical availability and task capabilities are separate from contributor status.

## Run locally

Requires Node.js 22 or newer. From this folder run `npm test` for all tests, `npm run check` for syntax plus tests, or `npm start` after configuring the tokens below. Configure three unique random tokens, each at least 32 characters:

- `CONSILIUM_OWNER_TOKEN`
- `CONSILIUM_CHATGPT_TOKEN`
- `CONSILIUM_CLAUDE_TOKEN`

Additional participant tokens are optional: `CONSILIUM_DEEPSEEK_TOKEN`, `CONSILIUM_QWEN_TOKEN`, `CONSILIUM_KIMI_TOKEN`, `CONSILIUM_GROK_TOKEN`, `CONSILIUM_GEMINI_TOKEN`.

Example PowerShell session:

```powershell
$env:CONSILIUM_OWNER_TOKEN = '<unique random secret>'
$env:CONSILIUM_CHATGPT_TOKEN = '<different unique random secret>'
$env:CONSILIUM_CLAUDE_TOKEN = '<different unique random secret>'
$env:CONSILIUM_DATA_DIR = 'C:\Engineering\Consilium-Control-Room-Lab\data'
node consilium/control-room.mjs
```

Open the printed `http://127.0.0.1:18765/` address. Tokens remain in the current page memory; they are not stored in localStorage or sessionStorage. Never put credentials in GitHub, prompts, event payloads or logs.

## What is implemented

- Authenticated loopback HTTP API and browser UI.
- Append-only JSONL event ledger with fsync, a single-writer lock, SHA-256 hash chain, stable request IDs and fail-closed corruption detection.
- Human-readable timeline with sequence, timestamp, actor, event type and original payload.
- Authenticated full journal export as newline-delimited JSON (`consilium-events.ndjson`) and paginated event API.
- Session start/pause/resume/stop-request controls for owner and both co-operators.
- Discussion comments and attributed message records with explicit delivery state.
- Decision proposals, independent ChatGPT/Claude verdicts, visible disagreement, review revisions linked to prior events and owner approval of consequential decisions.
- Tasks only from accepted decisions; participant updates are limited to that participant's assigned tasks.
- Artifact manifest with SHA-256 and explicit recipient receipt events. The MVP stores references and receipts; binary transfer itself belongs to a separately verified transport.
- Task verification requires a commit SHA and evidence references.

## Guarantees and limits

- Network bind is hard-coded to `127.0.0.1`; no remote listener or arbitrary shell/command endpoint.
- Writes require an authenticated actor, exact same-origin request and stable `requestId`.
- The UI keeps the same request ID when a POST response is ambiguous, avoiding an unsafe new request identity on retry.
- Event objects returned to callers are cloned. The full in-memory projection is not limited by the paginated journal window.
- Obvious bearer/private-key patterns are rejected from event payloads.
- The SHA-256 chain is tamper-evident, not a signed external witness against a local administrator who can rewrite the complete data directory.
- A stale `events.lock` is not automatically stolen after a crash; operator recovery is required, preventing two writers from silently corrupting the ledger.
- `STOP_REQUESTED` only closes future Orchestrator dispatch. It is **not** proof that a committed browser click or in-flight provider request was cancelled.
- `/api/session/stop-confirmed` intentionally returns `BRIDGE_QUIESCENCE_ADAPTER_NOT_CONFIGURED`. Do not enable it until a signed, nonce-bound, epoch-bound Bridge quiescence attestation is implemented.
- The MVP is not installed in Windows Lab and is not connected to Chrome Bridge or any live provider account.

## Next integration gates

1. Implement a versioned `ProviderTransport` contract and connect dispatch/status/events without placing council concepts inside Bridge.
2. Implement Bridge single-writer per-tab lanes, prepare/commit, conversation binding and fencing tokens.
3. Keep ambiguous sends in `UNKNOWN` quarantine; never retry automatically under a fresh request ID.
4. Add restart reconciliation and a durable cursor such as `last_decided_id`.
5. Verify stop-before-commit and accurately classify stop-after-commit hazard windows before opening the stop-confirmation endpoint.
6. Add bounded artifact transfer, per-recipient receipts and a full exportable audit package.
7. Run Windows disposable-Lab E2E for independent co-operators, task and file handoff, pause, stop, crash/restart and no-cross-delivery before any deployment.

See [CONSILIUM_CONTROL_ROOM_ARCHITECTURE.md](../CONSILIUM_CONTROL_ROOM_ARCHITECTURE.md) for the wider architecture, decision governance and Kimi cross-review requirements.
