# Chrome Bridge 0.2.0 — Background Mode RC1

Status: **DRAFT / NOT APPROVED FOR PRODUCTION** (2026-11-05)

## Provenance

- Source: `release/chrome-bridge-v0.2.0-background-rc1`
- Stack: PR #90 (control-panel sender trust), PR #91 (worker dispatch fix and diagnostics), PR #92 (native fetch receiver), PR #93 (security and recovery regression tests).
- Intended production default endpoint: `http://127.0.0.1:17381`; laboratory endpoint `http://127.0.0.1:17481` is a local-only patch on an isolated extension/profile, **not** a release configuration.
- Do not conflate source CI with an independently reviewed or production-validated release.

## Acceptance matrix

| Gate | Evidence | Status |
| --- | --- | --- |
| Source checks | PR #93 commit 67f38816 | PASS |
| Chrome Bridge Visual RC | PR #93 commit 67f38816 | PASS |
| Live background health | Operator's isolated lab 17481 (browser_status and control_status) | PASS, user-reported |
| Live background read | 1 permitted tab, browser_tabs and browser_read; content withheld | PASS, user-reported |
| Live denial | Invalid tab denied; poll without token 401; unapproved extension origin 403 | PASS, user-reported |
| Live server outage/recovery | Port 17481 stopped while 17381/17382 stayed reachable; later automatic reconnect and read-only commands | PASS eventually; delay unmeasured |
| Independent named reviewer ACK and signed-off verdict | Issue #94 | **PENDING** |
| Packaged extension install/rollback on disposable profile | Separate RC1 package and manual restore dry run | **PENDING** |
| Production deployment | Never performed | **BLOCKED** |

## Threat boundary and release restrictions

- Background read-only is the supported tested path. Global Control remains OFF.
- `browser_open` and `agent_new_chat` remain unsupported in background mode.
- Background mutations require distinct lab opt-in, per-tab grant, and confirmation; do **not** enable or promote this experimental flow without additional live testing.
- Browser content and agent replies are untrusted; do not log, echo, copy, or send agent/browser credentials.
- `CODEX_DISABLED` is an existing independent policy control; do not modify it to ship RC1.
- Fail closed on 401/403; do not automatically replay non-idempotent commands on an unknown acknowledgement.
- Current worker network diagnostics may log endpoint and operation, never token, authorization header, body, or original exception message.

## Preflight before local trial

1. Fetch this exact RC branch into a **new directory**; do not overwrite the production extension, config or state.
2. Keep the existing production runtime/extension on 17381/17382 untouched.
3. Confirm exact release source (worker default endpoint 17381) and which Chrome profile the candidate targets.
4. Back up the existing production extension files and their hashes separately from the live profile. Never copy or publish `config.json`, `browserToken`, `agentToken`, or browser profile data.
5. On a disposable Chrome profile, load the unpacked RC extension and verify manifest, host permissions, connection mode, and read-only limits. Never assume approval from source tests alone.
6. Confirm a definite rollback path: disable/remove candidate extension in the **disposable profile** and relaunch its previous test extension. Do not remove the production extension.

## Release gates

- At least one independent human/agent review with explicit ACK, findings, verdict and reproducible evidence on Issue #94.
- CI green on the *final RC branch commit*, not only inherited PR commits.
- Explicit confirmation that packaging includes all expected extension assets and no secrets/state files.
- Live test: closed-panel read-only, denied host permission, server kill/restart, no duplicated poll, manual stop, and restart after browser shutdown.
- Written approval before touching production; only then schedule a separately reversible deployment.

## Open risk register

1. Brief post-restart unavailability observed before server reported reachable. No latency SLA established.
2. Real-browser mutation paths are unapproved for production and deliberately not release-ready.
3. All user-reported live tests occurred against an isolated locally modified lab, not this packaged RC artifact.
4. No independent review was recorded as of this draft.

## Reviewer assignment

Issue #94: Codex — concurrency and acknowledgement; Claude — trust boundaries and permissions; Gemini — real-browser lifecycle and UX; DeepSeek — mutation controls and navigation races. An assignment is not acknowledgement or audit completion.
