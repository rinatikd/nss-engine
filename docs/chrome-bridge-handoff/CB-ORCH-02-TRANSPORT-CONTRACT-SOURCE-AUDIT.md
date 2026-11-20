# CB-ORCH-02 — Chrome Bridge Transport Contract & Source Audit

**Status:** Architecture baseline / source-audit report  
**Date:** 2026-11-21 (Asia/Almaty)  
**Audited repository:** `rinatikd/nss-engine`  
**Audited PR:** #113 — Draft, unmerged  
**Exact source revision:** `fcbd6eeaf646131ba696995bd970482b5704ed56`  
**Audit branch:** `docs/cb-orch-02-transport-contract-20261121`  
**Scope:** Chrome Bridge browser transport and the boundary to a separate Orchestrator. This document does not authorize deployment, production changes, provider sends, or enabling browser Control.

---

## 1. Executive decision

**PR #113 remains NO-GO for mutation-capable release.** The exact source and the PR's current operational snapshot establish a critical Stop/drain gap:

- `background-coordinator.js` starts dispatch work with `void run()`; it does not register or await in-flight dispatch promises.
- Global Stop disables future dispatch flags, clears grants, and asks the offscreen Worker to stop. It does not prove that a page action already injected by `chrome.scripting.executeScript` has completed or become inert.
- The all-tabs mutation path reaches `dispatchOneClickMutation()`, which injects `pageAction`. The page routine may wait while filling the composer and waiting for a Send button. Its final `control()` check validates the captured expiry and origin, but it does not consult a revocation epoch or current grant state. A Stop/revoke that occurs while the page routine is waiting can therefore precede a later `btn.click()`.
- Per-tab revoke removes the grant and responds without draining already injected page work.

This is a **source-level race / missing invariant**, not a claim that a live Chrome reproduction has already been performed. The PR body records the same risk and explicitly requires a test-only reproducer before a production patch.

**Immediate release rule:** do not merge, deploy, enable global Control, or claim Stop-clean until the test-only reproducer, independent review, a proven Stop/commit boundary, executable CI on an exact SHA, isolated real-Chrome E2E, and rollback evidence all pass.

The architecture direction is accepted:

1. Chrome Bridge is a thin browser transport and permission boundary.
2. Orchestrator is a separate control plane for tasks, participants, roles, rounds, ACKs, reviews, evidence, and decisions.
3. GitHub Issues/PRs are durable work/evidence records, not realtime delivery and not proof that a named AI received a prompt.
4. No exactly-once claim for DOM-based provider interaction. A timed-out or ambiguous attempt is quarantined as `UNKNOWN`; no automatic resend.

---

## 2. Evidence discipline

### 2.1 What this audit establishes

The following files were fetched from the exact PR #113 HEAD above. Blob SHAs are included to make the inspection reproducible.

