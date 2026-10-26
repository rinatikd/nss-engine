# Chat Relay v0.3 test report

Date: 2026-10-26

## Results

- **PASS:** Source-only unit tests (mocked, no live GitHub, model, or tools).
- **PASS:** 16/16 Python unit tests; Python compile checks for `relay.py`, `diagnose.py`, and `test_relay.py`.
- **PASS:** GitHub Actions on final candidate `faadfc42635c4bad26ed2cf342fab783bb57c788`: v0.3 Windows source-only workflow and repository Source checks completed successfully.
- **PASS:** Read-only diagnostics code path covered with mocks for `--version`, `features list`, and `mcp list` only.
- **PASS:** Exact staging allowlist validation and rejection of extra config sources.
- **PASS:** GitHub pagination, partial pages, duplicate IDs, HTTP failures, timeout/no retry, and unexpected exceptions fail closed.
- **PASS:** Request edit/race revalidation blocks the action callback.
- **PASS:** Restart changes an interrupted RUNNING request to terminal UNKNOWN; replay is refused.
- **PASS:** Windows TOML literal path and Cyrillic Unicode integrity checks.
- **PASS:** Local Codex launch gate and both launch flags remain blocked.
- **PASS:** Read-only Windows diagnostic on the isolated allowlist profile. CLI version matched reviewed pin `codex-cli 0.164.0`; executable Authenticode status was Valid; SHA256 `6f267830b029ee25d9339864aa867cd45de9f8fd4c5ea007d2e63c13a0c66d36`. No model or tool was invoked.
- **PASS:** Sanitized CLI listing observation: 182 feature rows and 1 MCP output row; names and values omitted. The count is diagnostic output only and proves neither the complete effective tool inventory nor policy isolation.
- **PASS:** `--smoke-test` returned expected exit code 3 in local PowerShell and Windows CI; no model/tool process was started.
- **SKIP:** Live GitHub API and Issue #40 request processing; no network relay operation performed.
- **SKIP:** Real Codex invocation, model response, and tool invocation; intentionally absent from v0.3.
- **BLOCKED:** Effective tool isolation across built-ins, managed/global/project/user policy, inherited environment, MCP/plugin/app sources, and host policy is not established.
- **BLOCKED:** Windows sandbox enforcement smoke test was not run; it requires separate operator approval and a disposable isolated host.
- **NO-GO:** Any Relay-triggered local Codex launch.

## Windows path and Unicode verification

The test parses the TOML literal `C:\Users\Имя пользователя\Codex\config.toml` and verifies that the backslashes and Unicode are preserved. This Markdown file is read as strict UTF-8; tests reject U+FFFD and common mojibake markers. The user profile and credentials were not read, copied, or modified by the test suite.

The actual executable path was represented only as `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`; no user profile path or executable arguments are included in the saved sanitized JSON. Its SHA256 and Authenticode status were recorded above.

## Scope and limits

All PASS results are source/mocks checks in the staging copy. They do not establish production readiness, effective tool isolation, Windows sandbox behavior, or successful AI-provider delivery. The sanitized diagnostic format records counts and verification states, not raw names/values/paths. A code review of the GitHub revalidation path cannot eliminate the race between the final GET and a future external side effect; v0.3's closed launch gate makes no local side effect possible.
