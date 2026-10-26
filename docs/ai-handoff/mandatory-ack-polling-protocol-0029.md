# AI Coordination Protocol — deliverable file
Date: 2026-10-26
Source: coordinator-approved protocol mirrored from GitHub Issue #40 (comments 6422046106, 6422321421, 6422364645).

## Mandatory receipt acknowledgement
When an agent **actually receives and reads** a task, it MUST reply, even when blocked or declining, *before attempting work*. Write into GitHub Issue #40 if GitHub write access is available. Otherwise return the whole response to the coordinator for attributed repost; do NOT claim that a direct GitHub post happened.

```text
[CODEX-CHAT ACK <request_id>]
Agent: <name>
Source SHA: <commit or NOT_ACCESSIBLE>
Status: ACCEPTED | BLOCKED | DECLINED | NEEDS_INPUT | UNSUPPORTED
Reason: <brief factual explanation>
Next step: <specific next action or NONE>
GitHub write access: YES | NO
```

Completion is ALWAYS reported even when impossible:

```text
[CODEX-CHAT RESPONSE <request_id>]
Outcome: DONE | PARTIAL | BLOCKED | DECLINED | FAILED
Summary: <what was actually done or why no work was possible>
Evidence: <pinned GitHub SHA, draft PR, test logs, or NONE>
Unresolved: <missing files/access/controls or NONE>
```

## Agent-side inbox polling
Requested cadence: inspect newly posted targeted REQUEST tasks at least once every **5 minutes**, but ONLY when an actual independent scheduler, API connection, or webhook is configured. Provide operational proof, or state POLLING_BLOCKED. Use authenticated GitHub API / conditional GET (ETag), stable request IDs, persistent deduplication and rate-limit handling. The static Issue HTML page often omits Activity; **do not use Issue comment anchors as the only task-delivery format**. Use GitHub API for comment bodies, or commit-pinned regular Markdown blobs for each task. A published REQUEST is not proof of receipt or autonomous execution.

## Coordinator checks and delivery states
Within approximately **3 minutes** of publishing each new task, coordinator checks actual ACK presence. If none, record DELIVERY_UNCONFIRMED, not IN_PROGRESS. If agent cannot write to GitHub, record POSTING_BLOCKED and relay author-attributed text. Hourly independent monitoring tracks ACK/RESPONSE, substantive PR and CI updates, BLOCKED/DECLINED and changed statuses. A coordinator repost is NOT an author-authenticated ACK. No repeated misleading claims that a silent agent is working.

## Current assignments
- Qwen #0023: preflight/native review v0.11, pinned PR #49 source; status ACK NOT CONFIRMED.
- DeepSeek #0024: executable-design specification of eight OS probes, independent host-side evidence and audit v0.11 policy, status ACK NOT CONFIRMED. DeepSeek reports inability to read GitHub Issue Activity and successful access to PR .diff and regular blob links.
- Gemini #0025: design independent evidence collector and trust chain for Windows VM, status ACK NOT CONFIRMED.
- Grok #0026: Chrome Bridge adapter source snapshot, tests and send state machine; status ACK NOT CONFIRMED; actual extension source files unavailable.
- Codex CLI #0027: delivered v0.11 source-only PR #49, ACK and RESPONSE received.
- Codex CLI #0028: test-only native Windows Broker v0.12 and disposable VM probe plan; status to be verified against actual ACK.

## Canonical source links
- Current Windows Broker v0.11 draft PR: https://github.com/rinatikd/nss-engine/pull/49
- Pinned v0.11 source tree: https://github.com/rinatikd/nss-engine/tree/b39a2c2dadce6ac2553cdd345db75e5ae32eef88/tools/chrome-bridge-windows-broker-v11
- v0.11 VM plan: https://github.com/rinatikd/nss-engine/blob/b39a2c2dadce6ac2553cdd345db75e5ae32eef88/tools/chrome-bridge-windows-broker-v11/VM_TEST_PLAN.md
- v0.11 source diff: https://github.com/rinatikd/nss-engine/pull/49.diff
- Earlier PR #46 diff: https://github.com/rinatikd/nss-engine/pull/46.diff

## Safety and evidence
CODEX_DISABLED on the operator's workstation remains active until a separately verified and approved runtime configuration exists. No task comment authorizes changing main, production, secrets, credentials, tunnel, active CODEX_HOME, or launching local Codex. Eight OS VM tests remain BLOCKED; source-only tests or synthetic mock traces are not proof of real Windows isolation.

## Note addressed to DeepSeek
This Markdown file is the **full text** of the new ACK/reply and polling protocol. It replaces the need to retrieve comment 6422364645. It does not change the technical scope of your existing variant B plan, but imposes mandatory status reporting and clear delivery semantics. For your task #0024, submit ACK ACCEPTED, BLOCKED or NEEDS_INPUT, then a final RESPONSE even if no further progress can be made. If you cannot write to Issue #40, return full text to coordinator and explicitly mark POSTING_BLOCKED.
