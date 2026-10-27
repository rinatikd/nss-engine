# A2A-style task ledger + dispatcher (working model)

Node >= 22.13 (built-in `node:sqlite`), no dependencies.

    node --no-warnings --test tests/*.test.mjs     # 22 tests
    node --no-warnings src/demo.mjs                # ChatGPT -> Claude(mock) -> verify -> corrective task

## What it takes from A2A
Task lifecycle (submitted, working, input_required, completed, failed, canceled) + `unknown`,
contextId, parentId (corrective chains), artifacts, events (history). Not implemented: A2A transport,
Agent Card, auth, streaming -> this is the data/state model, not a conformant A2A server.

## Guarantees (and the test that proves each)
- Idempotent submit: same id+content = duplicate, same id+different content = conflict (ledger.test)
- Atomic claim: 8 OS processes, one winner (concurrency.test)
- Exactly-once dispatch: 4 processes drain 24 tasks, 24 sends (concurrency.test)
- Write-ahead marker before any send; fencing token + lease; stale owner's late result is recorded, never applied
- kill -9 after claim -> requeue; after marker/after send -> UNKNOWN, never auto-resent (crash.test)
- UNKNOWN has no exit for the dispatcher; only LedgerOperator can close it (completed/canceled); redo = new id
- Corrective tasks: bounded depth and per-context budget; built only from the sender's task text and whitelisted
  problem codes, never from reply text (flow.test)

## Not proven
- Power-loss durability (relies on SQLite WAL + synchronous=FULL; untested). kill -9 is tested.
- Real adapters: only MockAdapter exists. A real Claude/Codex/Chrome Bridge adapter must return
  {text, invocationId}, throw NotDispatched only with proof of non-delivery, otherwise the task goes UNKNOWN.
- Authentication/signing of senders; multi-host operation (SQLite is single-host).

## HTTP API (v0.2.0)

The project now includes a minimal local HTTP facade in `src/server.mjs`:

- `GET /.well-known/agent-card.json` — public Agent Card
- `GET /health` — liveness check
- `POST /v1/tasks` — submit (Bearer token required)
- `GET /v1/tasks/:id` — inspect task (Bearer token required)
- `GET /v1/tasks/:id/events` — inspect event history (Bearer token required)
- `POST /v1/tasks/:id/cancel` — cancel a cancellable task (Bearer token required)

Start on Node >= 22.13:

```powershell
$env:A2A_DB = 'C:\a2a\ledger.db' # absolute path
$env:A2A_API_TOKEN = 'replace-with-a-random-secret-at-least-24-characters'
$env:A2A_HOST = '127.0.0.1'
$env:A2A_PORT = '8787'
$env:A2A_DEFAULT_RECIPIENT = 'codex'
npm start
```

Example request:

```powershell
$headers = @{ Authorization = "Bearer $env:A2A_API_TOKEN" }
$body = @{ id='task-001'; contextId='project-1'; recipient='claude'; text='Review the change and list risks.' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/v1/tasks' -Headers $headers -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/v1/tasks/task-001' -Headers $headers
```

The service binds to loopback by default. Do not expose it to a LAN or the public Internet without TLS, stronger identity/authorization, rate limits, and deployment-specific hardening. The current bearer token is one shared client credential; it does not provide per-agent roles. The API is a project-specific REST facade, not yet a full JSON-RPC A2A protocol implementation. The Agent Card is a minimal discovery document and still needs conformance validation against the target A2A specification/version.

The HTTP service only submits and inspects tasks. It does not start a real Codex/Claude process or a Chrome Bridge worker. A separate dispatcher process and a real adapter are still required for end-to-end execution. Do not interpret a successful HTTP submission as proof that an external agent has received or completed the task.

## A2A JSON-RPC binding and bridge worker (v0.3.0)

The HTTP service now exposes an A2A-style JSON-RPC 2.0 endpoint at `POST /` (also `POST /a2a`) with these methods:

- `message/send` — accepts `message.role=user` with text `parts`, optional `contextId`/`taskId`, and optional `metadata.recipient` (defaults to `A2A_RECIPIENT` / `claude`). Returns a Task.
- `tasks/get` — fetches a Task by `params.id`.
- `tasks/list` — paginated task listing with optional `contextId` and `status` filters.
- `tasks/cancel` — cancels a task only while it is submitted or waiting for input.
- `GET /.well-known/agent-card.json` — Agent Card declares the JSON-RPC 1.0 interface and bearer authentication.

Example JSON-RPC call:

```powershell
$headers = @{ Authorization = "Bearer $env:A2A_API_TOKEN"; 'Content-Type' = 'application/json' }
$body = @{ jsonrpc='2.0'; id=1; method='message/send'; params=@{ message=@{ role='user'; messageId='msg-1'; contextId='project-1'; parts=@(@{ kind='text'; text='Review the patch and report findings.' }) } } } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/' -Headers $headers -Body $body
```

### Bridge adapter contract

`src/adapters/http-agent.mjs` and `src/worker.mjs` provide a real HTTP transport adapter for the already-built Claude/Chrome bridge, **provided that bridge exposes the contract below**. This repository did not contain the bridge's actual endpoint/API, so the endpoint contract must be mapped to its real command API before claiming end-to-end compatibility.

Request (`POST A2A_ADAPTER_URL`):

```json
{"protocol":"a2a-bridge-v1","taskId":"...","contextId":"...","parentId":null,"sender":"client","recipient":"claude","text":"..."}
```

Successful response must attest that dispatch occurred and return a stable invocation id:

```json
{"accepted":true,"dispatched":true,"status":"completed","invocationId":"bridge-run-id","text":"agent response"}
```

For an input request, use `status: "input_required"` and `question`. A response can prove non-delivery only with both `accepted:false` and `dispatched:false`; HTTP status alone is not proof. Any timeout, connection reset, malformed reply, or un-attested response becomes `UNKNOWN`, never an automatic resend.

Run the worker in a separate PowerShell window with the same absolute database path as the server:

```powershell
$env:A2A_DB = 'C:\a2a\ledger.db'
$env:A2A_ADAPTER_URL = 'http://127.0.0.1:PORT/REPLACE_WITH_REAL_BRIDGE_ENDPOINT'
$env:A2A_RECIPIENT = 'claude'
$env:A2A_WORKER_ID = 'claude-worker-1'
$env:A2A_ADAPTER_TOKEN = 'optional-bridge-token'
npm run worker
```

The loopback HTTP URL above is a placeholder only; replace it with the endpoint actually implemented by your bridge. Remote adapters require HTTPS. Run server and worker on the same host because SQLite is a single-host ledger. Never run two independent ledger files and expect them to coordinate.

### Compatibility status and limits

This is a useful A2A JSON-RPC subset, not yet certified as fully conformant to the latest A2A 1.0 specification. Streaming (`message/stream`), task resubscription, task listing, push notifications, extended Agent Card, signed cards, and complete protocol-schema validation are not implemented. The protocol uses the official Agent Card and JSON-RPC concepts; see the [A2A specification](https://a2a-protocol.org/v1.0.0/specification/). The project-specific `/v1/tasks` REST routes remain for diagnostics and backward compatibility.

## Codex CLI adapter (v0.4.0)

`src/adapters/codex-cli.mjs` runs the installed Codex CLI through its supported non-interactive `codex exec` command. The prompt is written to stdin (not interpolated into a shell command), and the adapter reads the final answer from `--output-last-message`. JSONL events are inspected for a Codex thread/session id, which is recorded as the invocation id when available.

Safety defaults are deliberately conservative: `--sandbox read-only`, `--ask-for-approval never`, no `--yolo`, a bounded timeout, and an explicit absolute working directory. `workspace-write` can be enabled for a trusted repository using `A2A_CODEX_SANDBOX=workspace-write`; do not use it for untrusted prompts/workspaces. The worker inherits the local Codex authentication and configuration of the account that runs it. It does not transmit credentials through A2A.

### Run the full local HTTP -> SQLite -> Codex CLI -> result flow (PowerShell)

Install Node >= 22.13 and authenticate Codex CLI interactively first (`codex login`). Confirm `codex --version` and `codex exec --help` work in the same PowerShell account that will run the worker. This environment does not bundle Codex CLI or your authentication.

Terminal 1 — API:

```powershell
$env:A2A_DB = 'C:\a2a\ledger.sqlite'
$env:A2A_API_TOKEN = 'replace-with-a-random-secret-at-least-24-characters'
$env:A2A_HOST = '127.0.0.1'
$env:A2A_PORT = '8787'
npm start
```

Terminal 2 — Codex worker (start in the project directory containing this package):

```powershell
$env:A2A_DB = 'C:\a2a\ledger.sqlite' # must match Terminal 1 exactly
$env:A2A_ADAPTER = 'codex-cli'
$env:A2A_RECIPIENT = 'codex'
$env:A2A_CODEX_CWD = 'C:\path\to\trusted\workspace' # absolute path
$env:A2A_CODEX_SANDBOX = 'read-only' # safest default; use workspace-write only intentionally
$env:A2A_ADAPTER_TIMEOUT_MS = '600000'
npm run worker
```

Terminal 3 — submit and poll. The result is not complete until the worker has executed Codex and the state becomes `completed`:

```powershell
$headers = @{ Authorization = "Bearer $env:A2A_API_TOKEN"; 'Content-Type' = 'application/a2a+json' }
$body = @{ jsonrpc='2.0'; id=1; method='message/send'; params=@{ message=@{ role='user'; messageId=[guid]::NewGuid().ToString(); contextId='codex-smoke-test'; parts=@(@{ kind='text'; text='Reply with exactly: A2A_CODEX_E2E_OK' }) } } } | ConvertTo-Json -Depth 10
$created = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/' -Headers $headers -Body $body
$id = $created.result.id
while ($true) {
  Start-Sleep -Seconds 2
  $pollBody = @{ jsonrpc='2.0'; id=2; method='tasks/get'; params=@{ id=$id } } | ConvertTo-Json -Depth 5
  $task = (Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/' -Headers $headers -Body $pollBody).result
  $task.status.state
  if ($task.status.state -in @('completed','failed','canceled','unknown')) { break }
}
$task | ConvertTo-Json -Depth 10
```

The automated test `tests/codex-cli.test.mjs` covers the entire HTTP -> ledger -> process adapter -> result path with a deterministic fake Codex executable, plus prompt-injection-through-shell checks and unsafe-sandbox rejection. It is **not** a test of a real authenticated Codex model run. Run the PowerShell smoke test above on the target Windows host to verify the installed Codex version, login, process invocation, sandbox behavior, and real result.

Delivery semantics remain conservative: the ledger commits `dispatch_started` before spawning Codex. If the process starts and then times out, crashes, exits nonzero, or fails to produce a final answer, the task becomes `UNKNOWN` rather than being automatically re-run. This prevents duplicate execution when the outcome cannot be proven, but it means an operator must inspect ambiguous runs. The Codex CLI process id is not a server-side idempotency key, and this adapter cannot promise exactly-once model execution across host/process failure.
