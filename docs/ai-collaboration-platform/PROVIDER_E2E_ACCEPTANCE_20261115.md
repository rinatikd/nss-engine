# AI provider integration acceptance — PR #110

Date: 2026-11-15. Evidence: live connector calls from ChatGPT and PR inspection. Scope: **Grok, Claude, Gemini, Kimi, DeepSeek** (no implied provider E2E success).

## Measured environment

| Environment | Result | Evidence / next gate |
|---|---|---|
| PowerShell Direct Work PC | PASS for bounded diagnostics and engineering approval | After ACK cutover, real node-version FINISHED/exitCode 0; original DENIED remains DENIED; duplicate submit returns SUBMISSION_RECEIVED_STATUS_UNCONFIRMED |
| Main Chrome Bridge | BLOCKED | browser_status connected=false, queued=0; remembered claude/gemini/deepseek tab IDs cannot be trusted while disconnected |
| PR102 Lab Bridge | CONNECTED, browser E2E NOT PASSED | browser_status connected=true; control_status globalEnabled=true, origins=[] (no origin grants); separate isolated profile |
| Local Workbench | BOARD ONLY | status execEnabled=false, providersConnected=[]; task creation is not dispatch |
| GitHub PR #110 | Draft; mergeable but NO-GO for whole platform | 84 changed files, 242 commits, zero review submissions, no combined-status entries; Windows direct component separately GO |

## Provider acceptance matrix

| Provider | Current evidence | Blocker | Required next step |
|---|---|---|---|
| Claude | Lab tab bound at `https://claude.ai/new` (2026-11-15 18:48 +05); previous `/login` observation is superseded | First-chat bootstrap and real send/ACK/reply unverified; `/new` alone does not prove authorization | Read-only composer preflight, then separately approved unique-request E2E after paired staging |
| Gemini | Lab tab bound on gemini.google.com/app; composer matched 1 visible; send matched 0 **while the composer was empty**; no replies present | No per-origin grant; send-button visibility after text entry has not been tested, so do not classify missing send button in an empty composer as an adapter defect | After local approval, enter harmless test text WITHOUT sending; inspect whether the send control appears/enables. Only treat it as an adapter issue if that state is not recognized; then perform separately approved send/reply E2E |
| DeepSeek | PR102 Lab bound tab at `https://chat.deepseek.com/sign_in` (2026-11-15 18:48 +05) | Authentication required; binding does not imply authenticated chat | Operator-only official sign-in, then read-only adapter preflight and per-origin grant |
| Grok | PR102 Lab bound tab at `https://grok.com/` (2026-11-15 18:48 +05) | Live send capability, provider-specific DOM adapter and authorization remain unverified; binding is not E2E | Review exact-origin policy and isolated preflight before any operator-approved send |
| Kimi | No tab binding in connected PR102 Lab; current installed browser-control allowlist does not include kimi.ai | Provider not enabled in adapter + origin policy | Implement/review explicit kimi.ai adapter and policy; isolated lab auth, selectors, send/reply proof |

## Authentication policy: Google account first

- For Grok, Claude, Gemini, Kimi and DeepSeek **prefer the provider's official “Continue with Google / Sign in with Google”** wherever that sign-in method is actually offered. Do not assume every provider supports Google OAuth in every region or session; record unsupported options and request an explicit alternative rather than silently switching methods.
- Login, Google account selection, MFA, captcha and consent are performed by the operator in that provider's own website. ChatGPT/Bridge never requests passwords, recovery codes, OAuth tokens or cookies, does not bypass interactive checks, and never transfers authentication material between the main Chrome profile and an isolated lab profile.
- Google sign-in is an authentication choice, **not** a blanket Chrome Bridge Control grant or permission to send messages. Each provider still requires explicit per-origin authorization for automation.

## Conditional send control rule

- Many AI chat websites display or enable Send **only after nonempty text is entered**. A `send matched=0` report for an empty composer is an incomplete preflight result, not evidence of a broken selector.
- First inspect composer without mutation; after the operator permits the relevant site, type innocuous test text *without submitting it*, then recheck Send visibility/enabled state. If visible, continue to a separately approved send test; if absent, diagnose DOM/selector and login state. Do not press Enter, click send, or dispatch messages during a selector-only preflight.

## Gated E2E protocol (each of five, not inferred from any other)

