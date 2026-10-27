# A2A JavaScript v0.4.0 — reviewed working copy

Node >=22.13; no external packages. This is a separate JavaScript implementation from Python dispatcher v0.23, not a version upgrade or a merged system.

The original user-uploaded handoff ZIP SHA256 is `e0dcd4b1889d1763f48dae80037b91dcd9413673243523de8a4aab380ea3240f`. CRC and all 27 bundle hashes matched. The original is unchanged; this folder includes audited text source only, without historical ZIPs or the separate Chrome Bridge archive.

## Run locally

This repository excludes JSON files under its source publication rules. Restore the included npm manifest template locally once:

```sh
node -e "require('node:fs').copyFileSync('package.json.in', 'package.json')"
npm test
npm run demo
```

Or run without a manifest: `node --test tests/*.test.mjs`, `node src/server.mjs`, `node src/worker.mjs`.

## Verification and limitations

Original package: 31 tests passed. Reviewed source: 40 tests passed, zero failures or skips on Linux Node24.19.0. The actual installed Codex CLI0.163.0 accepted the corrected argument placement in parse-only `--help` verification. No model was invoked. CLI E2E tests use fake executables; they establish transport behavior only. Windows native execution and descendant isolation remain unverified.

Fixed verified issues: top-level Codex approval flag order; Windows shell argument interpretation (native executable required); arbitrary extra permission switches; timeout held open by inherited Unix pipes; fabricated external invocation ID; server entry path with spaces; changed sender/parent mistakenly treated as duplicate; HTTP redirects forwarding task data beyond configured endpoint.

The HTTP adapter expects a custom bridge contract. It is not a native Anthropic API or Claude Code CLI adapter. A2A conformance, real Claude/Codex inference and ChatGPT custom app connection remain unverified. A recorded external session ID identifies a response; it is not independent cryptographic attestation. Shared bearer authentication does not supply per-agent identity.

The SQLite lease and dispatch marker prevent automatic resend after uncertain delivery; exactly-once external execution is not guaranteed. Paid model calls are not authorized by this document. Existing Windows CODEX_DISABLED and production Bridge are unchanged.

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

The adapter builds `codex --ask-for-approval never exec ...`: approval is a global option and must precede `exec`. Defaults are `--sandbox read-only`, no `--yolo`, a bounded timeout, and an explicit absolute working directory. Generic config, feature, profile and permission switches are rejected in `extraArgs`; only `--skip-git-repo-check` is allowed. `workspace-write` can be enabled for a trusted repository using `A2A_CODEX_SANDBOX=workspace-write`; do not use it for untrusted prompts/workspaces. The worker inherits the local Codex authentication and configuration of the account that runs it. It does not transmit credentials through A2A. These flags do not prove that configured MCP tools or subprocesses are isolated; review the effective configuration and runner before accepting untrusted tasks.

### Run the full local HTTP -> SQLite -> Codex CLI -> result flow (PowerShell)

Install Node >= 22.13 and authenticate Codex CLI interactively first (`codex login`). Confirm `codex --version` and `codex exec --help` work in the same PowerShell account that will run the worker. This environment does not bundle Codex CLI or your authentication. On Windows set `A2A_CODEX_EXECUTABLE` to the absolute path of the installed native `codex.exe`. A bare `codex` command, `.cmd` and `.bat` launchers are rejected: the adapter always uses `shell: false`. Windows execution and process-tree containment have not been verified by the Linux tests.

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
$env:A2A_CODEX_EXECUTABLE = 'C:\path\to\installed\codex.exe' # native executable, not codex.cmd
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

The automated test `tests/codex-cli.test.mjs` covers the entire HTTP -> ledger -> process adapter -> result path with a deterministic fake Codex executable, plus prompt transport, unsafe-argument rejection, missing executable/session handling and Unix descendant timeout checks. If a real Codex installation is present, a parse-only `--help` check validates the generated flags without invoking a model. The Windows executable validation test checks policy only; it does not run Windows. It is **not** a test of a real authenticated Codex model run. Run the PowerShell smoke test above on the target Windows host to verify the installed Codex version, login, process invocation, sandbox behavior, and real result.

Delivery semantics remain conservative: the ledger commits `dispatch_started` before spawning Codex. If the process starts and then times out, crashes, exits nonzero, or fails to produce a final answer, the task becomes `UNKNOWN` rather than being automatically re-run. This prevents duplicate execution when the outcome cannot be proven, but it means an operator must inspect ambiguous runs. An absent external thread/session id stays null and is not replaced by an apparently attested random id. On Unix, timeout signals the spawned process group and allows a three-second termination grace. On Windows, timeout stops the direct child and bounds the adapter wait, but descendant termination is unverified and requires an isolated runner. A thread/session id is not a server-side idempotency key, and this adapter cannot promise exactly-once model execution across host/process failure.

## Explicit free local Codex provider

`CodexCliAdapter` accepts `provider: 'ollama-local'`, a pinned local model `qwen2.5:3b` or `qwen2.5:7b`, and an optional loopback `localPort` (default11434). This mode requires read-only sandbox and approvalnever. It selects `--oss --local-provider ollama`, uses a temporary empty Codex configuration directory, omits inherited model credentials, ignores user config/rules and disables shell, web, images, apps, plugins, goals and other exposed tools. The effective tools list is additionally checked by the real integration verifier. This is a text-only integration, not proof of filesystem/network isolation for tool-enabled jobs.

For the existing worker set `A2A_ADAPTER=codex-cli`, `A2A_CODEX_PROVIDER=ollama-local`, `A2A_CODEX_MODEL=qwen2.5:3b`, the absolute native `A2A_CODEX_EXECUTABLE`, and trusted absolute `A2A_CODEX_CWD`. Run Ollama locally with that model already installed. No ChatGPT/API login is copied or required by this mode. Provider `configured` preserves the previous explicit operator-configured behavior and is not covered by the free-local readiness claim.

`verify-real-codex.mjs` is a separate live test, not included in offline tests. It requires `A2A_CODEX_EXECUTABLE`, optionally `A2A_CODEX_MODEL` and `A2A_EVIDENCE_FILE`, actual Ollama on127.0.0.1:11434, and an installed model digest. A loopback recording proxy rejects credentials, tools, unexpected methods/routes/models; no fake model response is supplied. It checks HTTP/JSON-RPC, actual CLI, measured Ollama output tokens, session identifier and persisted final result. A real CI result must be inspected separately before claiming PASS. Windows and ChatGPT custom MCP app are not tested by this Linux verifier.
