# Chat Relay v0.3 staging

This is a diagnostics-only, fail-closed staging revision. GitHub request text is untrusted data. The relay does not invoke a model, MCP server, plugin, app, or local tool. `CODEX_LAUNCH_GATE_OPEN` is hardcoded `False`; there is no environment, file, or CLI override. `--local-codex` and `--smoke-test` always return **BLOCKED (exit 3)** before reading GitHub or creating a journal.

## Windows PowerShell: source-only checks

From the repository root:

```powershell
Set-Location C:\Engineering\chrome-bridge\codex-handoff-output\codex-chat-v03
python -m unittest -v
python -m py_compile .\relay.py .\diagnose.py .\test_relay.py
python .\diagnose.py --source-only
```

These checks use local source and mocks. They do not invoke Codex.

## Windows PowerShell: read-only diagnostics

```powershell
Set-Location C:\Engineering\chrome-bridge\codex-handoff-output\codex-chat-v03
.\diagnose-windows.ps1
```

The script records executable presence, SHA256, Authenticode status, and runs only `codex --version`, `codex features list`, and `codex mcp list` with a child environment pointing to the diagnostics-only allowlist. It does not read or rewrite the user's config and does not launch a model. The JSON report intentionally omits raw tool names, endpoints, environment values, and local paths. A clean temporary `CODEX_HOME`, a config allowlist, or a CLI listing does not prove effective tool isolation or Windows sandbox enforcement; both remain **UNVERIFIED**.

## Future synthetic host smoke test (blocked)

The only planned prompt is the fixed synthetic string in [smoke-test-plan.md](smoke-test-plan.md). The test has **not** been run. An operator must separately review and approve a disposable host/VM test after independently establishing all effective tool sources and Windows sandbox enforcement. No command in this package can open the launch gate. Do not use credentials or a production account.

```powershell
python .\relay.py --smoke-test
# Expected: BLOCKED, exit code 3; no local process launched.
```

## GitHub behavior

The source retains fixed repository/Issue/sender constants and provides mocked pagination and immediate request revalidation primitives. It is not a live relay runner in v0.3. Pagination has a time/page/comment limit, rejects malformed or partial pages, and never retries. A full page without a `next` indication requires a terminal page to avoid silently accepting a truncated list. Before a future action, the comment ID, sender, body fingerprint, and unedited timestamp must be fetched again and match exactly; this reduces but cannot create an atomic lock on public GitHub comments.

## Status

Staging-ready for source review and read-only diagnostics. **NO-GO** for local Codex execution until effective tool isolation and Windows host sandbox behavior are independently verified and separately approved.