1. Inspect exact browser instance, profile/extension identity, connected tab, URL origin and operator login state. No copying cookies, bearer tokens or browser grants between Main and Lab.
2. Validate provider-specific editable composer and answer markers read-only. Remember Send may appear only after typing; with operator approval prefill a harmless unsent test string and re-evaluate the button. Gate blocks only when the required selector fails under the proper input/authenticated state.
3. Operator explicitly enables the specific site's Control grant locally; no global-only inferred permission, no automatic grant.
4. Submit benign unique `requestId` challenge to one provider, record local approval, delivery outcome, and obtain a matching response. `UNKNOWN` means inspect existing chat, **never automatically retry**.
5. Ask one follow-up tied to same conversation; verify correlated reply.
6. Exercise explicit DENY, grant revocation, disconnect, reconnect and duplicate requestId. Confirm no unexpected command or message after denial/expiration/reconnect.
7. Keep a sanitized evidence log: provider, origin, tab ID, requestId, state, outcome, test timestamp, stable response correlation, and limitations. No secrets or chat content unrelated to test.

## Release decisions

- Windows bounded Engineering MCP: separately **PASS**; do not interpret as arbitrary OS control or unrestricted Workbench execution.
- Five-provider browser messaging: **NO-GO** until all five have actual send/ack/reply with per-origin approval.
- PR #110 remains DRAFT: review submissions empty; combined commit status entries empty (not proof that all CI succeeded). Review code + check required CI, preserve separation of production and PR102 lab.
- Existing PR description and some runbooks describe an older 2026-11-14 baseline. Update status claims to distinguish new verified PowerShell Direct cutover from unverified provider integration.
- Codex CLI remains explicitly out of scope through 2026-11-27 under RELEASE_GATE_RU.md; do not probe it.


## Live autonomous checkpoint — 2026-11-15

All items here are direct read-only connector observations or repository inspection. No operator approval was solicited, no AI message submitted, and no Windows process restarted.

- **PR102 Lab**: `browser_status.connected=true`, `queued=0`; Claude and Gemini tab bindings are alive, with stable URLs `claude.ai/new` and `gemini.google.com/app`. `control_status` reports `globalEnabled=true`, `scope=permitted-web-tabs`, `origins=[]` (do not mistake the legacy origin list for a missing One-Click grant).
- **Claude**: authenticated session indicated by `/new` and visible ProseMirror composer; send selector matches one visible control, disabled on empty composer. No correlated sent/reply evidence. Deployed extension still lacks unverified PR113 first-chat bootstrap, so `SEND_CONTEXT_UNAVAILABLE` remains the previously proven send blocker.
- **Gemini**: composer visible, send selector matches zero on *empty* composer (expected conditional-button behavior). No draft-prefill or send test was attempted. No selector failure claim.
- **DeepSeek, Grok, Kimi**: observed in another browser tab set (main Chrome context) but **not bound to connected PR102 Lab**. Main Chrome tabs cannot be treated as lab authorization or live agent channel. Lab browser adapter/origin support is still absent for Grok and Kimi.
- **Workbench**: `execEnabled=false`, `providersConnected=[]`; only local task board available.
- **Assistant coordination via GitHub**: fetched comments on issues #83–86; each currently contains only comments attributed to repository owner, without distinguishable assistant ACK/review. Do not call those comments proof of actual assistant delivery or independent review.
- **PR113**: head `e3282f6`, draft and mergeable. Bootstrap source committed but no installed Windows test evidence, no paired extension/server staging, and no provider E2E.
- **PR110**: head includes fixed `git-branch`, `git-log`, `chrome-lab-ports` tasks; only source changes, not deployed. The existing five direct read-only tasks still form the installed allowlist until operator-approved service deployment.
- No Codex execution until the previously agreed exclusion date.

**Gate remains NO-GO for five-provider authenticated send/ACK/reply**, regardless of successful lab session and DOM probes.

## Read-only reconciliation — 2026-11-15 18:48 Asia/Almaty

- Main Chrome Bridge: `connected=false`, `queued=0`; remembered bindings are not live transport evidence.
- PR102 Lab: `connected=true`, `queued=0`, `globalEnabled=true`, `approvalPending=0`, `origins=[]`. Do **not** infer site-specific authorization from globalEnabled.
- Bound lab tabs: Claude `/new`, Gemini `/app`, DeepSeek `/sign_in`, Grok `/`. Kimi not bound. These are tab/binding observations, **not** five-provider E2E results.
- Source-only audit of `tools/ai_collaboration/provider-preflight.mjs` at blob `a84f5f6013675eb30147b5f03c0f81554325037b`: five exact-origin entries, explicit rejection of unsupported origins, zero-text composer classified `NEEDS_APPROVED_UNSENT_PREFILL`, and even READY returns `canSend:false`. Test file includes cases for conditional Send, spoofed origins, grants and auth; tests were **read**, not executed in this run.
- Prior snapshot lines claiming Claude `/login` and DeepSeek/Grok absent from Lab are historical and superseded by the current table. No OAuth, CAPTCHA, MFA, text prefill, send, process restart, credential handling or Codex CLI execution.
- Release verdict unchanged: **NO-GO** pending real per-provider approved send→ACK→reply evidence and independent review.
