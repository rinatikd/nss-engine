# NSS Engine read-only GitHub inbox (Issue #57, follow-up 0057-A)

This source-only prototype checks only `rinatikd/nss-engine` Issues #54 and #57. It reads public GitHub comments and stores metadata, SHA-256 body hashes, a SQLite cursor, and audit events. It never stores comment bodies, publishes comments, invokes Codex, or treats GitHub content as an instruction. A trusted new comment is reported only as `OBSERVED_UNVERIFIED`; that is not proof that Codex received it.

## Source-only checks

From this directory in Windows PowerShell:

```powershell
python .\test_inbox.py
python -m py_compile .\inbox.py .\test_inbox.py
```

The tests use synthetic comments and mocked HTTP responses. They do not poll GitHub and do not install or start a scheduled task.

## Local read-only use

```powershell
python .\inbox.py status
python .\inbox.py scan-once
python .\inbox.py status
```

If Task Scheduler registration is unavailable, an operator may explicitly start a foreground poller in a PowerShell window:

```powershell
$dbPath = Join-Path (Resolve-Path .).Path 'runtime\inbox.sqlite3'
python .\inbox.py watch --db $dbPath
```

It scans immediately, then every 300 seconds; keep that window open and press Ctrl+C to stop. It prints only status, IDs, URL, and constrained marker metadata. This user-started process does not run at boot, does not wake or launch Codex, and cannot prove the CLI received an item.

The first complete scan establishes a baseline and reports no historical comment as new. Later complete scans report new allowlisted-author comments with the Issue number, comment ID, marker (if present), URL, and `OBSERVED_UNVERIFIED`. The body is held only in memory long enough to compute its hash; it is not stored or printed. An edit or deletion is recorded in the audit table and never re-emitted as a new request. A failed/incomplete scan leaves the SQLite state and cursor unchanged.

No GitHub token is required for this public repository. The implementation has no token/configuration option. It uses the unauthenticated read-only REST API, fixed repository/issue IDs, pagination, a bounded retry for rate-limit/transient responses, and a 15-second per-request timeout. The durable database defaults to `%LOCALAPPDATA%\NSSCodexInbox0057A\inbox.sqlite3`; pass `--db` to use a separate review/test path.

## Optional Windows Task Scheduler setup

The scheduler script is not run as part of tests. It requires an explicit phrase before installation, refuses to overwrite an existing task, runs as the current user with least privilege, uses absolute Python/source/database paths, requests `IgnoreNew` for overlap, and has startup plus five-minute repetition triggers. The periodic trigger is created for ten years and must be renewed after that.

```powershell
# Install only after an operator explicitly chooses to enable polling:
.\task_scheduler.ps1 -Mode Install -ConfirmInstall 'INSTALL READ-ONLY INBOX 0057A'

# Inspect the exact named task and its last result:
.\task_scheduler.ps1 -Mode Status

# Remove only this exact task name:
.\task_scheduler.ps1 -Mode Remove
```

The install command starts the scheduled task once after registering it. Tests must not run the Install mode. The scheduled task only runs `scan-once`; it does not start Codex. Under the configured interactive user principal, a user session must be available for the startup trigger to run.

## Operator and security limits

- This is a polling inbox, not a push notification and not process-level proof of receipt. GitHub comments do not launch the poller or Codex.
- The allowlisted author is checked by both login and numeric GitHub user ID. The issue and comment URLs/IDs are validated against fixed values.
- Request bodies are untrusted; only a compact marker is extracted for display. No GitHub text is evaluated, interpreted as a command, or passed to a process.
- SQLite uses WAL and `synchronous=FULL`; concurrent scans serialize writes and unique audit keys suppress duplicate events. A cursor advances only after every page of both allowlisted issues has been fetched and validated.
- The host's Windows ACL inheritance, reparse-point protections, Task Scheduler registration behavior, and effective security policy have not been independently proven by these source-only tests. Keep scheduler installation opt-in and review the effective file ACL before relying on the local database.
- No local Codex CLI run, Windows sandbox test, model call, production change, credential change, or `CODEX_DISABLED` change is included.
