# Local GitHub inbox 0057-A test report

Date: 2026-10-27 (Asia/Qyzylorda)  
Repository base: `rinatikd/nss-engine` `main` at `ac6eb0495307506c1bb80b0d5389af06944ef18a`  
Branch: `agent/codex/local-inbox-0057a`  
Host: Windows `10.0.19045.0`; PowerShell `5.1.19041.2364`; Python `3.15.0`

## Result

- **PASS:** 18/18 standard-library tests. Coverage includes first-run baseline and later request, paginated fetch, interrupted second issue/page, cursor atomicity, duplicate/restart and concurrent scans, edited/deleted comments, author-ID/login allowlist, issue/comment URL validation, injection text exclusion, Unicode hashing, oversize/malformed data, 401/403/429, disconnect, inaccessible database path, symlink substitution, fixed five-minute foreground watch cadence, and truthful database-only status.
- **PASS:** Python compilation (`py_compile`) for `inbox.py` and `test_inbox.py`.
- **PASS:** PowerShell 5.1 parser check for `task_scheduler.ps1`; generated `MSFT_TaskTimeTrigger` with `PT5M` interval and `P3650D` duration, without registering a task.
- **PASS:** Read-only live scan made unauthenticated GET requests to the two fixed public issues, #54 and #57. It established an isolated temporary baseline and printed no issue body; temporary database and SQLite sidecars were removed. This verifies current API compatibility and local outbound reachability only.
- **PASS:** Scheduler `Status` reported `NOT_INSTALLED`. Install mode with an incorrect confirmation phrase was rejected before registration.
- **PASS:** Read-only Codex CLI preflight reported `codex-cli 0.164.0`; `codex mcp list` exited 0 and the configured list contained the names `chrome-bridge`, `github`, and `node_repl`. Raw output/config values were not printed. This confirms a GitHub-capable CLI configuration exists, not that the CLI read this Issue.
- **PASS:** Added an explicitly started foreground `watch` mode with a fixed 300-second interval and Ctrl+C stop. It runs only the read-only inbox and never starts Codex.
- **PASS:** Started that foreground watcher in the current interactive tool session. Its first live scan established the baseline for Issues #54/#57 and emitted no new request. Its SQLite state is under the workspace runtime directory; the request bodies are not stored. This is session-bound and has no boot persistence.
- **PASS:** Posted live probe comment `6433314810` after the baseline; the active watcher picked it up on the next 300-second cycle at `2026-10-27T04:04:28Z` as `OBSERVED_UNVERIFIED`, SQLite audit event ID `1`. The local inbox output contained the marker/URL, not the comment body.
- **FAIL:** 0.
- **BLOCKED:** After the owner requested a working direct channel, Task Scheduler installation was attempted with the script's exact opt-in phrase. Windows returned `Access is denied` (`0x80070005`) at `Register-ScheduledTask`; subsequent `Status` and host query confirmed no task is present. No alternate privilege/persistence mechanism was attempted. There is no boot-persistent poller; the explicitly started foreground watcher is session-bound.
- **SKIP:** No local Codex CLI process-level receipt or response was observed. The watcher receives the queue item but does not wake or launch Codex.
- **BLOCKED:** No process-level receipt from local Codex CLI; no effective CLI sandbox/tool isolation proof. Actual Windows ACL enforcement and race-free handle-level protection against local filesystem substitution were not established. The code has best-effort symlink/junction checks and fails on inaccessible database paths, but this is not an OS sandbox.

## Behavior and limits

The initial complete scan records a baseline and does not emit historical comments as requests. Future allowlisted comments are reported as `OBSERVED_UNVERIFIED`, with event/comment IDs and URL. The poller never emits `DELIVERED_VERIFIED`, invokes a model, launches a process, or stores comment bodies. It records a hash and a constrained marker only. Failed pagination or validation prevents any cursor/audit transaction for that scan. Repeating or racing scans is deduplicated in SQLite.

The live scan used an isolated temporary database, not the default user profile. No GitHub credentials were used. Task Scheduler was not installed, no local Codex process was started, and production, `CODEX_DISABLED`, user credentials, and the repository `main` branch were not changed.

## SHA-256 of tested source files

```text
55d848a227cf95213f1c902341e85f43452dd734987dc3999131f8dde49ad8e4  inbox.py
46851e6854690d800ad4bdd32a7e8559f238c6766ef1cf372a5d3292791748b6  README.md
c0433a87bc46789e38d6dce640c6d27fc414427c72c21d9e45403eae829f6991  task_scheduler.ps1
e318c1acdba5305dd44c7cb1514368fb084e5fe7f42bb3c8986a45687cb29552  test_inbox.py
```

The final Git commit SHA is reported in the draft PR and the Issue #57 response after publication.
