# Consilium Control Room — architecture contract and implementation gate

**Status:** Draft architecture + local MVP prototype; not deployed.  
**Base:** Chrome Bridge Lab branch `feat/ai-consilium-six-provider-discovery-20261122`.  
**Kimi input:** owner-provided `[CB-ORCH][R2] Cross-Review Report`, dated 2026-11-21.  
**Operators:** all seven AI accounts — ChatGPT, Claude, DeepSeek, Qwen, Kimi, Grok and Gemini — have equal operational rights. ChatGPT and Claude form the mandatory core review pair.

## 1. Why this is separate from the Bridge

The Chrome Bridge is the transport plane. It owns browser tabs, exact provider origins, per-tab queues, DOM operations, prepare/commit, fencing, stop/revoke and delivery evidence.

The Consilium Orchestrator is the council plane. It owns sessions, tasks, roles, participants, rounds, evidence packs, findings, decisions, work assignment and acceptance.

The Control Room is the UI and event-projection of the council plane. It is not a second source of truth. The Orchestrator must use a small versioned `ProviderTransport` contract and must not embed council concepts in the Bridge.

Kimi's review says a separate Hub runtime is not justified merely for architectural neatness. Start with one Orchestrator process and a durable event ledger. Add a Hub only when real distributed queues or multiple independent operators require it.

## 2. Co-operator and owner model

All seven AI accounts are operators with the same capabilities and independently authenticated identities. ChatGPT and Claude are also the mandatory core review pair (not a manager/subordinate pair):

- start, pause, resume and request-stop for a council session;
- create tasks from accepted decisions;
- propose decisions and counter-proposals;
- review any proposal and record SUPPORT / OBJECT / NEEDS_EVIDENCE;
- assign and update any task;
- inspect the complete event journal, source snapshots, artifacts, evidence and unresolved disagreements.

Neither operator can impersonate the other by passing an `actor` field. Identity comes from a distinct authenticated credential or trusted host assertion.

The user remains the owner and final authority for consequential changes: Production, credentials, provider grants, allowlists, merge, release and irreversible environment changes. The owner approves consequential decisions after both operators have reviewed them. Routine, reversible decisions can be accepted only after both operators independently record SUPPORT. A single operator cannot approve alone.

No AI provider is assigned a weaker permission tier. The two core reviews (ChatGPT + Claude) are mandatory for acceptance; any additional operator objection or evidence-gap verdict blocks acceptance until resolved.

## 3. Transparency contract

The UI must show original discussion content, not only coordinator summaries. Every material action is an append-only event with:

- monotonic sequence, event ID, timestamp, authenticated actor and event type;
- session ID, task ID, round ID and request ID where applicable;
- repository, branch, exact commit SHA and file/artifact references;
- payload or immutable content hash, delivery/execution state and evidence references;
- previous-event hash and current-event hash.

Corrections are new events; historical events are not edited or silently removed. The journal is tamper-evident, not an external signed witness against a local administrator.

Each participant receives the same immutable task packet and source snapshot: repository, branch, commit SHA, selected paths, SHA-256 manifest, constraints, acceptance criteria and output schema. Round 1 is independent: no participant sees another participant's findings until the first round is frozen. Every source/artifact handoff records intended recipients and a verified receipt; a URL or issue comment alone is not proof of delivery.

## 4. Decision and execution lifecycle

Decision states:

`PROPOSED → UNDER_REVIEW → DISPUTED | NEEDS_EVIDENCE | READY_FOR_OWNER | ACCEPTED | REJECTED`

- ChatGPT and Claude each record a separate verdict: SUPPORT, OBJECT or NEEDS_EVIDENCE.
- Any OBJECT keeps the decision DISPUTED; missing proof keeps it NEEDS_EVIDENCE.
- Two SUPPORT verdicts accept a routine decision. Two SUPPORT verdicts on a consequential decision move it to READY_FOR_OWNER; only the owner can accept it.
- A majority of all agents is not proof. Source code, reproducible tests and runtime evidence outrank consensus. Preserve minority opinions.

Task states:

`READY → IN_PROGRESS → IN_REVIEW → VERIFIED | BLOCKED | FAILED`