| File | Blob SHA | Source-level observation |
|---|---|---|
| `extension/background-coordinator.js` | `68ae4a70ab2db1b0db6ce292c7c0e1ef694a0c60` | Dispatch promise is not in an in-flight registry; Stop does not drain it; per-tab revoke returns after grant removal |
| `extension/transport-worker.js` | `ddb0b90c0ecd189a694fdd345411f3f29562e3b7` | Stop calls `transport.stop()` and rejects pending delegate promises; this is not proof that a delegated coordinator/page action has stopped |
| `extension/transport-host.js` | `54916e4b33b9f4219849f375ac8ee6b7cefdba20` | Worker control ACK is correlated and timeout fails closed; ACK is for Worker control processing, not page-action drain |
| `extension/one-click-mutation.js` | `5da3427a1cf21f7426bef857eac4d294eda95f38` | Rechecks Control, expiry, tab and target before injection; then awaits page execution |
| `extension/one-click-control-gate.js` | `d65cbfffc0d0623ee7e88e140a3448d2e40b1679` | Checks session flags and both wildcard host permissions; does not issue or validate a per-operation fencing token |
| `extension/one-click-session.js` | `c02db3e4da0a74bfd5f4d3d9705cc005b7e4e962` | Disconnect disables flags, asks Stop, revokes host permissions and verifies revocation; still relies on Stop's incomplete drain semantics |
| `extension/page.js` | `f5b76f30fdbd2421545b665570c2391078e03673` | Provider conversation IDs are URL-derived; final page-side check uses origin/conversation ID and captured expiry; `btn.click()` follows synchronously |
| `server/bridge.mjs` | `dd68accf9f81a925d9990de4a15309966e13ad68` | One global `activeId`; agent binding persists name→tabId; reply is explicitly `UNKNOWN / UNVERIFIED` |
| `server/send-journal.mjs` | `198a17e9e0120558ae8083a02744950a98476288` | Write-ahead request journal, HMAC fingerprints, fail-closed stale lock, bounded 10,000 entries / 8 MiB |
| `server/send-outcome.mjs` | `2937cc11ac1503b8ae1e47a73d2879d9d152bc2a` | Fail-closed evidence classifier; counts alone do not attribute a message; no automatic retry |
| `server/tools.mjs` | `0dff1ff29489c0656dbf71459e9252ed1fb4f660` | MCP tool contract combines browser tools and higher-level agent tools in one server process |
| `server/schema.mjs` | `1d376efb3bdc73056610b46501f28e9bea275fd0` | Minimal argument validation; no transport protocol version or fencing-token schema |
| `tests/background-coordinator.test.mjs` | exact HEAD | Covers Stop flags, offscreen ACK and stale status races; no in-flight page-action drain invariant |
| `tests/transport-control-ack.test.mjs` | exact HEAD | Covers correlated Worker start/stop ACKs; ACK scope is Worker processing |
| `tests/one-click-control-gate.test.mjs` | exact HEAD | Covers host permission revalidation and external permission revocation |
| `tests/one-click-session.test.mjs` | exact HEAD | Covers Connect/Disconnect lifecycle and permission revocation |
| `tests/one-click-target-integrity.test.mjs` | exact HEAD | Covers changed target destination/label before click |
| `ORCHESTRATOR.md` | `7f779c3060c2686f7e5f5ecd1692df8abcfbae3d` | Describes a `node hub/hub.mjs` runtime and task workspace that were not found in the PR #113 tree snapshot |

### 2.2 Evidence not established

This audit did **not** execute the test suite, build/install the extension, run Chrome, send provider messages, inspect live provider network traffic, or perform Windows E2E. Source inspection cannot establish timing or reproduce the race on a live browser.

The following are not evidence of successful execution:
- GitHub Actions jobs with empty `steps[]`;
- a workflow marked failed where logs are unavailable and no test step ran;
- unit tests alone as a substitute for Windows/Chrome E2E;
- a GitHub Issue comment, `agent=` label, ACK, or open browser tab as proof of provider receipt or independent model authorship.

PR #113's current body says its four completed failing workflows expose five jobs with zero steps and their logs are unavailable. Treat these as **NOT EXECUTED / UNKNOWN**, not as assertion failures or passes.

---

## 3. Source audit — findings and dispositions

Severity: **P0** release blocker; **P1** high; **P2** medium. “Confirmed” means visible in exact source; “reproduction pending” means no live runtime reproduction.

