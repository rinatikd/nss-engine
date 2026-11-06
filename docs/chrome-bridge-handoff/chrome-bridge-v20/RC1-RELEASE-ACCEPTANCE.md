# Chrome Bridge 0.2.0 RC1 — Release acceptance ledger

**Status: Release candidate / NO-GO for production.** This ledger distinguishes observed Windows operator evidence from CI/synthetic tests and unperformed release gates. Do not merge or deploy to the active 17381/17382 installation until the blockers are independently closed.

## Real isolated Windows operator evidence (2026-11-06)

Environment: test Chrome profile and unpacked V4 extension ID `oceicpoimgbaebcgneelljajemkcggfm`; isolated Node server `127.0.0.1:17481`; independently created lab `CHROME_BRIDGE_HOME` and browser token. Production endpoints, credentials and tunnel were not deliberately modified.

| Case | Result | Evidence scope / caution |
| --- | --- | --- |
| CORS preflight from pinned extension Origin | PASS | HTTP OPTIONS 204; `Access-Control-Allow-Origin` matched test extension |
| Authenticated browser poll | PASS | PowerShell POST to lab `/bridge/poll` returned 200 with lab token; no token disclosed |
| Panel connects in normal mode | PASS | UI `Подключено · ожидание команд` |
| Explicit background mode start | PASS | UI `Подключено · фоновый режим` |
| Close/reopen panel | PASS (UX) | Operator reported background status retained; not a timed 120-second or TCP single-owner test |
| Grant-all on approved currently open chat tabs | PASS (UI) | 3 grants, 0 failures, 15-minute scope; UI confirms action-by-action approval requirement but approval enforcement NOT tested |
| Revoke-all | PASS (UI) | UI `Управление всеми вкладками отозвано`; background connection remained reported connected; direct coordinator denial after revoke NOT tested |

**Provenance:** above observations were operator-reported in the interactive Windows lab session. They were performed against a *locally remapped V4 folder*, not necessarily the latest PR #96 packaging commit. Repeating against the current immutable packaged candidate is required.

## Candidate packaging changes in PR #96

- Stage from candidate allowlist only; never clone installed extension tree or local credential files.
- Validate relative JS import closure and syntax; fail closed on missing/escaping modules.
- Keep manifest source from installed MV3 manifest, with audited permissions; reject unapproved content scripts and icon paths.
- Automatically rewrite staged client Bridge address from `127.0.0.1:17381` to `127.0.0.1:17481`; strip production-specific and port-agnostic loopback host permissions. The source extension remains unchanged.
- Output destination must be new and outside installed BridgeRoot; cannot overwrite existing fixture.

## Required final gates before production (not yet proven)

1. **Independent ACK and signed PASS/FAIL reviews** by lifecycle, security, Windows packaging, and mutation/adapter reviewers in Issue #94. GitHub issue comments asking assistants to review do not prove they received or executed the task.
2. **Windows PS 5.1 clean fixture** from the exact PR #96 head: dry-run and Apply, verify complete file inventory, SHA-256 hashes, manifest host-only isolation, browser ID origin pinning, rollback and exact restore.
3. **Real disposable Chrome MV3 negative tests**: multiple-owner prevention, server outage/recovery, Chrome restart, manual stop persistence, denied origins, revoked grants and expired grants.
4. **Per-action approval E2E**: pending approval, decline, accept once, navigation and tab reuse TOCTOU, stale/replayed approvals, no send/typing before fresh consent. Do not send messages to actual AI services without local action-specific user consent.
5. **Packaging/rollback documentation and provenance**, complete release artifact signature/inventory and a rehearsed non-production rollback.

## Decision

CI green and successful UI smoke tests are *necessary but insufficient*. Keep PR #95 and PR #96 in draft and do not publish final production release until the above gates are explicitly closed. No automated task may interpret this ledger as permission to mutate live AI chats or change production server state.
