# Chrome Bridge staging history: v17–v20

This is a sanitized summary of local staging reports. Raw reports and logs were excluded because they contain machine paths, process metadata, or local evidence that is not necessary for source review.

- **v17:** staging integration accepted for continued isolated development. Node suite reported 78 PASS, 0 FAIL, 8 SKIP; synthetic MV3/CDP and schema checks passed. Production cutover and Codex execution remained NO-GO. Real provider exchange, trusted toolbar wakeup, conversation identity, ACL/disk-full and Grok/Qwen support were not proven.
- **v18:** journal byte bound, HMAC conversation fingerprint, exact origin/conversation checks, and duplicate suppression after restart were added. Reported Node suite: 83 PASS, 0 FAIL, 8 SKIP; four synthetic provider fixture flows passed. Real provider exchange remained blocked.
- **v19:** exact extension ID pinning and a 15→18→15 isolated cutover/rollback rehearsal. Reported 79 PASS, 0 FAIL, 14 SKIP in the default Node suite and 12/12 isolated cutover scenarios. Real AI-provider exchange and trusted toolbar wakeup remained blocked. An opt-in native runner run reported four failures; no execution was enabled.
- **v20:** Grok/Qwen remained read-only candidates with Control disabled. Reported Node suite: 80 PASS, 0 FAIL, 14 SKIP; five focused no-Control tests passed. Its own MV3/CDP attempt was blocked by the unavailable test browser, and real provider exchange remained blocked.

Counts are copied from their version reports and are not cumulative. Synthetic fixtures are not real provider delivery. `CODEX_DISABLED` remained enforced. Production services and credentials were not part of these staging changes.

Source tree is the v20 staging worktree plus selected v20 rollback-candidate source. The direct ChatGPT→local CLI experiment is a separate v21 prototype and is not wired into Chrome Bridge. It publishes three tools but always returns `CODEX_DISABLED`; no execution path is present.