| ID | Severity | Finding | Evidence / impact | Disposition |
|---|---|---|---|---|
| CB02-F01 | P0 | Stop does not drain in-flight coordinator/page actions | Coordinator dispatch is fire-and-forget; Worker Stop rejects pending delegate promises but does not cancel already injected JS. Page code can reach final click after a Stop that only revoked flags/grants. | **FIX before mutation release.** Operation registry, cancellation/fencing, commit linearization and drain/quarantine protocol. |
| CB02-F02 | P0 | Per-tab revoke does not drain the in-flight operation | Revoke path removes grant and returns; an injected page routine may still be executing. | **FIX.** Revoke must fence the tab and wait for safe terminal state or return explicit `REVOKE_WITH_UNKNOWN`. |
| CB02-F03 | P1 | Transport Worker ACK is not an end-to-end Stop ACK | Offscreen host correlates Worker ACK correctly, but Worker ACK only proves its own control handler processed Stop. | **REFINE contract.** Separate `WORKER_STOP_ACK`, `PAGE_ACTION_DRAINED`, and `STOPPED_CLEAN`. |
| CB02-F04 | P1 | Global single `activeId` serializes all commands | Server queue wakes only while one global active command is null. A slow `agent_wait` loop enqueues `agent_peek`; this can block other tabs/agents. | **REFACTOR.** Per-tab single-writer mutation lane; bounded parallelism across tabs; non-blocking/isolated read lane. |
| CB02-F05 | P1 | Agent binding does not pin a conversation | `agents.json` persists only agent name→tabId. `agent_bind` does not persist provider conversation identity. Send obtains context later. | **FIX.** Bind record includes provider, origin, native conversation ID, tabId, generation, last verified URL and binding epoch. |
| CB02-F06 | P1 | SPA/DOM conversation identity can change without URL change | Provider conversation ID is extracted from URL. URL-derived ID is useful but does not detect every in-page conversation switch if provider state changes without route change. | **ADD.** Observe provider-specific conversation identity/DOM state; revoke binding on mismatch or ambiguity. |
| CB02-F07 | P1 | Reply observation is not request attribution | `agentWait` uses reply count/text stability and explicitly returns `replyAttribution: UNVERIFIED`, `deliveryStatus: UNKNOWN`. | **KEEP fail-closed.** Rename to `REPLY_OBSERVED_UNATTRIBUTED`; never promote to VERIFIED from count, stable text or marker echo alone. |
| CB02-F08 | P1 | Timeout after dispatch can leave an unknown result | Server timeout can clear global active slot; if execution already began, result is UNKNOWN. This is correctly not auto-retried, but late completion/reconciliation semantics are incomplete. | **FIX protocol.** Keep attempt terminal UNKNOWN; accept late evidence only as reconciliation for same attempt, never a second send. |
| CB02-F09 | P1 | Journal lacks an explicit recovery cursor/state reconciliation record | Journal stores per-request status and fingerprints but no `last_decided_id` or explicit restart reconciliation cursor. | **ADD.** Persist monotonic sequence/cursor and recovery generation; enumerate all in-flight/UNKNOWN records after restart. |
| CB02-F10 | P2 | Journal stale lock is fail-closed but has no safe recovery procedure | Existing lock blocks future writes; safe, but can require manual intervention after crash. Blind stale-lock deletion is unsafe. | **ADD operator recovery.** PID/process identity check, lock age, host boot/session identity, exclusive recovery protocol, audit event. Never auto-delete solely by age. |
| CB02-F11 | P2 | Journal capacity is bounded without rotation/compaction | 10,000 entries and 8 MiB cap eventually fail closed. No compaction/retention or archive mechanism in inspected file. | **ADD.** Signed/hash-chained archive or snapshot+cursor compaction with explicit retention. |
| CB02-F12 | P2 | Atomic rename is not followed by directory fsync | File data is fsynced before rename; directory metadata durability across sudden power loss is not explicitly established. | **HARDEN.** Directory fsync where supported; document Windows-specific durability limits and test recovery. |
| CB02-F13 | P1 | Whole journal integrity is not authenticated as one document | HMAC is used for fingerprints; inspected journal file does not authenticate the complete serialized entries/metadata as a whole. | **HARDEN.** Add versioned record integrity/MAC or hash chain; key rotation/recovery contract. |
| CB02-F14 | P2 | Provider registry and adapters have multiple ownership points | Provider allow-list/origin/adapter logic appears across page, server and extension. Drift can cause inconsistent authorization. | **REFACTOR.** One versioned provider capability registry; generated/validated copies only. |
| CB02-F15 | P1 | Orchestrator documentation references a runtime not present in inspected tree | `ORCHESTRATOR.md` describes `hub/hub.mjs`, `PROJECT.md`, `PLAN.md`, `tasks/`, `runs/`; PR #113 tree did not show this standalone runtime. The bridge does implement higher-level `agent_*` functions in `bridge.mjs`. | **SEPARATE.** Do not treat documentation as an implemented standalone Hub. Build Orchestrator independently. |
| CB02-F16 | P1 | Agent output is untrusted but no separate Orchestrator policy gate is defined in Bridge API | MCP instructions warn about untrusted content; this is useful but not a structured policy engine for tasks/actions. | **ADD in Orchestrator.** Provenance, sanitization, allowlisted actions, human approval for external effects. |

