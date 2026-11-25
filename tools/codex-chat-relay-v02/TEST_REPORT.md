# Chat Relay v0.2 — validation report

**Status:** Draft PR suitable for source review; **NO-GO for unattended use or production installation.**

## Results

- **PASS — 16/16 unit tests**, using isolated temporary SQLite files and mocked GitHub/Codex subprocesses.
- **PASS — 2/2 Python compile checks** (`relay.py`, `test_relay.py`).
- **PASS — CLI help inspection:** local Codex CLI documents repeatable `--disable`, `--sandbox`, `--cd`, and `--ephemeral` flags. No model call was launched.
- **FAIL — 0.**
- **SKIP — 2 live integration checks:** relay `gh` authentication/poll/post against Issue #40; real Codex execution. No messages were sent and no local Codex process was started.
- **BLOCKED — production readiness:** configured MCP servers and all Codex runtime capabilities are not attested by this prototype. The code disables `shell_tool` and `apps`, but cannot prove there are no additional user-configured tools. A per-request `RUN <id>` confirmation is also required; none was given for a live request in this validation.

## Covered by unit tests

Sender ID and login allowlist; fixed open Issue behavior; malformed/control/secret-like input; body fingerprint changes; first-run baseline; duplicate comment/request IDs; restart conversion of interrupted `RUNNING` into terminal `UNKNOWN`; hourly launch cap across restart; `CODEX_DISABLED`; exact `RUN <id>` gate; no shell and prompt passed only over stdin; read-only/ephemeral/temp-directory flags; bounded stdout and timeout termination; reply publication through stdin; correlated GitHub response verification; malformed publish result treated as unknown.

## File inventory and SHA256

- `relay.py` — `CBF318C36627C6FC2DF0AE80974B548947F45F78740D342B862A048F364664E4`
- `test_relay.py` — `FACB8EAF6DBA61B99312932B74F753F9DD198EEF9DD532E937AD82DE82048F8F`
- `README.md` — `499D7EA977AED30B60E125DBBDBA6D4BF641CD1B595FDD14E1882DA4277FE951`

## Scope and remaining risks

This is a manually started foreground poller over public GitHub Issue #40. First run records existing comments without processing them. Later runs accept only new comments from login `rinatikd` with numeric account ID `337319789`, verify the authenticated `gh` identity and fixed open issue, require a human approval before a local run and another confirmation before publication. No background service, MCP endpoint, Chrome Bridge, credential, tunnel, `main`, or `CODEX_DISABLED` setting was modified.

The source checks cannot ensure the host's Codex config lacks other MCP servers or read-capable tools, nor prove the CLI sandbox on this Windows host. The local GitHub CLI account/API path was not exercised end-to-end. GitHub Issue comments are public and not a private channel. Review the local Codex config and run a separately approved staging smoke test before relying on it. Ambiguous process/post outcomes are terminal and are never retried automatically.

