# Codex Chat Relay v0.2 (Issue #40)

A foreground, opt-in prototype for a **fixed GitHub Issue #40** queue in `rinatikd/nss-engine`. It is not an MCP server, persistent background service, or verified direct ChatGPT connection. The operator runs it manually; no startup task or production Bridge configuration is installed.

## Fixed trust boundary

- Repository: `rinatikd/nss-engine`; issue: `40`; expected sender login and immutable GitHub numeric ID: `rinatikd` / `337319789`. There are no repository, issue, or sender command-line overrides.
- The relay verifies `gh api user` and open issue metadata before reading comments. Request content must match `[CODEX-CHAT REQUEST <stable-id>]` plus bounded text. Secret-looking strings and malformed requests are rejected.
- First launch records current eligible comments as a baseline and processes none. SQLite stores comment IDs, request IDs, SHA256 body fingerprints, states and event codes, but no message contents. Duplicate IDs/request IDs are rejected. Corrupt/unwritable state fails closed. Interrupted `RUNNING` or `PUBLISHING` becomes terminal `UNKNOWN`; there is no automatic retry.
- Each prompt requires `APPROVE <id>`. Each local Codex launch separately requires `RUN <id>`. Each public reply separately requires `PUBLISH <id>`. The request comment is re-fetched and fingerprint-checked before launch and publication.
- Issue text is passed via stdin to a fixed argv list with `shell=False`; it is never interpreted as a shell command. The CLI runs from a new empty temporary directory with read-only sandbox, ephemeral session, and `shell_tool` / `apps` disabled. It does not use `--ignore-rules` or alter `CODEX_DISABLED`. If `CODEX_DISABLED` is truthy, launch refuses.
- Logs contain only request IDs and status/error codes. CLI stdout/stderr on failure is not logged. GitHub Issue #40 is public; do not put secrets there.

## Use

Requires Python 3.10+, GitHub CLI authenticated as `rinatikd`, and local Codex CLI only for the explicitly approved local response mode. Run in a terminal that can display and accept the approval prompts:

```powershell
python -m unittest -v
python relay.py
# After reviewing requests, explicit per-request opt-in to local Codex:
python relay.py --local-codex
```

The first run is a baseline-only pass; run again with `--local-codex` to see and approve later requests. Without that switch, the relay never claims new requests. Stop with Ctrl+C. State path defaults to `%LOCALAPPDATA%\CodexChatRelay\v02\relay.sqlite3`; tests create temporary state directly through the `State` class. Local launches are capped at five per hour and stdout is terminated above 24 KB. If Codex or GitHub posting has an ambiguous outcome, the state is non-retryable; inspect Issue #40 manually before any recovery.

## Scope and limits

This transports text through a public issue, not a private or cryptographically authenticated chat channel. User identity checks are API-authoritative but depend on `gh` credentials and GitHub availability. The local confirmation prompt protects each launch but does not attest the operator or the Codex installation/configuration. `read-only` plus disabling shell/apps is defense in depth, not proof of a formally isolated environment. This prototype does not audit user-configured MCP servers or other Codex capabilities; review them before opting into a run. No claim of production-safe Codex isolation is made. This prototype does not enable Chrome Bridge `codex_submit`, alter `CODEX_DISABLED`, or configure production services. A human must review every response before public publication.

## Validation status

See `TEST_REPORT.md` in this package and the linked draft PR for the exact PASS/FAIL/SKIP/BLOCKED results. Live GitHub polling and a real Codex invocation are not part of automated tests.

