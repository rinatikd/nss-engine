# AI Collaboration + Windows Control Platform — Release Gate

Status: **DRAFT / NO-GO**  
Branch: `platform/ai-windows-control-release-20261114`  
Date: 2026-11-14

## Goal and scope

Build a reusable **ChatGPT ↔ Windows ↔ AI assistant collaboration platform**, independent of NSS Engine, APS Expert, CCTV and other consuming projects. The platform should provide a permissioned direct Windows diagnostic/execution channel and verified bidirectional conversations with Claude, Gemini, DeepSeek, Grok, Qwen and Kimi. Cursor is an additional integration candidate, not declared complete. A listed tool, tab, issue comment or GitHub ACK is **not** sufficient proof of end-to-end delivery.

**Codex CLI availability and integration testing is explicitly on hold through 2026-11-27 inclusive.** No Codex CLI execution or connection probes before 2026-11-28.

## Verified baseline (2026-11-14)

| Component | Observed | Release classification |
|---|---|---|
| PowerShell Direct / Work PC | Prior execution of five pinned diagnostics with FINISHED/exitCode=0 (PowerShell 5.1.19041.2364, Node 24.21.0, .NET SDK 10.0.401, git status/diff-check in the valid repository) | READONLY DIAGNOSTICS PASS; NOT unrestricted shell |
| Chrome Bridge main | `browser_status.connected=false`, `queued=0`, remembered Claude/Gemini/DeepSeek bindings; `control_status` reports disconnected | BLOCKED |
| Chrome Bridge PR102 lab | `Tunnel-client has not been seen for 300 seconds` | BLOCKED |
| Claude, Gemini, DeepSeek | Historical tab binding, but no verified new send/ack/reply cycle | NOT VERIFIED |
| Grok, Qwen | Tabs visible via separate Browser read-only connector; controlled adapters not proven | NOT VERIFIED |
| Kimi (`https://www.kimi.ai`) | Newly requested provider; connectivity, tab binding and adapter not tested | NOT VERIFIED |
| Browser connector | Tab enumeration/read-only available; no mutation authority | READONLY ONLY |
| Codex CLI | Deferred per operator | NOT TESTED |

## Architecture boundaries

1. **Windows Control Adapter**: separate pinned read-only tasks from mutating tasks. Any command must be server-side allowlisted, workspace-canonicalized, fingerprinted, bounded, audited, with safe stdout/stderr. No arbitrary shell interpolation, nested shell, encoded commands, secret echo, or unreviewed scripts. For mutation, explicit human approval and local enforcement; never infer authorization from chat text alone.
2. **Chrome Session Adapter**: distinguish main Chrome, PR102 isolated lab, and production by an explicit instance identity, extension identity and server/tunnel identity. Never copy user profiles, cookies, bearer tokens or grants between profiles.
3. **Provider Adapters**: Claude, Gemini, DeepSeek, Grok, Qwen, Kimi through explicit tab/conversation binding and current DOM detection. Support list, bind, read/peek, preflight, send, wait, response correlation, quota/error reporting and one-click revocation. Unsupported providers must fail closed. Cursor may be scoped separately after implementation evidence.
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
- Implement and test Grok/Qwen/Kimi adapters in isolated lab; preserve provider quotas and login prompts.
- Kimi target: `https://www.kimi.ai` (verify effective canonical origin and redirects in the actual browser before adding any origin allowlist or Control grant). No existing tab binding, send/receive, or adapter validation is assumed.
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
| G3 Providers | Real per-provider send → reply with requestId/nonce correlation for Claude, Gemini, DeepSeek, Grok, Qwen, Kimi |
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

A new ChatGPT conversation can (with explicit approvals) inspect approved Windows state, target an approved Claude/Gemini/DeepSeek/Grok/Qwen/Kimi conversation, send one traceable message, receive and attribute the answer, survive disconnect/restart without duplicate dispatch, revoke access immediately, and roll back cleanly. Each capability must have evidence from the real supported environment, not merely an API declaration.


## Windows-first test execution (operator decision 2026-11-14)

GitHub Actions is **not a release prerequisite while account billing/service limitations are unresolved**. The operator has reported that GitHub disabled some services after nonpayment. The observed job failure (run 43545904449, portable job) cannot currently be attributed to source code because job logs return BlobNotFound. Classify `CI: BLOCKED / BILLING-REPORTED / ROOT-CAUSE-UNVERIFIED`; do not falsely label it a code failure or definitively prove billing from the error alone.

The local Windows PC becomes the primary testing host:
- New standalone prototype `tools/ai_collaboration/local_test_runner.mjs` supports extensible named suites (`platform-contract`, `platform-node`, `nss-portable`) rather than the original five read-only version/status operations.
- `tools/ai_collaboration/local_test_runner.test.mjs` covers approval binding, exact workspace, symlink rejection, command plan validation, shell-free execution and bounded output.
- Runner is **not yet connected to the deployed PowerShell Direct MCP endpoint**. A GitHub commit or passing Node unit tests cannot alter the deployed tool schema. Integration requires a reviewed Windows service-side MCP action, local deployment, discovery/refresh and real Windows tests.
- Approval is mandatory for each execution request. Persist one-shot requestId/command fingerprint before spawning, enforce exclusive execution, timeout and process-tree cleanup, redact output and maintain durable audit logs. A stale/UNKNOWN dispatch must not replay automatically.
- A test suite can create caches/build outputs; running tests is not necessarily read-only. Scope write permissions to an approved isolated worktree/artifact directory. No arbitrary host-level PowerShell or remote scripts without distinct explicit approval.
- For real Windows acceptance, record exact source SHA, suite, exit code, elapsed time, sanitized stdout/stderr, OS and environment, artifacts and SHA256. Verify by running `node --test tools/ai_collaboration/local_test_runner.test.mjs` and `python -m unittest discover -s tools/ai_collaboration -p 'test_*.py' -v` in a locally approved isolated checkout.

Codex CLI availability and integration checks remain deferred through 2026-11-27.


## Main baseline synchronization checkpoint — 2026-11-26

The common repository baseline advanced after CCTV Release 2 was merged:

- Current main commit: `5bb86dff8f8a50483956fac5237d1f6942926855` (merge of PR #150).
- PR #110 source head at this checkpoint: `674e1fad2b64910b470222c5f17c87cd1df4e8eb`.
- GitHub's current PR merge candidate: `918c740b4dd9b17cac843706e04a327ab79ac140`, which compares as 513 commits ahead / 0 behind current main.
- The exact merged tree was inspected at that merge-candidate SHA. `work/NSS_TKK_Editor_v0.2/modules/cctv/test_cctv_core.py` contains the corrected assertion `Observe, м: 23.0`; the old branch-head file still contains the superseded dictionary-style expectation.
- The older Source checks run #45452312461 failed on the pre-PR150 merge baseline and is historical, not proof that the current PR merge candidate still fails.
- PR #110's Source checks use the default pull-request checkout, which resolves the merge candidate. A new branch commit is being added to trigger fresh CI against this current main merge baseline; do not promote the gate until those exact runs complete.

No merge of PR #110, deployment, Production change or local Windows mutation is performed by this synchronization checkpoint.
