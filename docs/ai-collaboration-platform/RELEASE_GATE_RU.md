# AI Collaboration + Windows Control Platform — Release Gate

Status: **DRAFT / NO-GO**  
Branch: `platform/ai-windows-control-release-20261114`  
Date: 2026-11-14

## Goal and scope

Build a reusable **ChatGPT ↔ Windows ↔ AI assistant collaboration platform**, independent of NSS Engine, APS Expert, CCTV and other consuming projects. The platform should provide a permissioned direct Windows diagnostic/execution channel and verified bidirectional conversations with Claude, Gemini, DeepSeek, Grok and Qwen. Cursor is an additional integration candidate, not declared complete. A listed tool, tab, issue comment or GitHub ACK is **not** sufficient proof of end-to-end delivery.

**Codex CLI availability and integration testing is explicitly on hold through 2026-11-27 inclusive.** No Codex CLI execution or connection probes before 2026-11-28.

## Verified baseline (2026-11-14)

| Component | Observed | Release classification |
|---|---|---|
| PowerShell Direct / Work PC | Prior execution of five pinned diagnostics with FINISHED/exitCode=0 (PowerShell 5.1.19041.2364, Node 24.21.0, .NET SDK 10.0.401, git status/diff-check in the valid repository) | READONLY DIAGNOSTICS PASS; NOT unrestricted shell |
| Chrome Bridge main | `browser_status.connected=false`, `queued=0`, remembered Claude/Gemini/DeepSeek bindings; `control_status` reports disconnected | BLOCKED |
| Chrome Bridge PR102 lab | `Tunnel-client has not been seen for 300 seconds` | BLOCKED |
| Claude, Gemini, DeepSeek | Historical tab binding, but no verified new send/ack/reply cycle | NOT VERIFIED |
| Grok, Qwen | Tabs visible via separate Browser read-only connector; controlled adapters not proven | NOT VERIFIED |
| Browser connector | Tab enumeration/read-only available; no mutation authority | READONLY ONLY |
| Codex CLI | Deferred per operator | NOT TESTED |

## Architecture boundaries

1. **Windows Control Adapter**: separate pinned read-only tasks from mutating tasks. Any command must be server-side allowlisted, workspace-canonicalized, fingerprinted, bounded, audited, with safe stdout/stderr. No arbitrary shell interpolation, nested shell, encoded commands, secret echo, or unreviewed scripts. For mutation, explicit human approval and local enforcement; never infer authorization from chat text alone.
2. **Chrome Session Adapter**: distinguish main Chrome, PR102 isolated lab, and production by an explicit instance identity, extension identity and server/tunnel identity. Never copy user profiles, cookies, bearer tokens or grants between profiles.
3. **Provider Adapters**: Claude, Gemini, DeepSeek, Grok, Qwen through explicit tab/conversation binding and current DOM detection. Support list, bind, read/peek, preflight, send, wait, response correlation, quota/error reporting and one-click revocation. Unsupported providers must fail closed. Cursor may be scoped separately after implementation evidence.
4. **Task Envelope**: immutable requestId, provider, profile, tabId, origin, canonical URL/conversation identity, payload hash, operation type, approval status, expiry and delivery status. Distinguish CREATED, APPROVAL_PENDING, DENIED, DISPATCH_UNKNOWN, SENT_CONFIRMED, REPLY_RECEIVED, FAILED, EXPIRED and REVOKED. An ambiguous send must **never** be automatically resubmitted.
5. **Coordinator**: dispatch only after the specific human-granted scope; record both transport and page evidence. Pull replies via read-only access, attach original requestId and evidence, then create downstream tasks only within approved permissions. GitHub is a durable work queue, not proof of agent identity.

## Work packages and order

