# Free AI Workbench — offline proof of concept

This folder starts a provider-neutral, free multi-agent coordination layer.
It is **not** a chat UI, coding agent, network service, or execution engine.
It never executes shell commands, talks to LLM APIs, launches browsers,
mutates Git repositories, or accesses PowerShell Direct. It provides a local
append-only review/audit trail only.

Requirements: Node.js 20+ (already present in Work PC).

## Tests (no agents/services affected)

```powershell
$root='C:/Engineering/ChromeBridge-PowerShell-Direct-Validation'
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

Save each event as a separate local JSON file outside Git, then run:

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
