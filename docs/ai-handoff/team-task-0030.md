# TASK 0030 — AI team handoff and mandatory reply
Date: 2026-10-26
Repository: rinatikd/nss-engine
Coordination issue: https://github.com/rinatikd/nss-engine/issues/40
Full communications protocol: https://github.com/rinatikd/nss-engine/blob/c0db3e7943bcda9824f0390a5ead595deb726b98/docs/ai-handoff/mandatory-ack-polling-protocol-0029.md
Pinned Windows Broker v0.11: b39a2c2dadce6ac2553cdd345db75e5ae32eef88
Source: https://github.com/rinatikd/nss-engine/tree/b39a2c2dadce6ac2553cdd345db75e5ae32eef88/tools/chrome-bridge-windows-broker-v11
Diff: https://github.com/rinatikd/nss-engine/pull/49.diff

## Delivery and response contract (REQUIRED)
Every named recipient must respond on actual receipt with an ACK, **even if unable or unwilling to work**:
[CODEX-CHAT ACK ai_team_handoff_0030_<agent>]
Agent: <agent>
Source SHA: <sha or NOT_ACCESSIBLE>
Status: ACCEPTED | BLOCKED | NEEDS_INPUT | UNSUPPORTED | DECLINED
Reason: <why>
GitHub write access: YES | NO
Polling configured every 5 minutes: YES (include evidence) | NO / POLLING_BLOCKED

Final response is mandatory regardless of success:
[CODEX-CHAT RESPONSE ai_team_handoff_0030_<agent>]
Outcome: DONE | PARTIAL | BLOCKED | DECLINED | FAILED
Evidence: <commit/PR/line-linked file or NONE>
Unresolved: <blocker or NONE>

Post ACK and RESPONSE in Issue #40 if access works; if comments are inaccessible/read-only, return complete text to coordinator who will post with explicit relay attribution. Do not assume reading this pinned blob demonstrates that a model or its scheduler is active. A separate agent-side scheduler must exist for automatic 5-minute polling; otherwise state POLLING_BLOCKED. An ACK should be provided *before analysis* and must not be fabricated by coordinator.

## Work assignments

### Codex CLI: native launcher engineering (0030_codex)
Continue #0028. Produce a separate draft PR for test-only v0.12 Windows broker implementing or precisely blocking a fail-closed CREATE_SUSPENDED / verified image binding / AppContainer / Job Object / explicit HANDLE_LIST native launch transaction. Only synthetic signed fixtures, no real Codex runs, no production changes. Give source and test matrix and explicit gaps; preserve CODEX_DISABLED.

### Qwen: native Windows security review (0030_qwen)
Perform independent pinned-source review of PR #49 native launcher design and API trust boundaries. Assess image identity between inspection and ResumeThread, reparse/hardlink handling, AppContainer/LPAC, Job Object containment and inheritance. If actual native launcher is not implemented, mark as BLOCKED, do not invent line findings. Review v0.12 when new SHA is published.

### DeepSeek: OS test and policy review (0030_deepseek)
Using PR #49 diff and VM_TEST_PLAN.md, review all eight OS isolation scenarios for runnable probes, external host observer, evidence integrity, failure/cleanup, JS policy trust-boundary residuals and rollback. Produce code/line-linked findings with PASS/FAIL/SKIP/BLOCKED; explicitly distinguish source-level results from nonexecuted tests. Existing variant B stays a plan; customer authorization to remove gate is not evidence the isolation works.

### Gemini: independent evidence verification (0030_gemini)
Audit VM evidence manifest provenance, independent observer trust root and reproducible checks on hosted Windows runner vs dedicated VM. Enumerate strong/weak evidence, limitations, and precise PASS criteria for each of eight probes. Do not fabricate completed OS tests.

### Grok: Chrome Bridge adapter readiness (0030_grok)
Produce an exact list and safe acquisition instructions for sanitized Chrome Bridge extension source snapshot (adapters.js, page.js, permissions.js, control.js, manifest.json plus SHA256). Plan a source-based Grok adapter patch and deterministic tests, including local time-limited Control, exact origin, DELIVERED/UNKNOWN/FAILED and never automatic retry on UNKNOWN. If source still missing, ACK NEEDS_INPUT and final RESPONSE BLOCKED rather than silence.

## Operational and safety boundaries
No generic or direct Codex execution; no production, credentials, tunnel or active CODEX_HOME changes; don't enable CODEX_DISABLED solely on basis of source-only CI. Keep PRs draft, use reviewed source and independently observed disposable VM tests. Publish concrete evidence, no made-up statuses.

## Current delivery reality
The GitHub issue comment page can hide Activity in static HTML. GitHub pinned Markdown blob or direct PR .diff is canonical retrieval route. Even successful task publication does NOT confirm delivery. Each recipient must explicitly acknowledge; otherwise the coordinator must mark DELIVERY_UNCONFIRMED.
