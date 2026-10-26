# Chat Relay v0.2 hardening — validation report

**Assessment:** **NO-GO for a live local Codex run on this host.** Fail-closed preflight detected installed MCP, plugin, app, hook, and tool configuration and refused the Relay path. This is a source-only follow-up based on PR #41 head `d0c1d2ae1df3485d8c536f630fff813d4c5badb3`; production was not changed.

## Sanitized Windows Codex preflight evidence

Read-only inspection performed on 2026-10-26:

- Installed executable: `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`; version `codex-cli 0.164.0` (the reviewed version pinned by the relay preflight).
- Default `%USERPROFILE%\.codex\config.toml` exists and parses as TOML. No config values, environment values, credentials, or command arguments were printed.
- Config contains 3 MCP server definitions: `chrome-bridge`, `github`, `node_repl`; 10 plugin entries; 3 app connector groups; hook configuration; nested tool mappings.
- `codex features list` reports `apps stable true` and `shell_tool stable true` in the regular profile. Relay's invocation would disable those two features, but this does not eliminate MCP/plugins/hooks.
- `codex mcp list` reports configured entries, including `chrome-bridge` enabled. The inspection commands did not start an MCP server or a model request.
- Relay preflight result: **BLOCKED** with sanitized findings for MCP servers, plugins, apps, hooks and tool sections. The installed version matches the pin, but configured tools cause refusal. No request was claimed, no Codex process was launched by Relay, and no setting was changed.

## Results

- **PASS — 28/28 unit tests**, using temporary config files, temporary SQLite journals and mocked GitHub/Codex processes.
- **PASS — 2/2 Python compile checks** (`relay.py`, `test_relay.py`).
- **PASS — host preflight fail-closed:** actual local config was rejected before request claim or local execution.
- **PASS — CLI read-only inspection:** version, `mcp list`, and `features list`; only sanitized facts were recorded.
- **FAIL — 0.**
- **SKIP — live GitHub relay polling/post and actual Codex model invocation.** The issue was not modified by the Relay and no local model process was started.
- **BLOCKED — live Relay use:** current host has additional configured capabilities. A separately reviewed configuration and Windows sandbox assessment are required before any later pilot. `CODEX_DISABLED` and production settings were left untouched.

## Regression coverage

Fixed sender ID + login and open Issue #40 checks; missing/malformed config; additional MCP/plugin/app/hook rejection before confirmation or process launch; pinned CLI version acceptance/rejection; baseline UX and dedupe; restart to `UNKNOWN` for interrupted run/publication; simulated server-accepted POST with lost client response (no retry after restart); Unicode and multiline request/response; oversize request/stdout; malformed UTF-8 and terminal control output; timeout termination; per-request approvals; shell-free stdin transport; `CODEX_DISABLED` refusal.

## Baseline behavior

The first run permanently records all currently eligible request IDs and processes none. The terminal and README now state this. Existing `codex_chat_autorelay_0002` is intentionally ineligible after baseline. To exercise a future staging pilot, post a new Issue #40 request with a new requestId after baseline; do not edit SQLite state to revive an old request.

## File inventory and SHA256

- `relay.py` — `587C39ED24B18DB6F20ED050056F2C2DD76F7A7ED72F1A7536BD18DA8B64EE55`
- `test_relay.py` — `3981EB6D14D059D297CA4E7D26BE2C0B5B2D4086DA46C7ECFD2251DAAD630ADE`
- `README.md` — `F64983C3327CE980DE8D38452B90B3690A6B24308556E2050D225C905F5CC7E6`
- `TEST_REPORT.md` — this report

## Remaining limits

The preflight checks the active `CODEX_HOME`/default TOML and pins the inspected CLI version, but it cannot attest Windows sandbox enforcement or future CLI behavior. This implementation intentionally blocks any configured MCP/plugin/app/hook/tool sections rather than trying to selectively permit them. GitHub live poll/post has not been exercised. The terminal displays request and answer text for operator review; redirected output can retain that text. Issue #40 is public. Do not use private prompts or sensitive answers for a live pilot.

