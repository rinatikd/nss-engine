# Chrome Bridge — main Chrome enrollment (Issue #105, Stage 2)

Status: **Draft / source only; NOT installed or E2E approved.** Current PR102 test lab on 17484 and RC1/production must remain untouched.

## Threat model and operational boundary

The Browser connector can read existing main-Chrome Claude/Grok tabs, but has no write capability. The separate **PR102 Lab** MCP connector controls a different, isolated Chrome profile. Connecting a new tunnel does not magically attach to main Chrome or transfer browser identities.

For the main profile, use **a separately installed extension and independently provisioned bridge server**, with its own state directory, server port, browser token, extension ID and (when needed) its own OpenAI tunnel / ChatGPT plugin. **Never reuse PR102's browser token/state directory or silently take control of main Chrome.** Do not read/copy cookies, browser profiles, or existing passwords.

This phase provides **only read-only user-consented access** for individual tabs. UI changes and future send actions are separately reviewed in Stage 3.

## New permission workflow

1. In the local extension control window, add `https://claude.ai` and `https://grok.com` as `ИИ-чат` sites using their respective adapters. New sites have `selectedTabOnly: true` and must obtain Chrome's host permission as before.
2. Click **Найти вкладки**. This enumerates eligible existing main-Chrome tabs **locally in the extension UI** and does **not** publish unapproved tabs through MCP.
3. Select the *exact* conversation and click **Разрешить чтение вкладки на 60 минут**. Confirm the displayed full URL. Consent is stored in trusted **`chrome.storage.session`**, scoped by tab ID, exact URL, origin and expiry.
4. Only after granting will remote `browser_tabs`, `browser_read` and agent diagnostics see that tab. Tab navigation (even same-origin conversation change), tab replacement, expiry, site revocation, or explicit **Отозвать чтение вкладки** must block future remote reads.
5. **Отозвать все сайты** also clears selected-tab read grants. No silent re-grant after browser restart. Do not issue `agent_send`, `browser_click`, `browser_fill` or `agent_new_chat` merely because read was granted; these remain separate per-action control approvals and Grok stays *discovery-only*.

## Known limits

- The existing installed main Chrome may already have a different Chrome Bridge version/configuration. This PR does not install, replace, or upgrade it.
- This code assumes the selected main-profile extension already has its own isolated backend and MCP tunnel. Main-profile bridge provisioning (port, extension ID, state, key issuance and extension packaging) must be validated independently before E2E.
- `grok` remains a discovery-only candidate: `agent_context` can identify `/c/<conversationId>`; `agent_peek` requires verified answer selectors. Current default `reply` selector is empty and cannot claim reliable Grok response extraction.
- No workaround for free-tier quotas, CAPTCHA, login restrictions or provider terms is permitted.
- No authenticated, user-confirmed Grok send has been demonstrated.

## Release gate checklist (all must pass)

- `node --test tests/grok-readonly.test.mjs tests/selected-read-tabs.test.mjs` in a fresh checkout, plus existing regression suite; record Node version, exit code, exact commit.
- Independent main-profile Chrome attach in a clean staging server; prove cross-profile separation using distinct extension IDs / tokens and denied access from the PR102 lab.
- Fresh local site grant and exact-URL tab enrollment; unauthorised tab remains absent from `browser_tabs`.
- Read Claude and Grok, verify agent-context conversation IDs, expiry, revoke, mid-read navigation, browser restart and owner disconnect.
- Human **Deny** and **Approve** flows, session cancellation, write de-duplication, no-send-on-revocation, recovery and rollback (Stage 3).
- Document secrets redaction and evidence in GitHub PR #106 and issue #105. Mark NO-GO until all release-blocking items pass.
