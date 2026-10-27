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
