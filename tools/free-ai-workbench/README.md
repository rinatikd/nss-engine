# Free AI Workbench — offline proof of concept

This folder starts a provider-neutral, free multi-agent coordination layer.
It is **not** a chat UI, coding agent, network service, or execution engine.
It never executes shell commands, talks to LLM APIs, launches browsers,
mutates Git repositories, or accesses PowerShell Direct. It provides a local
append-only review/audit trail only.

Requirements: Node.js 20+ (already present in Work PC).

## Tests (no agents/services affected)

```powershell
$root='C:/Engineering/Free-AI-Workbench'
node --check "$root/tools/free-ai-workbench/ledger.mjs"
node --test "$root/tools/free-ai-workbench/tests/ledger.test.mjs"
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
