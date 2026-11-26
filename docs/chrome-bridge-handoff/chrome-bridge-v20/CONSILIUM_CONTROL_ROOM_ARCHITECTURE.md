# Consilium Control Room — architecture contract and implementation gate

**Status:** Draft architecture + local MVP prototype; not deployed.  
**Base:** Chrome Bridge Lab branch `feat/ai-consilium-six-provider-discovery-20261122`.  
**Kimi input:** owner-provided `[CB-ORCH][R2] Cross-Review Report`, dated 2026-11-21.  
**Equal membership:** all seven AI identities have the same council permissions and trust. ChatGPT and Claude are the mandatory co-operator pair for coordination and independent dual review; this is not a higher authority tier. The human owner retains final approval for consequential actions.

## 1. Why this is separate from the Bridge

The Chrome Bridge is the transport plane. It owns browser tabs, exact provider origins, per-tab queues, DOM operations, prepare/commit, fencing, stop/revoke and delivery evidence.

The Consilium Orchestrator is the council plane. It owns sessions, tasks, roles, participants, rounds, evidence packs, findings, decisions, work assignment and acceptance.

The Control Room is the UI and event-projection of the council plane. It is not a second source of truth. The Orchestrator must use a small versioned `ProviderTransport` contract and must not embed council concepts in the Bridge.

Kimi's review says a separate Hub runtime is not justified merely for architectural neatness. Start with one Orchestrator process and a durable event ledger. Add a Hub only when real distributed queues or multiple independent operators require it.

## 2. Co-operator and owner model

All seven AI accounts have independently authenticated identities and equal council authority. Every member may start, pause, resume and request-stop a council session; propose and launch rounds; comment, submit findings, propose decisions, record SUPPORT / OBJECT / NEEDS_EVIDENCE, contribute evidence, create and update tasks, and inspect the complete journal. ChatGPT and Claude remain the mandatory co-operator pair for coordination and independent dual review, not a higher permission tier.

- launch rounds proposed by any participant;
- start, pause, resume and request-stop for a council session;
- create tasks from accepted decisions;
- propose decisions and counter-proposals;
- review any proposal and record SUPPORT / OBJECT / NEEDS_EVIDENCE;
- assign and update any task;
- inspect the complete event journal, source snapshots, artifacts, evidence and unresolved disagreements.

Any of the seven AI members may propose and launch a new round with its objective and requested participants. The Control Room records both proposer and launcher.

Neither operator can impersonate the other by passing an `actor` field. Identity comes from a distinct authenticated credential or trusted host assertion.

The user remains the owner and final authority for consequential changes: Production, credentials, provider grants, allowlists, merge, release and irreversible environment changes. The owner approves consequential decisions after both operators have reviewed them. Routine, reversible decisions can be accepted only after both operators independently record SUPPORT. A single operator cannot approve alone.

All seven AI members have equal standing, equal trust and equal Control Room permissions. Analytical roles are emphases only, not permission tiers. The ChatGPT + Claude dual review is mandatory for decision progression; any other member's objection or evidence gap remains blocking. Any participant OBJECT or NEEDS_EVIDENCE verdict blocks progression until the issue is answered and the participant's review is explicitly revised; the event history remains visible.

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
8. Use one versioned ProviderTransport contract so DOM, official APIs and CLIs can implement the same prepare/commit/status/stop/revoke/events semantics; the concrete wire protocol is adapter-specific.
9. Treat all model replies and source contents as untrusted data, never as instructions to invoke tools or mutate policy.
10. Avoid a stand-alone Hub until the actual queue topology needs it.

The required tests include pre-commit stop, post-commit hazard, revoke-before-commit, connection loss, server/extension restart, six independent tab lanes, SPA conversation change, late results, correlation and UTF-8/mojibake checks.

## 6. MVP implementation status

A local Node.js MVP prototype is implemented in this branch and tested with 31 automated tests (12 Control Room API/UI tests, 11 event-ledger tests and 8 ProviderTransport v1 contract tests). Coverage includes the seven independently authenticated AI member identities with equal council permissions, member-proposed and member-launched rounds, participant objection/evidence-gap blocking after the core pair reaches READY_FOR_OWNER, and transport correlation, binding, fencing, UNKNOWN quarantine and epoch revocation. It contains:

- loopback-only Control Room HTTP server and browser UI;
- seven independently authenticated AI-member (`ai_member`) credentials with equal council permissions (ChatGPT, Claude, DeepSeek, Qwen, Kimi, Grok and Gemini); a distinct owner credential is separate;
- round proposal and launch permissions shared by all seven AI members;
- versioned ProviderTransport v1 contract defining prepare / commit / status / stop / revoke / events, provider-origin-tab-conversation-epoch binding, no-send preparation, fencing tokens, click evidence, UNKNOWN quarantine and independently verified STOPPED_CLEAN attestation (contract only; no live Bridge adapter is attached);
- append-only JSONL event ledger, fsync, single-writer lock, hash chain and idempotent request IDs;
- comments and attributed message records;
- mandatory ChatGPT + Claude dual review, with equal review/objection rights for all seven AI members, and owner approval for consequential decisions;
- task state model and verified-evidence requirement;
- artifact manifest plus per-recipient receipt events;
- explicit STOP_REQUESTED semantics.

