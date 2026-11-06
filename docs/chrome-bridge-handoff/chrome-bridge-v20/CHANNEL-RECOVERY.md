# Chrome Bridge — real bidirectional channel recovery

**State: BLOCKED / NOT CONNECTED from this ChatGPT session (2026-11-06).** This is an observation, not a claim that the Windows server is down.

## Separating the three independent channels

| Channel | Verified here | What it proves |
| --- | --- | --- |
| GitHub connector | Read/write issues and PRs work | Coordinator can publish requests and observe GitHub comments, **not** that any assistant received a task |
| Installed ChatGPT Chrome Bridge MCP connector | `browser_status`, `agent_list`, and read-only `codex_submit` probes returned tool-internal failure | This ChatGPT session has **not** obtained a working MCP response; cause not yet identified (network/authorization/origin/tool routing) |
| Browser tab tool | Returned `Browser access requires the originating browser context. Open ChatGPT in the browser with the connected extension and try again.` | The alternate browser tool explicitly requires an originating connected browser context absent from the current session |

A different **isolated local Chrome Bridge lab** passed `127.0.0.1:17481` CORS and token authentication, real background UI reconnect and grant/revoke smoke checks. This **does not imply** the installed ChatGPT MCP connector to the production Bridge at `17381/17382` works or can see the isolated browser profile.

## Missing prerequisites for an authenticated two-way pilot

1. Confirm the currently executing ChatGPT session is bound to the **same authorized browser/Bridge connector** as the running bridge instance. A background status in an isolated Chrome profile alone does not establish the app connector's request path.
2. Read-only query `browser_status`, then `agent_list` with a concrete non-error response from that exact connector. No authority escalation is needed.
3. Validate a destination assistant is *actually running* and authenticated; on GitHub, require an independently attributable ACK, not coordinator's own comment or an unverified text marker.
4. Make a **single**, non-sensitive, explicitly approved provider request; record correlation ID, provider invocation/ACK, exact reply and GitHub readback. Unknown send outcome must not be retried.
5. Codex local execution remains separately gated; do not bypass disabled policy simply to prove transport.

## Safe Windows-side read-only evidence (when the authorized Windows machine is accessible)

Use `Get-NetTCPConnection -State Listen -LocalPort 17381,17382` and `Get-CimInstance Win32_Process` to identify owning PIDs (do not print raw command lines or credentials). On the connected client, run the MCP `browser_status` tool and collect only sanitized error category and timing. Distinguish production connector server from disposable lab `17481`.

## Delivery protocol / fail-closed requirements

`REQUESTED -> RECEIVED_VERIFIED -> ACKED -> RESPONSE_VERIFIED`, with separately recorded `BLOCKED`, `UNKNOWN` and `TIMED_OUT`. Never advance to `RECEIVED_VERIFIED` on GitHub comment creation alone. Correlate request ID, target agent, authenticated sender identity, code commit, timestamp and hash; disallow automatic resubmission after UNKNOWN. GitHub comments remain an audit trail, not a provider invocation.

## Next implementation tasks

- Surface the **specific MCP failure category** (transport unavailable / auth / session origin / server denial) without leaking token, tunnel, device address or any request payload. Generic `tool failed internally` is insufficient for incident closure.
- Run the narrow read-only browser status and agent inventory from an authorized browser-originating session if that environment becomes available; do not silently substitute a different test browser.
- Provide actual receiver ACK and verified reply for a single non-mutating test; stop otherwise.
- Keep live server `17381/17382`, tunnel, credentials, installation and production Chrome profile unchanged. All code changes require separate review and rollout.

**Release and channel verdict: BLOCKED.** Lab UI works, but ChatGPT-to-helper delivery cannot be claimed until its actual transport and recipient independently respond.

## Isolated MCP server test (2026-11-06)

New `tests/mcp-channel-smoke.test.mjs` launches the repository's `createBridge` on an ephemeral 127.0.0.1 port using synthetic agent/browser tokens. It verifies `initialize`, `ping`, `tools/list`, **`browser_status` with no connected browser**, and a structured `agent_list` disconnection error. Invalid agent token, browser token presented as agent token, unauthorized extension Origin and wrong pinned extension ID must be rejected with 401/403.

GitHub Actions commit `413ae0126c11367a68b77d3ce0fe73227f69ead5`: **Source checks PASS; Chrome Bridge Visual RC PASS; RC1 Control Gates PASS**, with the new smoke test explicitly included in Visual RC. This provides evidence the *repository MCP server handler works in an isolated CI process*. It does **not** test the user's active Windows server, tunnel, ChatGPT plugin routing or credentials. Consequently, internal tool failure in this ChatGPT session remains a **connector/session/upstream failure of unknown precise cause**, not a verified defect in the server implementation.

Next real test must obtain a non-sensitive status from the actual **ChatGPT-connected** MCP instance or a sanitized HTTP status and process health from that same production endpoint. Do not use lab `17481` evidence to certify the `17381/17382` connector.