### Important correction: result replay

The current paired server's `activeId` and durable `requestId` journal prevent us from claiming a demonstrated same-ID duplicate send path in this revision. A Worker-side command-ID quarantine remains useful defense-in-depth against a future/adversarial server that redelivers the same command, but it must be labelled **future-server hardening**, not a confirmed current exploit.

---

## 4. Target architecture

### 4.1 Responsibility boundary

**Chrome Bridge (transport plane)**
- Discover eligible tabs and report metadata.
- Bind/unbind an agent identity to a specific tab and conversation.
- Read bounded page state and return provenance.
- Prepare/commit a browser mutation under a valid capability.
- Enforce per-tab serialization, permissions, fencing and Stop.
- Persist transport attempts and emit evidence/status events.
- Never decide task plans, debate rounds, reviewer assignment, consensus or project acceptance.

**Orchestrator (control plane)**
- Own projects, tasks, subtasks, agent roster, roles and rounds (R1/R2).
- Create request IDs and transport attempts.
- Store prompt/artifact provenance and agent responses.
- Run policy checks on untrusted agent output.
- Request independent reviews and resolve disagreements.
- Decide acceptance/release; record rationale and evidence.
- Use GitHub as durable outbox/inbox/artifact journal, not as realtime transport.

For the initial single-operator / up-to-six-agent workflow, Orchestrator may be a small separate Node process with a durable local state store and GitHub outbox. Do not build a complex multi-tenant Hub until queue volume, multiple operators or deployment needs justify it. It must nevertheless be a separate process/module and separate state owner from Chrome Bridge.

### 4.2 Logical flow

1. Orchestrator creates `taskId`, `requestId`, `attemptId`, participant and role.
2. Operator binds a tab to an agent. Bridge verifies origin, provider, native conversation identity and readiness.
3. Orchestrator asks Bridge to `prepare` a message. No Send click is allowed during prepare.
4. Bridge returns `preparedId`, tab/conversation binding, composer snapshot hash, expiry and fence version.
5. Orchestrator/policy layer validates target and content. A separate explicit commit authorization is issued.
6. Bridge serializes commit in the tab's write lane and atomically checks the current fencing generation at the commit boundary.
7. Bridge reports observations, not assumptions. Orchestrator correlates and decides the task state.
8. On Stop/revoke, admission closes immediately; pre-commit operations are cancelled/invalidated; committed or ambiguous operations are quarantined and reconciled.

### 4.3 Initial component map

| Component | Owns | Must not own |
|---|---|---|
| Tab Discovery | eligible tab metadata, lifecycle | task roles or model identity claims |
| Agent Binding | tabId + provider + conversation identity + epoch | durable task state |
| Read Adapter | bounded read-only observations | mutation permission |
| Prepare Adapter | draft/composer preparation and snapshot | Send click |
| Commit Adapter | one serialized final commit | task scheduling |
| Control/Fence Manager | grants, epochs, per-tab locks, Stop/revoke | orchestration decisions |
| Transport Journal | request/attempt state and evidence | AI response interpretation |
| Orchestrator | tasks, roles, rounds, policy, reviews, decisions | direct DOM manipulation |

---

## 5. Normative transport contract (CB-ORCH-02)

### 5.1 Identifiers and binding

Every mutation attempt MUST carry:
- `protocolVersion`
- `requestId` — stable logical request ID
- `attemptId` — unique attempt; never reused for a second physical send
- `taskId` — Orchestrator task reference
- `agentId` — operator-assigned identity, not inferred from tab title
- `tabId`
- `providerId`
- `origin`
- `conversationId` — provider-native ID/URL/DOM identifier when available
- `bindingEpoch`
- `fencingToken`
- `expiresAt`

The binding key is at least `(tabId, providerId, conversationId, bindingEpoch)`. A conversation fingerprint is an integrity/correlation aid, **not** a substitute for the provider's native identity. If native identity is unavailable or contradictory, mutation is denied.

SPA conversation switches MUST invalidate the binding even if the browser tab and origin remain unchanged. If the provider exposes no reliable switch signal, the binding becomes `IDENTITY_UNCERTAIN` and requires operator rebind.

