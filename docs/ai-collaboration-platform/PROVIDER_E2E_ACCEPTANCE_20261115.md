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
| Claude | Lab tab bound, but URL is claude.ai/login; composer matched 0, send matched 0 | Logged out / captcha present. Auth is operator-only | Operator signs in to isolated test Chrome. Recheck selector health + per-origin grant, then approval-based unique-request send and correlated reply |
| Gemini | Lab tab bound on gemini.google.com/app; composer matched 1 visible; send matched 0; no replies present | Adapter send selector not established; no granted origin | Read-only inspect composer/send state and fix provider selector with lab tests, then obtain local grant and perform correlated send/ack/reply |
| DeepSeek | Remembered binding on disconnected Main Bridge; not present in Lab agent list | Production bridge disconnected, no lab bound tab | Restore Main browser separately or explicitly open/bind clean lab chat, verify adapter/auth and local grant |
| Grok | No tab binding in connected PR102 Lab; current installed browser-control allowlist is limited to claude.ai/gemini.google.com/chat.deepseek.com | Provider not enabled in current adapter + origin policy | Add explicit x.com/grok or grok.com verified origin as separate reviewed provider adapter and test in isolated lab, never bypass allowlist |
| Kimi | No tab binding in connected PR102 Lab; current installed browser-control allowlist does not include kimi.ai | Provider not enabled in adapter + origin policy | Implement/review explicit kimi.ai adapter and policy; isolated lab auth, selectors, send/reply proof |

## Gated E2E protocol (each of five, not inferred from any other)

1. Inspect exact browser instance, profile/extension identity, connected tab, URL origin and operator login state. No copying cookies, bearer tokens or browser grants between Main and Lab.
2. Validate provider-specific editable composer, send control, generating/stop and answer markers via read-only selftest and selector diagnostics. Gate blocks if an essential selector is missing.
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
