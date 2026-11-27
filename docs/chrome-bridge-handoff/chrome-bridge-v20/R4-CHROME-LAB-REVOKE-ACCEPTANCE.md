# R4 Chrome Lab — Revoke, Worker Recovery and Quarantine Acceptance

**Status: AUTOMATED DISPOSABLE-LAB ACCEPTANCE PASS (2026-11-27). Production remains NO-GO pending independent review and operator acceptance.** This document defines the isolated Chrome MV3 acceptance run for the R4 Revoke-fence stack (#165–#167). It is a test plan, not evidence of a PASS. Keep all PRs Draft and do not merge or deploy until the gates below are closed.

## Safety boundary

- Use only the disposable Chrome Lab profile, isolated extension build, and isolated lab server.
- Do not use the production profile, production ports, credentials, provider sessions, live AI chats, or production tunnel.
- Use a deterministic local test page / fixture for page mutations. No real message submission.
- Record the exact extension artifact SHA, source commit, Chrome version, lab server endpoint, test start/end time, and sanitized logs.
- Any uncertain result is **UNKNOWN** and remains blocked. Never convert timeout, Worker termination, storage failure, or missing evidence into SUCCESS.
- Do not clear quarantine by editing Chrome storage manually or by deleting markers in DevTools.

## Current implementation finding

The baseline stack persisted per-tab quarantine in `bridgeMutationQuarantinedTabs` and a global fail-closed lock in `bridgeMutationQuarantineLock`, but did not expose a dedicated operator reconciliation workflow.

A candidate implementation is now being developed on `fix/r4-operator-quarantine-reconciliation-20261127` (Draft PR #185). It adds an operation-bound quarantine record, an isolated-world terminal marker written only when the original page action reaches its `finally` block, an explicit Control UI confirmation, exact tab/origin/conversation/request/token checks, and a durable operator audit event. Recovered global Revoke records now retain operation identity; the global admission fence remains until every affected tab has its own terminal evidence and audit event. Partial fence cleanup is designed to remain retryable.

This is **implementation in review, not an accepted release capability** until the new unit tests and real disposable-MV3 Scenario D integration test pass on the exact PR head and the code receives independent security/lifecycle review.

The existing `clear-background-controls` command remains a Revoke/Clear operation; it is **not** proof that an earlier UNKNOWN action completed. It must not be treated as a quarantine-unlock operation. A ProviderJournal delivery outcome of `UNKNOWN` remains `UNKNOWN` after operator reconciliation; the workflow must never retry or claim successful delivery.

## Acceptance scenarios

For every scenario capture: expected result, actual result, timestamped coordinator/UI logs, persisted local/session storage state, and test artifact SHA. Mark PASS only when all assertions are directly observed.

### A. Per-tab Revoke fence

1. Start the isolated background transport and grant temporary Control to one disposable fixture tab.
2. Start a deliberately held page mutation; verify it is admitted and visible as in-flight.
3. Issue per-tab Revoke while the mutation is held.
4. Verify the Revoke admission marker is durably written before waiting for the grant-store operation.
5. Attempt a second page mutation and a new Grant for the same tab. Both must be rejected while Revoke is pending.
6. Terminate/restart the MV3 service worker while the fence is pending. The replacement Worker must still reject page mutations and Grants using durable state.
7. Release the held mutation. Verify Revoke completes, grant removal is confirmed, and only then are the per-tab pending markers cleared.
8. Verify a fresh Grant is possible only after the confirmed Revoke has completed and no quarantine/global lock applies.

**PASS criteria:** no post-Revoke admission; replacement Worker preserves the fence; no premature marker deletion; no false SUCCESS.

### B. Per-tab uncertain completion and quarantine

1. Inject a controlled timeout or storage/grant-store failure at each Revoke boundary: marker write, grant-store revoke, and marker cleanup.
2. Verify the response is `UNKNOWN`, includes the affected tab ID, and the tab is durably quarantined (local storage preferred; session fallback accepted only as specified by the implementation).
3. Restart the Worker and repeat page mutation and Grant attempts. Both must remain blocked.
4. Simulate local and session storage read/write failures and conflicting state. The coordinator must fail closed; it must not infer an empty quarantine set from unreadable state.
5. Verify the UI does not display a successful revoke or imply that the tab is safe to reuse.

**PASS criteria:** uncertainty remains visible and durable; all mutation and Grant paths deny; no automatic quarantine removal.

### C. Global Session Revoke

1. Open at least two disposable fixture tabs with temporary grants; start one held page mutation.
2. Dispatch `session_revoke`.
3. Verify the global pending record (token and affected tab IDs) is persisted before draining.
4. Attempt new page mutations, new Grants, and `session_authorize`. All must be rejected while global Revoke is pending.
5. Restart the Worker during the drain. Verify the replacement Worker continues to reject those operations.
6. Release the held mutation and allow the revoke/cleanup path to finish.
7. Verify the global marker is cleared only after the revoke is confirmed and affected tabs are not silently restored.
8. If the replacement Worker cannot prove completion of the prior Worker’s action, it must quarantine affected tabs and report `UNKNOWN`.

**PASS criteria:** global fence covers all tabs and Grant entry points; authorization cannot race through; uncertain recovery quarantines every recorded affected tab.

### D. Control UI clear-background-controls

1. With multiple disposable grants, invoke the UI Revoke-all action.
2. Verify no new page mutation or Grant is admitted during the clear.
3. Restart the Worker with a global clear pending and verify the durable fence remains effective.
4. Verify successful clear is shown only after all accepted mutations drain, all grants are cleared, and the global pending marker is safely removed.
5. Force a timeout, partial storage failure, or uncertain cleanup. UI must show failure/UNKNOWN and affected tab IDs; no success toast/status is allowed.
6. Retry the clear operation only as a Revoke/Clear attempt. Confirm it does not erase an existing quarantine or global quarantine lock.

**PASS criteria:** UI status matches coordinator outcome; retry cannot silently unlock quarantined tabs.

### E. Quarantine recovery / operator reconciliation — candidate implementation; acceptance pending

Candidate implementation is present on `fix/r4-operator-quarantine-reconciliation-20261127`. Its contract is intentionally narrow:

1. The operator must initiate reconciliation from the trusted Control UI and confirm the exact tab/request/command shown. No timer, background process, Revoke retry, or automatic unlock invokes it.
2. The UI displays the tab ID, request ID, command, reason, and conversation identity. Missing operation identity is non-reconcilable.
3. The coordinator checks both storage areas, the exact quarantine token, the current approved provider origin and conversation route, and the exact current main-frame URL/document. It then probes the extension isolated world for the live mutation lock and its matching terminal marker.
4. A still-live lock, missing terminal marker, mismatched request/command/origin/conversation/payload/prepared ID, changed document/URL, stale token, global quarantine lock, or timeout is a denial. Quarantine remains.
5. For a recovered global Revoke, operation identity is persisted with the durable global fence. The global admission fence remains until every affected tab has an individual terminal-evidence check and corresponding audit event.
6. The audit event is stored before any deny marker is removed. It records the exact tab, request, command, origin, conversation, global fence token, timestamps, terminal state, click-attempt/return status, and document ID. Audit write failure is fail-closed.

**Identity limitation:** the current audit proves a trusted local Control UI gesture and explicit confirmation, but it does not authenticate a named human operator. Production acceptance must either explicitly accept the local-machine trust boundary or add a verified operator identity source. Do not describe this audit as per-person accountability.
7. Only the matching tab token is removed. Global fence cleanup is attempted before deleting the last tab record, so a partial storage failure leaves a visible, retryable quarantine. Other or newer entries are preserved.
8. Reconciliation is **not** a delivery acknowledgement. If a Send click was attempted, the UI explicitly reports `UNKNOWN` and `DO NOT REPLAY`; ProviderJournal remains unchanged. For a prepare-only action, the operator must inspect/clear any remaining draft before starting a new request.
9. A global `bridgeMutationQuarantineLock` caused by storage failure is outside this workflow and requires separate investigation; this UI will not clear it.

**Required acceptance before release:** pass unit tests for active action, missing/stale proof, multi-tab global fence, storage failure and retry; pass the real disposable Chrome MV3 Scenario D integration that attempts reconciliation while held, then releases the original page action and verifies successful exact reconciliation with no duplicate Send click; independently review the implementation. Until all are complete, this gate is **PENDING / NO-GO**.

## Evidence and release decision

| Gate | Evidence required | Status |
| --- | --- | --- |
| Source/CI for R4 A–D stack | Exact-head Visual RC, Source checks, and RC1 Control Gates | PASS on #182 head `ffa2cc220c6f64b44cb3b3a224c60dacaafe32bc`; not a review or production acceptance |
| Scenario A — per-tab Revoke | Real disposable Chrome MV3 + HTTP MCP; A/B grant isolation; no Send click | PASS, Visual RC run `45931300044` |
| Scenario B — global Revoke | Trusted UI, queued mutation cancellation, durable clearing, worker reload | PASS, Visual RC run `45931300044` |
| Scenario C — late approval race | Ten repeated real MV3 race attempts | PASS 10/10, Visual RC run `45931300044` |
| Scenario D — uncertain commit recovery | One Send click, lost receipt, Revoke UNKNOWN, worker/Bridge restart, journal UNKNOWN, durable fence | PASS on #182 head, Visual RC run `45931300044`; operator reconciliation not yet included |
| Windows synthetic upgrade/rollback | Staged preflight, apply, restore prior extension files | PASS in CI; local/operator Windows acceptance still pending |
| Operator quarantine recovery | Scenario E implementation, unit tests and real-MV3 integration on exact PR head | PENDING — PR #185 exact-head CI pending |
| Independent security/lifecycle review | Attributable review of combined stack, including failure paths | PENDING |
| Release packaging and rollback | Immutable artifact inventory and independent install/rollback rehearsal | PENDING |
| Live provider acceptance | Explicitly approved end-to-end send/reply/revoke for each supported provider | NOT RUN / NOT ACCEPTED |

## Release rule

R4 is **NO-GO** while any real Chrome Lab scenario is unrun, operator recovery is absent, any independent review is missing, or any result is UNKNOWN. Green CI alone does not close these gates. Do not remove Draft status, merge, tag, or deploy based solely on this checklist.

## Source integration checkpoint — 2026-11-27

The R4 source stack is being integrated into `platform/ai-windows-control-release-20261114` in dependency order. The following PRs have been merged into that branch with GitHub merge commits and exact expected-head checks:

| PR | Merge commit |
| --- | --- |
| #165 | `16d2079672d579c18ce067aa1f5cbe748a0380b6` |
| #166 | `ce12d4012a8b7c111d7b936602bf112ba4e70855` |
| #167 | `8d629297c7ca7dd244309c0b35a0ce7ffa434d27` |
| #168 | `513366a65f7c12c3109d8d1c7d3dc8e33d07f47e` |
| #171 | `f364e7101d97201697f75e0818c6e0f797e47b28` |
| #174 | `71da0a3d22a0754765bef885a5948e046639c35a` |
| #175 | `c82b186c35d71e03d8c3697bc11e8049f612dc08` |
| #176 | `a595f5bafd4a3312b4057c1a8c12cf780b92c01d` |
| #177 | `8e355eda75720009ed8e272a8448e7adfb22fe37` |
| #178 | `ff89cdf5dc2accb0b5dd9683bdc2f19e42972648` |
| #179 | `055018c39b034198ad4208ce5c438db37462909e` |
| #180 | `2f879e46a1521359801ed2e179d3bbbaeefaf9c2` |
| #181 | `accbd546616dcc8625386a4bcfa31d2e04ac3641` |
| #182 | `f9f938b3513c88cc4ef91fbfd719dae13cd77173` |
| #183 | `0a4d7a31370688b848ba8aee2ae2509152676e91` |

The remaining dependent history (#184–#187) is carried by the aggregate PR #187, now retargeted directly to this release branch. This avoids merging intermediate revisions whose historical CI runs exposed a cooperative-cancellation harness failure and six quarantine test-fixture/expectation failures. The final aggregate head must pass the full exact-head Control Gates, Source checks, and Linux/Windows Visual RC workflows before it is merged.

The sibling draft PRs #169 and #170 were not in the selected dependency path (#171 is the direct child of #168); they remain separate and are not silently included in this integration.

**This checkpoint records source integration only.** It does not claim that disposable-Windows install/rollback, live provider send/reply, independent security review, or operator production acceptance has been performed. Production remains NO-GO until those separate gates have evidence.

## 16. Final platform integration and post-merge acceptance — 2026-11-27

**Integrated platform branch:** `platform/ai-windows-control-release-20261114`  
**Final branch head:** `73b676e6f53b177a5396010ea029791ffac4a36f`

### Source integration

The R4 implementation chain was merged bottom-up into the platform branch:

`#165 → #166 → #167 → #168 → #171 → #174 → #175 → #176 → #177 → #178 → #179 → #180 → #181 → #182 → #183 → #187`

PR #187 carried the remaining #184–#187 changes as one aggregate after historical intermediate revisions exposed cancellation/quarantine test-fixture failures. It was merged only after exact-head RC1, Source checks and Visual RC passed. The earlier test PR #170 was then separately reviewed and merged because its exact-document / stale-document / BFCache test materially strengthens lifecycle acceptance. PR #169 was closed as superseded by the implemented recovery and acceptance documentation; PRs #184–#186 were closed as superseded by the final aggregate. PR #172/#173 are unrelated PowerShell Direct work and are outside this R4 integration.

### Exact post-merge CI on final platform head

| Workflow | Run | Result |
|---|---|---|
| Chrome Bridge RC1 Control Gates | [#1139](https://github.com/rinatikd/nss-engine/actions/runs/46032393020) | PASS — 12/12 |
| Source checks | [#5092](https://github.com/rinatikd/nss-engine/actions/runs/46032392997) | PASS — all 6 jobs |
| Chrome Bridge Visual RC | [#1198](https://github.com/rinatikd/nss-engine/actions/runs/46032392973) | PASS — Linux 27/27, Windows 17/17 |
| AI collaboration protocol checks | [#772](https://github.com/rinatikd/nss-engine/actions/runs/46032393189) | PASS — task-envelope 7/7, recovery-contract 8/8 |

The exact final Visual RC includes:
- real disposable MV3 service worker, offscreen recovery and closed-panel lifecycle;
- exact-document targeting, stale-document rejection, cooperative cancellation and BFCache restoration;
- provider-origin permission and per-tab grants;
- R4 Scenarios A–D, including global/per-tab Revoke, late-approval race, UNKNOWN commit and quarantine after MV3/Bridge restart, and evidence-bound operator reconciliation;
- cancellation before side effects, Gemini fail-closed DOM, concurrent HTTP MCP sends, read-only diagnostics;
- Windows PowerShell 5.1 disposable preflight, Lab bootstrap/cutover, upgrade and rollback fixtures.

No CI failure or skipped mandatory step was reported in these four final-head workflows.

### Immutable artifacts from the final-head Visual RC

| Artifact | GitHub artifact ID | SHA-256 |
|---|---:|---|
| `chrome-bridge-rc-windows-upgrade` | `15214987089` | `e86205cb9d3487774ea58c62a14aa178fd3804898cb04be417871cb20393cc21` |
| `chrome-bridge-rc1-lab-hashes` | `15214792926` | `854b627c963e5673149d0727e0c7d6b26913fcc6891d17e3a9a161e1093283b2` |
| `chrome-bridge-pr132-server-lab-package` | `15214074149` | `86b89aac356c3b4fe96acdbd64a760684d18776e33e3a2af4d84ef3ca7370232` |
| `consilium-control-room-lab-package` | `15215206186` | `d6a449f332d3bf766cbf319d211043380f237cd0623d06d0b3df2df4a936bda0` |

The Windows candidate is source-only, not a production installer. The hash manifest labels its target `DISPOSABLE_LAB_ONLY` and binds the staged extension file hashes. Its embedded commit field is GitHub's synthetic merge-test commit `08551cdec256ab0efb47f211a9be0c71f7bb618c`; GitHub compare confirms this is one merge wrapper ahead of the final branch merge commit `73b676e6f53b177a5396010ea029791ffac4a36f` with no file changes. No credentials or user profile data are included.

### Remaining production gates

Automated source/CI acceptance is complete, but **Production remains NO-GO**:
1. No independent submitted security/lifecycle review is recorded.
2. No operator-run installation and rollback of the exact source-only candidate was performed in a disposable Windows user environment.
3. No live Claude/Gemini/DeepSeek/Grok/Qwen/Kimi send→reply acceptance was performed; real provider sends were intentionally excluded from CI.
4. The local Control gesture audit does not authenticate a named human operator; the production trust boundary needs explicit acceptance or a verified operator identity source.

No Production Chrome profile, extension, credentials, ports 17381/17382, tunnel, provider session, or local Windows service was changed during this integration.

## 17. Production audit trust-boundary decision — accepted 2026-11-27

**Decision owner:** repository owner / project operator  
**Accepted policy:** `LOCAL_MACHINE_TRUSTED_CONTROL_UI`

The project owner explicitly accepts the local-machine trust boundary for Production. A trusted local Chrome Bridge Control UI gesture and its durable audit record are sufficient for operator confirmation. The audit is **not required to identify or authenticate a named human**.

This closes the policy decision previously listed as an open release gate. It does not waive implementation checks. The combined implementation must still demonstrate that:
- reconciliation requests originate only from the trusted extension Control UI / authenticated coordinator route;
- a real local gesture and explicit confirmation are required for the exact displayed quarantine scope;
- the audit record is appended before any matching deny/quarantine marker is removed;
- audit/storage failure remains fail-closed and leaves quarantine in force;
- the event captures scope, operation identity, evidence references, timestamps, terminal status, and the accepted local-machine trust model without recording prompts, message bodies, cookies, keys, tokens, or provider secrets;
- replay, stale tokens, changed document identity, partial store writes, and cross-tab reconciliation cannot clear a newer or unrelated quarantine.

### Accepted limitation

The audit proves a trusted local Control UI action in the configured machine/profile boundary. It does not prove which physical person performed it. The project owner accepts that limitation for this release. A compromised local OS, Chrome profile, extension installation, or trusted Control UI remains outside the assurance provided by this operator audit and must be addressed by endpoint security and local account controls.

### Updated remaining Production gates

1. **Independent security/lifecycle review:** PENDING. An attributable reviewer who did not author the implementation must assess coordinator admission and fencing, mutation operation journal ordering, reconciliation proof, UI sender/gesture trust, audit-before-unlock ordering, and all partial-write/restart paths.
2. **Disposable Windows operator rehearsal:** PENDING. Install the exact source candidate into a separate disposable Windows/Chrome profile, verify the extension identity and expected files, run a bounded smoke test against an isolated Lab endpoint, and exercise rollback to the exact prior file inventory. Capture before/after hashes and logs. Do not use the production profile, ports 17381/17382, live provider sessions, production credentials, or tunnel.
3. **Live provider acceptance:** NOT RUN. Claude/Gemini/DeepSeek/Grok/Qwen/Kimi send→reply→revoke acceptance remains a separately authorized operation. Do not send real provider messages merely to close a checklist; obtain explicit approval for the exact provider, test content, and isolated account/session before any live submission.

The local-machine trust-boundary policy is **ACCEPTED** and is no longer a reason by itself to block Production. Production remains **NO-GO** until the independent review and disposable Windows install/rollback are completed, and until the project owner separately authorizes any live-provider acceptance judged necessary for the release.

No production profile, extension, credentials, endpoint, port, tunnel, or local service is changed by this policy update.