The MVP source code is included in this PR branch; it has **not** been deployed to the Windows Lab or Production and is not yet wired into live Bridge dispatch. The prototype does not prove that a provider received a message.

## 7. Chrome Bridge ProviderTransport v1 adapter

The Bridge side now has a concrete, loopback-only adapter path rather than a contract-only placeholder:

- `consilium/chrome-bridge-provider-adapter.mjs` is the Control Room/Orchestrator-side MCP client. It accepts only `http://127.0.0.1:<port>/mcp`, uses the configured Bridge bearer token, exposes prepare / commit / status / stop / revoke / events, and never retries a mutation. A lost or ambiguous acknowledgement becomes `UNKNOWN` with a quarantine ID.
- `server/provider-journal.mjs` persists an HMAC-chained JSONL transaction journal with an exclusive writer lock, request-ID idempotency, payload-hash binding, expiring fencing tokens, per-tab epochs and fail-closed restart recovery. In-flight or prepared work recovered after restart becomes `UNKNOWN`; unresolved work quarantines the tab against new sends.
- `server/bridge.mjs` exposes the six provider transaction MCP tools and routes prepare / commit through the existing single-writer queue. A dispatched command timeout keeps its active slot reserved until a late ACK arrives; it does not release the lane and risk overlapping a still-running DOM action.
- `extension/mutation-dispatch.js` requires the explicit per-origin Control grant and local approval for both stages, then revalidates the exact tab and conversation after approval.
- `extension/page.js` prepares the exact composer payload without clicking Send. The page-side receipt binds request ID, prepared ID, payload hash, origin, conversation and epoch. Commit rechecks that binding and the live composer hash, consumes the receipt before the single Send click, and returns correlated click evidence. A per-tab page mutation lock prevents overlapping injections in the same page context.
- A clean stop is attested only when the tab has zero unresolved transactions and zero outstanding prepared work. A stop request during an uncertain/in-flight action advances the epoch but remains `STOP_REQUESTED`; it is never reported as clean.

The adapter and server integration are covered by synthetic MCP/HTTP tests. This is not yet proof of a real provider send: the provider-specific page actions still require a disposable Windows/Chrome Lab E2E with real extension permissions, visible local approval, prepare-no-send inspection, commit click evidence, timeout/late-ACK and restart/quarantine cases. No provider has been contacted by this implementation.

## 8. Explicit stop guarantee

Pause closes the council dispatch gate; it does not claim to cancel committed provider actions.

Stop closes future dispatch and increments the orchestration epoch. The UI reports STOP_REQUESTED until Bridge confirms that no prepared pre-commit operation can click and every in-flight action has a terminal status or UNKNOWN quarantine. The current Bridge send path still needs Kimi's prepare/commit + fencing integration. Do not label the existing prototype STOPPED or promise that it can recall a message already sent.

## 9. Acceptance gates before local Lab rollout

- [ ] All seven AI identities independently authenticate as the same `ai_member` class with equal council permissions; ChatGPT + Claude form the mandatory independent dual-review pair (a review rule, not a permission tier); owner identity is separate.
- [ ] Any of the seven AI members can propose and launch a round, with both actions recorded.
- [ ] ChatGPT and Claude both record mandatory independent reviews; all seven AI members can submit independent reviews and objections that block progression until explicitly resolved.
- [ ] No single AI operator can accept a decision alone; consequential decisions require owner approval.
- [ ] Owner approval is required for consequential decisions.
- [ ] All discussion events, source commits, artifact hashes, recipient receipts and task transitions are queryable and exportable.
- [ ] A restart reconstructs the same state from the event ledger; corruption and duplicate request IDs fail closed.
- [ ] Bridge exposes prepare/commit/stop/status/events with per-tab single-writer and fencing.
- [ ] A concrete Bridge adapter implements ProviderTransport v1 and passes contract tests against real Bridge fencing and delivery evidence.
- [ ] Stop race tests prove pre-commit cancellation and correctly classify post-commit hazard.
- [ ] UNKNOWN remains quarantined; no automatic retry.
- [ ] Windows Lab E2E proves separate agents, no cross-delivery, source receipt and pause/stop/recovery.
- [ ] Production ports, credentials, browser profile and installation remain untouched until a separate owner-approved release.

No AI participants have been contacted by this PR. The existing consortium pause remains in effect.
