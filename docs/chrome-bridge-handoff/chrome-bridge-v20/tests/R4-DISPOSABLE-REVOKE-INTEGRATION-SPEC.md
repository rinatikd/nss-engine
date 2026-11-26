# R4 Disposable Chrome Revoke Integration — Test Specification

**Status:** FULL HARNESS NOT IMPLEMENTED — preliminary provider-origin permission gate added in PR #176; CI result pending  
**Target under test:** Chrome Bridge R4 PR #174, base snapshot `a099f86a9af4952c04b9c585864febd9c5244902`  
**Isolation:** Disposable extension copy, disposable MCP server, disposable Chrome profile, supported provider origin `https://claude.ai` resolved to loopback only inside that Chrome process.  
**Production and operator Lab:** MUST NOT be modified or used by this test.

## 1. Purpose

Prove the combined runtime behavior that unit tests cannot currently establish:

- a real MV3 background service worker routes MCP commands to the real coordinator;
- the real `ApprovalSession` / `ApprovalBroker` cancellation path settles pending approvals;
- the real mutation dispatcher does not execute `provider_prepare` after a tab or global Revoke;
- a late asynchronous preflight cannot register a new approval after Revoke;
- worker restart does not resurrect revoked grants or permit a stale mutation.

The existing `mv3-background-lifecycle.test.mjs` is a useful harness pattern (disposable profile, unpacked extension, CDP, offscreen transport, temporary bridge port), but it tests Stop/lifecycle and does **not** prove the combined Revoke + pending Approval path.

## 2. Hard isolation requirements

1. Create all files under a unique OS temporary directory. Never copy test changes back to the checked-out extension or production installation.
2. Use a unique temporary Chrome user-data directory and a unique free loopback MCP port.
3. Start a separate MCP bridge instance with a temporary state directory, temporary provider journal, temporary agent registry, and test-only credentials.
4. Use the already-supported exact provider origin `https://claude.ai` for the fixture, but map `claude.ai` to `127.0.0.1` only inside the disposable Chrome process with `--host-resolver-rules=MAP claude.ai 127.0.0.1`. The fixture must not contact the real provider.
5. Bind the temporary HTTPS provider server to loopback port 443 so the browser URL remains exactly `https://claude.ai`. Do not use a non-default HTTPS port: `URL.origin` includes that port and the existing origin maps use exact origin keys. If the CI runner cannot bind port 443 safely, stop and redesign the fixture rather than changing production origin validation.
6. Do not patch `permissions.js`, `page.js`, `tools.mjs`, `bridge.mjs`, or `provider-journal.mjs` to introduce a synthetic provider. Use the existing `claude` provider identity and supported `/chat/<conversation-id>` route.
7. Do not weaken origin, HTTPS, grant, approval, epoch, payload-hash, journal, or sender validation. The fixture must pass the same checks as a supported provider.
8. The local HTTPS certificate must be confined to the disposable run. If certificate verification is bypassed, the bypass must be a flag on the disposable Chrome process only; never change system trust stores.
9. Test cleanup must terminate only child processes started by this test and remove only its own temporary directory. Cleanup must run in `finally`, including assertion failures and timeouts.

## 3. Source-level constraints discovered

The fixture must account for all of the following, not just the extension's top-level origin list:

- `read-only-dispatch.js:permittedTab()` requires HTTPS, a matching `storage.local.sites[origin]` entry, and Chrome host permission. It rejects loopback hostnames.
- `read-only-dispatch.js` permits agent context only when the origin exists in `CONTROL_ORIGINS`, `site.mode === 'chat'`, and `site.adapter === CONTROL_ORIGINS[origin]`; adapter origin must match.
- `background-control-grants.js` requires a local gesture, a supported duration (15 or 60 minutes), a permitted tab, and matching chat site/adapter. The test must obtain grants through the actual control UI/local gesture path, not by directly writing a grant record.
- The supported Claude origin is already present in all relevant allowlists: extension `permissions.js`, `page.js`, MCP `tools.mjs`, `bridge.mjs`, and `provider-journal.mjs`. Keep those production files unchanged.
- `page.js:pageAction()` recognizes Claude conversation routes under `/chat/<id>`; use a stable ID matching `[A-Za-z0-9_-]{8,160}` and the existing Claude adapter DOM selectors.
- `server/tools.mjs` validates `providerOrigin=https://claude.ai` and `providerId=claude`.
- `server/bridge.mjs` requires the provider tab to be bound to an agent entry through `agent_bind({name, tabId})`.
- `server/provider-journal.mjs:validateProviderIdentity()` independently validates the same origin-to-provider mapping. Keep the full identity tuple (requestId, taskId, providerId, tabId, origin, conversationId, epoch) consistent.
- `provider_prepare` must be exercised through the MCP tool route, including the real server queue and extension dispatch. Calling `pageAction()` directly is not an integration test.