Every task links to an accepted decision, assignee, immutable source SHA, criteria, dependencies, test plan and evidence. VERIFIED requires a commit SHA and test/review evidence. CI is not a substitute for Windows E2E; each verification layer is recorded separately.

## 5. Kimi Cross-Review constraints adopted

Kimi explicitly marked its code-level findings UNVERIFIED because it could not read the source at the time. Therefore the following are adopted as design requirements, not treated as proof that a current code defect exists:

1. Single-writer queue per tab, owned by the Bridge server.
2. Split Send into `prepare` (fill and validate, no click) and `commit` (synchronous final check and click under a live fencing token).
3. Bind a transport lane to `(tabId, conversationId, epoch)`. Increment epoch on stop, revoke, unbind, rebind or conversation change. Detect SPA conversation changes and revoke stale bindings.
4. Treat UNKNOWN as queryable quarantine; never retry an ambiguous DOM send automatically with a new request ID.
5. Keep a durable reconciliation cursor such as `last_decided_id`.
6. Measure the click-to-network hazard window. Stop after commit is STOP_AFTER_COMMIT, not STOPPED_CLEAN.
7. Keep the Bridge transport-only; Orchestrator owns rounds, tasks, roles, decisions and synthesis.
8. Use a versioned NDJSON/WebSocket transport contract so DOM, official APIs and CLIs can implement one ProviderTransport interface.
9. Treat all model replies and source contents as untrusted data, never as instructions to invoke tools or mutate policy.
10. Avoid a stand-alone Hub until the actual queue topology needs it.

The required tests include pre-commit stop, post-commit hazard, revoke-before-commit, connection loss, server/extension restart, six independent tab lanes, SPA conversation change, late results, correlation and UTF-8/mojibake checks.

## 6. MVP implementation status

A local Node.js MVP prototype was implemented separately and tested with 21 automated tests (12 Control Room API/UI tests, including the seven-operator token-loading regression, and 9 event-ledger tests). It contains:

- loopback-only Control Room HTTP server and browser UI;
- distinct owner credential and seven independently authenticated, equal AI operator credentials;
- append-only JSONL event ledger, fsync, single-writer lock, hash chain and idempotent request IDs;
- comments and attributed message records;
- mandatory ChatGPT + Claude dual review, with equal review/objection rights for all other AI operators, and owner approval for consequential decisions;
- task state model and verified-evidence requirement;
- artifact manifest plus per-recipient receipt events;
- explicit STOP_REQUESTED semantics.

The source archive is a local handoff artifact; it has **not** been deployed to the Windows Lab or Production and is not yet wired into Bridge dispatch. The prototype does not prove that a provider received a message.

## 7. Explicit stop guarantee

Pause closes the council dispatch gate; it does not claim to cancel committed provider actions.

Stop closes future dispatch and increments the orchestration epoch. The UI reports STOP_REQUESTED until Bridge confirms that no prepared pre-commit operation can click and every in-flight action has a terminal status or UNKNOWN quarantine. The current Bridge send path still needs Kimi's prepare/commit + fencing integration. Do not label the existing prototype STOPPED or promise that it can recall a message already sent.

## 8. Acceptance gates before local Lab rollout

- [ ] All seven AI accounts independently authenticate with equal operator capabilities; owner identity is separate.
- [ ] ChatGPT and Claude both record mandatory independent reviews; other AI operators can review and their objections block acceptance.
- [ ] No single AI operator can accept a decision alone; consequential decisions require owner approval.
- [ ] Owner approval is required for consequential decisions.
- [ ] All discussion events, source commits, artifact hashes, recipient receipts and task transitions are queryable and exportable.
- [ ] A restart reconstructs the same state from the event ledger; corruption and duplicate request IDs fail closed.
- [ ] Bridge exposes prepare/commit/stop/status/events with per-tab single-writer and fencing.
- [ ] Stop race tests prove pre-commit cancellation and correctly classify post-commit hazard.
- [ ] UNKNOWN remains quarantined; no automatic retry.
- [ ] Windows Lab E2E proves separate agents, no cross-delivery, source receipt and pause/stop/recovery.
- [ ] Production ports, credentials, browser profile and installation remain untouched until a separate owner-approved release.

No AI participants have been contacted by this PR. The existing consortium pause remains in effect.