### 5.2 Per-tab concurrency

- One mutation writer at a time per tab.
- Parallel mutations are allowed across different tabs, subject to a configurable global cap.
- Read-only observation may run separately but MUST NOT mutate composer state or race a commit.
- A tab lane is fenced by a monotonically increasing epoch. Rebind, conversation switch, revoke, Stop, navigation, extension restart or permission loss increments the epoch.
- A stale command MUST fail before any DOM mutation or click.
- A lock timeout is not permission to execute concurrently; it returns a non-success state.

### 5.3 Prepare / commit

**Prepare** may inspect the target and place text in the composer only if explicitly designed as a reversible operation. It MUST:
- verify exact tab, origin and conversation binding;
- verify the composer is empty or matches the expected precondition;
- snapshot original composer state and a stable target identity;
- return `preparedId`, `attemptId`, `composerBeforeHash`, `composerPreparedHash`, `bindingEpoch`, `fencingToken`, `expiresAt`;
- never click Send;
- restore the original composer state on cancellation if safe; otherwise return `PREPARE_ROLLBACK_UNKNOWN` and quarantine the tab.

**Commit** MUST:
- be a distinct explicit action;
- validate `preparedId`, exact conversation, current tab epoch, permission grant and expiry;
- verify composer still equals `composerPreparedHash`;
- enter the per-tab commit critical section;
- perform the final fencing check and the synchronous click in the same serialized execution context with no asynchronous yield between authorization and click;
- persist a durable `COMMIT_STARTED` decision before crossing the irreversible boundary, then persist observed result;
- never claim provider acceptance based solely on DOM click or local event dispatch.

A pre-click fencing check alone is insufficient if revoke/Stop is not serialized against the commit. The implementation MUST define one linearization point: either commit wins and Stop reports `STOP_AFTER_COMMIT` / `STOPPED_WITH_UNKNOWN`, or Stop wins and commit is impossible. No third ambiguous “Stop succeeded” state is permitted.

### 5.4 Stop / revoke semantics

Stop is two separate actions:

**Phase A — close admission**
- synchronously mark global Stop intent;
- increment global Stop epoch and every affected tab epoch;
- reject new mutation requests;
- invalidate uncommitted prepared capabilities;
- prevent a queued operation from entering commit.

**Phase B — reconcile accepted work**
- await all operations that have not crossed commit and prove they cannot commit later;
- rollback prepared composer state or quarantine if rollback is uncertain;
- for operations already across commit, wait for observation within a bounded deadline;
- persist terminal state and recovery cursor.

Allowed outcomes:
- `STOPPED_CLEAN`: no commit occurred; no delayed commit can occur; all prepare effects are reverted or verified inert; all affected attempts have durable terminal records.
- `STOPPED_WITH_UNKNOWN`: one or more attempts may have crossed commit or have unresolved page effects.
- `STOP_UNCONFIRMED`: Bridge cannot establish the state of the executor/extension/page context.
- `STOP_AFTER_COMMIT`: Stop arrived after the irreversible commit boundary; this is not a cancellation success.

The Worker ACK, coordinator ACK, or cleared permission flags alone MUST NOT be represented as `STOPPED_CLEAN`.

Per-tab revoke uses the same protocol for that tab and returns `REVOKED_CLEAN` or `REVOKED_WITH_UNKNOWN`. It cannot simply delete the grant while leaving an injected action untracked.

### 5.5 Delivery, reply and verification states

Transport events are observations. They are not interchangeable.

| State | Meaning | What it does not prove |
|---|---|---|
| `ACCEPTED` | Bridge accepted the request for validation | dispatch or delivery |
| `PREPARED` | Composer prepared and snapshot verified | Send occurred |
| `COMMIT_STARTED` | irreversible boundary entered | provider received message |
| `SENT_OBSERVED` | local UI shows a sent-message artifact | provider accepted/processed it |
| `DELIVERY_OBSERVED` | provider-specific independent evidence indicates delivery/acceptance | model generated a reply |
| `REPLY_OBSERVED` | reply-like content appeared in the bound conversation | reply belongs to this request |
| `REPLY_ATTRIBUTED` | reply is correlated to the request using provider-supported evidence | answer is correct or safe |
| `VERIFIED` | independent/provider-backed verification meets an explicit policy | correctness of all claims |
| `UNKNOWN` | evidence cannot decide outcome | permission to retry |
| `BLOCKED` | policy/permission/identity gate denied action | action was attempted |