### Permission-pattern compatibility gate

**Preliminary gate in PR #176:** a disposable Chrome test now maps the exact supported host `claude.ai` to loopback, declares `https://claude.ai/*` in the temporary extension manifest, and exercises the production `permittedTab()` and `BackgroundControlGrants` modules. This avoids non-default ports entirely. Its GitHub Actions result is pending; it must pass before the full fixture proceeds.

The preliminary test calls the grant class with `localGesture:true` directly. It verifies origin matching and grant-store behavior, but **does not** verify the real control UI event path or a browser-generated trusted gesture. The full scenarios must obtain Grants through the actual local UI.

The full fixture must bind its temporary HTTPS server to loopback port 443 so the browser URL remains exactly `https://claude.ai`. Do not silently use a non-default port: `URL.origin` includes that port, while the provider allowlists use exact origin keys.

## 4. Disposable runtime topology

```text
Node test process
  ├─ temporary HTTPS provider server (127.0.0.1:443; exposed as https://claude.ai only inside disposable Chrome)
  │    ├─ /chat/<stable-conversation-id> for tab A
  │    └─ /chat/<stable-conversation-id> for tab B
  ├─ disposable MCP Bridge (unique loopback port + temp state/journal)
  └─ disposable Chrome (unique profile)
       ├─ real MV3 background service worker
       ├─ real offscreen transport-host
       ├─ real transport-worker
       ├─ real background-coordinator
       ├─ real ApprovalSession / ApprovalBroker
       ├─ real mutation-dispatch
       ├─ control.html (real local approval UI)
       ├─ provider tab A
       └─ provider tab B
```

Only the provider website content and adapter DOM are synthetic; the origin and provider identity remain the existing supported Claude identity. Do not stub or replace the coordinator, approval classes, mutation dispatcher, grant store, transport worker, offscreen host, or MCP command queue.

## 5. Required scenarios and assertions

### A. Per-tab Revoke cancels only the target tab's approval

1. Start disposable MCP + Chrome and wait for the real worker/offscreen connection.
2. Open two provider tabs A and B on the same isolated `https://claude.ai` origin, each with a valid conversation route.
3. Configure the temporary site's adapter and host permission; verify both tabs appear in `browser_tabs`.
4. Obtain separate per-tab Grants through the real control UI.
5. Bind A and B to separate MCP agent names using the actual MCP tool `agent_bind({name, tabId})`; the server's `provider_prepare` handler rejects tabs that are not present in its agent registry.
6. Start a `provider_prepare` for A and hold its Approval pending using the actual approval UI/session. The MCP schema requires the complete identity tuple plus `message` and SHA-256 `payloadHash`; the server accepts either an active owner-approved Session Authorization lease or the legacy explicit one-action approval path.
7. Start a `provider_prepare` for B and hold its Approval pending as well.
8. Invoke per-tab Revoke for A through the real control UI.
9. Assert:
   - A's pending approval is removed and its waiter settles as cancelled/blocked;
   - B's pending approval remains pending;
   - no `provider_prepare` page action was executed for A;
   - A's Grant is gone and B's Grant remains effective;
   - the per-tab mutation lane drains without waiting for approval timeout;
   - the final outcome is not `UNKNOWN` and no quarantine is created for a cleanly cancelled pre-dispatch action.

### B. Global Revoke cancels all pending approvals

