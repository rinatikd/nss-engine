# Free AI Workbench — offline proof of concept

This folder is an offline proof of concept for a provider-neutral multi-agent workspace.
It contains an append-only local task ledger and a static **read-only JSONL viewer**.
It is not a multi-agent chat UI, coding agent, orchestration service, or execution engine.
It never talks to LLM APIs, dispatches provider messages, launches browsers, mutates Git,
or accesses PowerShell Direct.

Requirements: Node.js 20+ (already present in Work PC).

## Tests (no agents/services affected)

```powershell
$root='C:/Engineering/Free-AI-Workbench'
node --check "$root/tools/free-ai-workbench/ledger.mjs"
node --test "$root/tools/free-ai-workbench/tests/ledger.test.mjs" "$root/tools/free-ai-workbench/tests/viewer.test.mjs"
```

## Task workflow

The event JSON file provided to the CLI contains a single event. State flows:

```text
QUEUED --assign--> ASSIGNED --submit--> IN_REVIEW --accept--> ACCEPTED
                                           \--reject--> REJECTED
```

Examples of events:
```json
{"id":"nss_001","action":"create","actor":"coordinator","role":"planner","title":"Smoke test NSS","project":"NSS Engine"}
{"id":"nss_001","action":"assign","actor":"coordinator","role":"planner","owner":"gemini"}
{"id":"nss_001","action":"submit","actor":"gemini","role":"developer","evidence":"local report SHA256:..."}
{"id":"nss_001","action":"accept","actor":"reviewer_a","role":"reviewer","comment":"Evidence checked"}
```

Save each event as a separate local JSON file outside Git, include a stable unique requestId, then run:

```powershell
node ledger.mjs event .\tasks.jsonl .\event1.json
node ledger.mjs show .\tasks.jsonl
```

The directory must already exist. No key/token should appear in events.

**Security limitations of this prototype:** actor/role values are self-declared
and NOT authenticated. It must remain offline and single-operator only.
The event log is not tamper-proof, does not provide cross-process transaction
recovery, does not sign approvals, and is not appropriate for authorizing
execution. Authentication, RBAC, stable storage, independent approvals and
idempotent adapters are required before network use. It is designed to
prove a lifecycle and testability, nothing more.

See [ARCHITECTURE.md](../../docs/free-ai-workbench/ARCHITECTURE.md).


## Durability and recovery boundaries

New records use a SHA-256 hash chain, a stable requestId, a payload fingerprint and an fsync on the append file before the CLI acknowledges the event. Repeating the same requestId with the same payload is idempotent; reusing it for a different payload is rejected.

A torn final JSONL line or a hash mismatch fails closed. The prototype does not truncate, repair or skip corrupted records automatically. A pre-existing .lock also blocks writes; the tool does not guess whether another process is still alive and never steals a stale lock automatically. Preserve the file and investigate lock owner / last durable record manually before recovery.

These controls provide local corruption detection and safer retries, not authenticated actors, an external signature, or proof against an administrator who can rewrite the whole file. Do not use this ledger to authorize Windows, Git, browser or provider operations.


## Offline read-only viewer

The viewer is a static file-import board. It verifies v2 payload hashes and the SHA-256 event chain before projecting task cards. Legacy-only logs are labelled LEGACY_UNCHAINED rather than presented as verified. Torn files, tampering, invalid transitions and duplicate request IDs fail closed.

Because browsers restrict ES modules loaded from file:// URLs, serve only the static UI folder on loopback (no API and no write endpoints):

```powershell
python -m http.server 8787 --bind 127.0.0.1 --directory "$root/tools/free-ai-workbench/ui"
```

Open http://127.0.0.1:8787/ and select a JSONL ledger using the file picker. The browser reads the selected file locally; the static server only serves the viewer assets. Stop the server with Ctrl+C. No ledger file is uploaded or modified by the viewer.

The viewer is a projection only. It does not authenticate actor/role fields and cannot authorize tasks or execution. Keep the ledger offline and single-operator until the EDRP API and authenticated identity contract exist.