`UNKNOWN` is terminal for that physical `attemptId`. It may later receive reconciliation evidence, but it MUST NOT be automatically resent. A new attempt requires an explicit Orchestrator decision and a new `attemptId`.

A hidden/zero-width request marker may be used as a diagnostic correlation hint only. Echoing it is not proof of identity, delivery or model authorship. Network request observation proves at most that a request was initiated; it does not prove provider acceptance.

### 5.6 Journal and recovery

Journal MUST record, without storing secrets or full prompt/reply content by default:
- requestId, attemptId, taskId, agentId, tabId, providerId;
- conversation identity/fingerprint and binding epoch;
- fencing token generation;
- state transition, monotonic sequence, timestamp and evidence reference;
- commit boundary decision;
- stop/revoke generation;
- recovery cursor such as `last_decided_seq`;
- process/extension session identity.

On restart:
1. load and integrity-check the journal;
2. identify all non-terminal attempts;
3. mark them `UNKNOWN` unless a durable pre-commit proof establishes they never crossed commit;
4. never replay a send automatically;
5. reconcile current tab/conversation state before any new mutation;
6. emit a recovery report for Orchestrator.

Stale locks fail closed. Recovery must verify process identity and host/session identity; age alone is not sufficient to delete a lock. Add bounded compaction/archive before the current 10,000-entry / 8 MiB limit is reached. Preserve auditability across compaction.

### 5.7 Trust boundary and prompt injection

All page content, provider responses, agent output, GitHub comments and artifacts are untrusted input. They MUST NOT be interpreted as executable instructions.

Orchestrator policy layer must:
- preserve source and author provenance;
- distinguish agent-authored, operator-authored and system-generated content;
- reject instructions embedded in retrieved page/agent content that attempt to change policy, disclose secrets, execute commands or alter permissions;
- use explicit allowlisted tool capabilities;
- require operator approval for external side effects;
- sanitize and size-limit artifacts;
- prevent one agent's output from silently becoming another agent's system/developer instruction.

A GitHub username or a self-declared `agent=` label is not cryptographic identity proof. For consortium records, label authorship as **claimed**, **connector-authenticated**, or **independently verified**.

---

## 6. File disposition map

| Existing area | Decision | Required work |
|---|---|---|
| `extension/background-coordinator.js` | **REFACTOR** | in-flight registry, global/per-tab epochs, stop admission gate, drain/quarantine, revoke drain |
| `extension/transport-worker.js` | **KEEP + FIX** | command ID dedupe/quarantine as defense-in-depth; explicit stop lifecycle events; do not overstate ACK |
| `extension/transport-host.js` | **KEEP + FIX** | propagate operation identity and terminal events; distinguish worker ACK from page drain |
| `extension/one-click-session.js` | **KEEP + FIX** | preserve explicit local gesture and permission revocation; invoke new Stop protocol |
| `extension/one-click-control-gate.js` | **REFACTOR** | validate scoped capability/fence, not only booleans + host grants |
| `extension/one-click-mutation.js` | **REFACTOR** | split prepare and commit; single writer; capability and epoch validation |
| `extension/page.js` | **REFACTOR** | provider identity observer, composer snapshot/rollback, commit linearization; page executor remains minimal |
| `server/bridge.mjs` | **REFACTOR** | transport-only API, per-tab queues, explicit operation state; remove task orchestration semantics from Bridge |
| `server/send-journal.mjs` | **KEEP + HARDEN** | recovery cursor, whole-record integrity, safe lock recovery, archive/compaction, directory durability |
| `server/send-outcome.mjs` | **KEEP + EXTEND** | richer observed states; no count-only attribution; explicit reconciliation |
| `server/tools.mjs` | **REFACTOR** | versioned transport tools; keep task/round/review API out of Bridge |
| `server/schema.mjs` | **EXTEND** | strict versioned schemas, IDs, fencing token and state transition validation |
| `ORCHESTRATOR.md` | **REWRITE** | describe separate Orchestrator runtime and actual implementation status; no phantom paths |
| New `orchestrator/` | **NEW** | task engine, participants, R1/R2 rounds, policy, GitHub outbox/inbox, decision ledger |
| New transport contract tests | **NEW** | Stop/commit race, per-tab isolation, restart recovery, conversation switch, late result |