1. Re-establish fresh Grants and pending approvals for A and B. Ensure the test has a valid Session Authorization context if using the session path; otherwise exercise the legacy one-action approval path consistently.
2. Invoke `session_revoke` through the real MCP tool route (and separately test the UI clear-all path if it has distinct semantics).
3. Assert:
   - both pending approvals are cancelled before mutation-lane drain completes;
   - neither provider page action executes;
   - all Grants are cleared;
   - the global revocation fence is persisted and reconciled;
   - no stale pending approval survives worker restart.

### C. Late-approval race during asynchronous preflight

1. Configure a deterministic test hook in the disposable provider page or test transport to pause `agent_context`/preflight before the approval request point. The hook must not replace the coordinator or mutation dispatcher.
2. Start `provider_prepare` for A and wait until preflight is demonstrably paused.
3. Invoke per-tab Revoke A. Confirm the in-memory fence is active before releasing the hook.
4. Release preflight.
5. Assert:
   - the guarded approval request re-checks admission and is rejected;
   - no approval is inserted into the broker;
   - no provider page action runs;
   - the mutation result is classified as `BLOCKED` (not generic `NOT_PERFORMED` or `UNKNOWN`);
   - Revoke completes and A remains without a Grant.

### D. Worker restart and stale-state recovery

1. Start a fresh mutation/approval lifecycle and Revoke the target tab.
2. Terminate/restart only the disposable extension worker using the supported Chrome lifecycle/CDP mechanism.
3. Assert after worker recovery:
   - revoked Grants do not reappear;
   - a stale dispatch using the old epoch/identity is rejected;
   - no provider page action runs;
   - any pending revocation fence is handled fail-closed;
   - if durable state cannot establish a safe outcome, the system reports quarantine/UNKNOWN rather than claiming success.

## 6. Evidence captured per scenario

Record structured, redacted evidence:

- Chrome version and extension build SHA;
- disposable profile and server port identifiers (not tokens);
- worker/offscreen target readiness and reconnect events;
- tab IDs, fixture origin `https://claude.ai`, conversation IDs;
- Grant status before/after;
- approval IDs/counts before/after;
- mutation outcome state and reason code;
- provider page-action execution counter;
- revocation fence storage state (local/session) and worker restart outcome;
- test duration and cleanup result.

Never log bearer tokens, browser tokens, approval secrets, message contents, or provider journal key material.

## 7. CI integration gate

Do not add the test to required CI until:

1. the fixture passes locally or in a dedicated disposable CI job;
2. all scenarios A-D pass repeatedly (at least 10 consecutive runs for race-sensitive scenario C);
3. process cleanup is verified after forced test failure;
4. the job uses its own temporary port/profile and does not rely on a developer's Chrome;
5. the test is clearly labelled as a disposable integration test and cannot address production endpoints;
6. CI failure produces diagnostics without exposing secrets.

The existing Visual RC job may host this test only after its current lifecycle test setup is understood and the new job's resource/time limits are validated.

## 8. Explicit non-goals

This test does not implement durable provider mutation journaling or operator quarantine recovery. It does not prove behavior on a user's persistent Chrome profile or on Production. It does not replace the separate Windows/Chrome operator acceptance run.

## 9. Implementation checklist

- [ ] Locate and reuse the current disposable MV3 lifecycle harness helpers without importing test-only stubs into production code.
- [ ] Confirm the PR #176 exact-origin permission gate passes in disposable Chrome.
- [ ] Add a temporary HTTPS server bound to loopback port 443 and its disposable certificate lifecycle.
- [ ] Keep all provider allowlists and provider identity maps unchanged; use `claude`.
- [ ] Exercise the real control UI so the Grant is issued only after an actual local trusted gesture.
- [ ] Configure the disposable site's adapter and permission state.
- [ ] Exercise the real local Grant UI.
- [ ] Bind both tabs through the real MCP agent binding path.
- [ ] Implement scenarios A-D.
- [ ] Add redacted evidence output and deterministic cleanup.
- [ ] Run repeated race tests.
- [ ] Add to a dedicated CI job only after local/runtime acceptance.
