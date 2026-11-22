# Six-model AI consortium protocol

**Status:** protocol draft for the Chrome Bridge Lab  
**Priority roster:** Claude, DeepSeek, Qwen, Kimi, Grok, Gemini

## Goal

Use multiple independent assistants to review one bounded engineering task, challenge each other's findings, and produce one evidence-backed decision. The consortium is an advisory and review mechanism. It does not replace the operator, tests, code review, or explicit approvals.

## Roles

| Participant | Default assignment |
| --- | --- |
| Claude | Source-code review, implementation risks, regression paths and patch critique |
| DeepSeek | Independent architecture analysis, failure modes, alternative designs and adversarial challenge |
| Qwen | Systems-level reasoning, boundary conditions, deployment/recovery analysis and synthesis |
| Kimi | Long-context document review, requirements comparison and evidence extraction |
| Grok | Adversarial counterexamples, assumptions challenge and independent second opinion |
| Gemini | Independent verification, structured comparison and factual cross-check |

Roles are defaults, not model capability guarantees. Assignments may be rotated to reduce anchoring.

## Work item envelope

Every consortium task must carry the same immutable task packet:

- `task_id`: stable request identifier, reused for status checks and safe retries
- `objective`: one decision or deliverable, stated in testable terms
- `repository`, `branch`, `commit_sha`: exact source snapshot
- `scope`: files, modules and interfaces in scope
- `constraints`: Production/Lab boundaries, security limits, forbidden operations
- `evidence_pack`: relevant logs, test results, source excerpts and artifact references
- `required_output`: findings, evidence, severity, confidence, reproduction, recommendation
- `approval_boundary`: actions that are prohibited without separate operator approval

Do not send secrets, access tokens, personal browser content or unrelated private files to a participant.

## Three-round review

### Round 1 — independent analysis

Send the same task packet to each available participant independently. Ask each to return:

1. Findings with file/line or evidence reference.
2. Reproduction steps or a falsifiable test.
3. Severity and confidence.
4. Proposed fix and regression tests.
5. Unknowns and assumptions.

Participants must not see each other's conclusions in this round.

### Round 2 — cross-examination

After freezing Round 1 replies, distribute anonymized findings to other participants. Ask them to classify each finding as confirmed, disproven, incomplete or unverified, with evidence. Require at least one attempt to falsify the leading proposal.

### Round 3 — synthesis and decision

The coordinator merges duplicates, records disagreements, compares proposals against source and test evidence, and produces:

- confirmed findings
- rejected findings with reason
- unresolved disagreements
- recommended patch and tests
- explicit GO / CONDITIONAL GO / NO-GO decision

A majority vote is not proof. Source, runtime evidence and regression tests outrank consensus. The operator remains the final approver for consequential changes.

## Automation and file exchange

The intended Bridge workflow is `agent_send` → `agent_wait` → evidence capture → cross-review. Each send must use a stable `requestId`; an UNKNOWN send must never be retried with a new ID until its original state is resolved.

The current Lab tool surface has shown intermittent `UNKNOWN_TOOL` and `COMMAND_NOT_MIGRATED` responses. Therefore fully automated fan-out/fan-in is **not accepted yet**. Do not report a task as delivered to a participant unless a send acknowledgement and resulting reply are both observed.

For text-only handoff, use explicit bounded blocks:

```text
=== FILE: relative/path.ext ===
...complete text...
=== END FILE ===
```

For real files, transfer only an explicitly selected artifact through a verified file-transfer mechanism. Do not claim that a path, filename or link alone proves the recipient received the file. Binary attachments and large repositories need a separately verified transfer route.

## Current activation tiers

- **Control-capable origin:** Claude, Gemini and DeepSeek are in the approved-origin map. Each still requires an active, unexpired local per-origin grant and per-action approval.
- **Discovery-only candidate:** Qwen, Grok and Kimi. Their presence in the roster or browser does not enable binding, sending, navigation or mutation. Selectors stay blank until reviewed.
- **Unavailable/stale participant:** a closed tab, stale tab ID, exhausted provider quota or non-responsive connector must be marked unavailable for that task rather than counted as a vote.

## Release gates

The consortium is considered operational only when all of the following pass:

1. All six exact provider origins and agent bindings are correctly identified in the Lab, without Production cross-talk.
2. Each provider's read-only self-test reports a unique composer and reply container; candidate send/stop selectors are separately reviewed.
3. A non-sensitive single-message test is acknowledged and its response is attributed to the correct provider.
4. Two or more agents can be run independently without cross-delivery or response mixing.
5. `requestId` replay/status behavior, timeout, UNKNOWN state and manual cancellation are tested.
6. Text and file handoff has a verified receipt, hash and recipient association.
7. Revocation, expiry, origin change, browser restart and Lab restart fail closed.
8. A complete audit log can trace task ID, commit SHA, participants, messages, approvals, file hashes, test evidence and final decision.

Until those gates pass, describe the system as a **partially connected consortium prototype**, not an autonomous multi-agent orchestrator.