---

## 7. Required test matrix

All tests must be executable, deterministic and tied to the exact commit SHA. A test name or empty CI job is not evidence.

| ID | Scenario | Required assertion |
|---|---|---|
| T01 | Stop before prepare | request rejected; no composer mutation |
| T02 | Stop during prepare | prepared capability invalidated; no Send click |
| T03 | Stop after prepare, before commit | commit rejected by epoch/fence |
| T04 | Stop races final commit | deterministic linearization: Stop wins OR `STOP_AFTER_COMMIT`; never false clean |
| T05 | Global Stop with multiple in-flight tabs | admission closed immediately; every operation drained or quarantined |
| T06 | Per-tab revoke during injected page action | no post-revoke commit, or explicit `REVOKED_WITH_UNKNOWN` |
| T07 | Worker ACK but page action still pending | must not report `STOPPED_CLEAN` |
| T08 | Composer changed after prepare | commit denied; no click |
| T09 | Prepare rollback fails | tab quarantined; no subsequent mutation |
| T10 | SPA conversation switch without navigation | binding epoch changes; old prepared commit rejected |
| T11 | Provider URL/native conversation changes | binding invalidated |
| T12 | Two mutations on same tab | serialized; no overlap |
| T13 | Mutations on two tabs | bounded parallel execution allowed |
| T14 | Slow agent_wait/read on tab A | does not block tab B mutation lane |
| T15 | Late result after UNKNOWN | reconciles same attempt only; no second send |
| T16 | Restart with PREPARED/COMMIT_STARTED record | recovery marks UNKNOWN unless durable proof says pre-commit |
| T17 | Corrupt/tampered journal | fail closed and report exact reason |
| T18 | Stale lock | no age-only deletion; controlled recovery path |
| T19 | Journal capacity/compaction | no silent loss; cursor continuity verified |
| T20 | Prompt injection in agent response | treated as data; cannot change permissions or trigger tools |
| T21 | Rebind same tab to another agent/conversation | prior capability invalidated |
| T22 | Host permission revoked externally | all mutations fail closed; no stale Connected state |
| T23 | Stop message/ACK lost | `STOP_UNCONFIRMED` or `STOPPED_WITH_UNKNOWN`, never clean |
| T24 | Provider response marker echoed | remains unverified unless independent attribution exists |

### CI and E2E gates

1. Node unit tests run with non-empty workflow steps and archived logs.
2. Static checks and schema compatibility tests pass.
3. Test-only reproducer from Issue #83 is run against exact PR #113 SHA and reviewed independently.
4. Windows isolated Lab build/install test on a dedicated port and extension ID.
5. Real Chrome test with synthetic/non-sensitive content; no real provider send unless separately approved.
6. Fault injection for Stop, Worker termination, page injection delay, permission revoke, restart and lost ACK.
7. Evidence bundle includes commit SHA, environment, test command, raw result, timestamps and screenshots/log references.
8. Rollback restores previous Lab extension/server config without touching Production.

---

## 8. Implementation sequence

**Phase 0 — reproduce, do not patch**
- Retrieve and run the existing test-only reproducer in Issue #83 against exact SHA.
- It must exercise the real coordinator message handler and imported `pageAction` with synthetic DOM.
- Place a deferred barrier after the final asynchronous readiness wait and immediately before the final synchronous Control/context checks; do not add an await between those checks and `btn.click()`.
- Capture whether Stop/revoke returns before the action reaches or is prevented from reaching the click.
- Obtain independent review of reproducer and expected invariant.

**Phase 1 — contract and state model**
- Implement protocol schema, operation registry, per-tab lanes and fencing model in an isolated Lab branch.
- Specify the linearization point and Stop outcomes before changing page code.
- Keep current production server, extension, ports 17381/17382, credentials and permissions untouched.