### W1 — Restore, diagnose, isolate
- Recheck main `browser_status`, `control_status`, `agent_list` and tab identity after operator reconnect; no silent regrant.
- Restore PR102 lab tunnel separately, without changing production 17381/17382 or reusing credentials.
- Add bounded allowlisted `lab-port-status` and `lab-log-summary` Windows diagnostics only after independent review and explicit approval. Avoid free-form PowerShell.
- Capture sanitized baseline: extension/server versions, instance IDs, relevant ports and connection state; omit tokens.

### W2 — Bind providers correctly
- Validate Claude/Gemini/DeepSeek bindings against exact live tab ID, URL origin and conversation ID.
- Implement and test Grok/Qwen adapters in isolated lab; preserve provider quotas and login prompts.
- Fix missing/changed composer, send, reply and stop selectors with fixture tests and real-Chrome evidence.
- The Browser read-only connector does not authorize control or imply Chrome Bridge connectivity.

### W3 — Real bidirectional E2E
Per provider: explicit positive grant, unique nonce and requestId, send exactly once, transport evidence, page send evidence, complete response, nonce correlation, then revoke. Run DENY before ALLOW. Separate failures: unsupported adapter, UI selector, permission denial, timeout, quota, disconnected, unknown dispatch. No false PASS from mocks or a visible composer. Never ask an assistant to bypass policies, CAPTCHA or rate limits.

### W4 — Recovery and security
- DENY, expiry, revoke during pending send, origin/tab switch, browser restart, service-worker suspension, tunnel loss and recovery.
- Race/replay/duplicate prevention across restart, server interruption, profile confusion and lost acknowledgement.
- Operator-owned lab cleanup only; rollback evidence that production remains unchanged.
- Full audit logs with redaction and explicit evidence IDs; no tokens/private chat contents in public GitHub.

### W5 — Production candidate
- Independent security review + full CI/unit/integration + OS-backed E2E.
- Reproducible package, SHA256 manifest, versioned install/upgrade/rollback and operator manual.
- Only after independent signoff and explicit operator cutover authorization; remain NO-GO beforehand.

## Required evidence for release

| Gate | Must have |
|---|---|
| G1 Windows | Five pinned diagnostics PASS; additional allowlisted tasks audited; mutation approval DENY/ALLOW/replay verified |
| G2 Chrome | Main and isolated lab connections PASS independently; no cross-profile state or production changes |
| G3 Providers | Real per-provider send → reply with requestId/nonce correlation for Claude, Gemini, DeepSeek, Grok, Qwen |
| G4 Safety | Revocation, expiry, origin switch, crash, restart, UNKNOWN-no-retry and credential redaction PASS |
| G5 Packaging | Signed or checksummed reproducible artifact, installation and rollback instructions, logs |
| G6 Acceptance | Operator Windows test evidence, independent review, explicit GO decision |

Missing evidence = **BLOCKED/NOT RUN**, not PASS. Publish per-test date, environment, exact executable revision and outcome.

## Existing work to integrate (not blindly merge)

- Issues #105 (main Chrome attach + Grok), #107 (PowerShell Direct), #104 (IPC recovery), #87 (release gate), #89 (adapter/selector blocker), #54 (NSS regression — separate consumer work).
- Existing PR/branches must be reviewed for head SHA, security boundaries, CI and conflicts before selective cherry-picking. This branch does not overwrite their history.
- Project-specific code stays in its own modules; no dependency on NSS engineering logic for generic platform operations.

## Operator approval boundaries

No production restart, port change, tunnel change, credential use/rotation, browser grant, local Windows mutation or message sending to AI providers without appropriate explicit human approval. Read-only diagnostics only in sanctioned scopes. Do not persist personal chat content, private drawings, or credentials in Git.

## Definition of done

A new ChatGPT conversation can (with explicit approvals) inspect approved Windows state, target an approved Claude/Gemini/DeepSeek/Grok/Qwen conversation, send one traceable message, receive and attribute the answer, survive disconnect/restart without duplicate dispatch, revoke access immediately, and roll back cleanly. Each capability must have evidence from the real supported environment, not merely an API declaration.