**Phase 2 — prepare/commit**
- Add reversible prepare, preparedId and composer snapshot.
- Add commit authorization with per-tab serialized final boundary.
- Add rollback/quarantine behavior.

**Phase 3 — journal/recovery**
- Add recovery cursor, attempt state reconciliation, integrity protection and bounded archive.
- Test crash/restart at every transition.

**Phase 4 — Orchestrator separation**
- Introduce separate Node Orchestrator state owner.
- Move tasks, agent roles, R1/R2, review and decision records out of Bridge.
- GitHub outbox/inbox is durable coordination, not claimed real-time delivery.

**Phase 5 — acceptance**
- Run full test matrix, CI, isolated Windows/Chrome E2E and rollback.
- Keep PR Draft/NO-GO until independent evidence is complete.

---

## 9. Explicit non-goals and guardrails

- No edits to Production Chrome Bridge, ports `17381/17382`, Production credentials, tunnel or extension permissions.
- No real provider message sends during source audit or synthetic reproducer.
- No automatic retries for `UNKNOWN`.
- No claim of exactly-once delivery.
- No claim that a stable DOM reply, marker echo, HTTP request or GitHub comment proves receipt by a specific AI.
- No treating Claude/DeepSeek/Kimi reports that were access-blocked as source findings. Their contributions are design proposals only.
- No implementation based on self-declared agent identity.
- No Windows E2E claim until it has actually been run and evidence captured.

## 10. Release gate

**Current state: NO-GO.**

Release may move to conditional GO only when:
- CB02-F01 and CB02-F02 are fixed and independently reproduced as closed;
- T01–T24 are implemented or explicitly justified as not applicable;
- all CI jobs execute real steps on the exact candidate SHA;
- isolated Windows/Chrome E2E passes;
- Stop outcomes are truthful under lost ACK and late page action;
- journal recovery and rollback are proven;
- Production remains unchanged until a separate, explicit deployment plan is approved.

**Decision:** accept the thin Bridge / separate Orchestrator architecture. Do not patch or release PR #113's mutation path until Phase 0 reproducer and independent review are complete.


---

## 11. Phase 0 execution log — 2026-11-21

A separate ChatGPT-authored test-only artifact was created from the exact PR113 base SHA:

- Branch: `test/pr113-stop-linearization-reproducer-20261121`
- Commit: `f42ef095a9da18451f8bb15cbec3a6b86d04ab0f`
- Draft PR: #121
- Test path: `tests/pr113-stop-linearization.test.mjs` (under `chrome-bridge-v20`)

The harness is designed to:
1. invoke the actual `installBackgroundCoordinator()` listener;
2. enter the actual all-tabs `agent_send` route and `dispatchOneClickMutation()`;
3. run the imported `pageAction` against a synthetic textarea/button DOM;
4. hold the actual page action in its Send-button readiness await using a deferred promise;
5. invoke the trusted coordinator `stop-background` handler while held;
6. release the action and assert that no click occurs after Stop reports success.

The test contains no production source edits. It is intentionally expected to fail if the unsafe ordering is reproduced.

### Execution evidence

The PR generated six check-runs. All six jobs returned empty `steps[]`; job-log downloads returned Azure `BlobNotFound` / HTTP 404. The dedicated Node 24 source-test workflow completed as failure in approximately two seconds without observable execution steps.

**Classification: NOT EXECUTED / UNKNOWN.** No test PASS or runtime reproduction is claimed. The harness is committed but remains unverified until an executable Node runner provides raw output. The Codex-specific executor ACK requested in Issue #83 has not been observed; this artifact is explicitly authored by ChatGPT and does not impersonate Codex or bypass `CODEX_DISABLED`.

Issue #83 has been updated with the exact branch, commit, PR and evidence classification. PR #121 remains Draft. Production ports, credentials, tunnel, installed extension, permissions and Control were not touched; no provider message was sent.

### Phase 0 next gate

Do not patch runtime source yet. Obtain a runner that can execute the exact commit's Node test suite with non-empty steps and logs. If that cannot be made available, preserve the harness and report the execution boundary as blocked rather than treating the GitHub workflow's failure status as a test failure.
