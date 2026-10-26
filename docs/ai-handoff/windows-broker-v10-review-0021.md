# AI review handoff — Windows Broker v0.10
Date: 2026-10-26
Project: rinatikd/nss-engine
Pinned PR: #46 https://github.com/rinatikd/nss-engine/pull/46
Pinned source commit: 50ca4b3bdb41ef83828af211142d50e2b7cdd7ee
Unified diff: https://github.com/rinatikd/nss-engine/pull/46.diff
Patch: https://github.com/rinatikd/nss-engine/pull/46.patch

## DeepSeek task — deepseek_vm_security_0016

Review the **actual source** for the Windows VM negative test plan and acceptance criteria. Scope:
1. AppContainer/LPAC token, actual token SID and integrity level, zero unexpected capabilities and loopback restrictions.
2. Job Object: KILL_ON_JOB_CLOSE, no BREAKAWAY_OK or SILENT_BREAKAWAY_OK, CREATE_SUSPENDED → AssignProcessToJobObject → ResumeThread and crash race.
3. Network denial at OS boundary; exclude false assurance based on proxy/firewall environment only; evaluate IPC and named pipe leaks.
4. Denied access to synthetic credential markers, user profile, CODEX_HOME; inherited handle and environment allowlists (no LOCALAPPDATA by default).
5. Child-process escape attempts and independent confirmation that process tree is empty.
6. Broker crash cleanup: process tree, temporary files, handles, any ACL grants.
7. External evidence: which **host-side observer** gathers each result, exact PASS/FAIL/SKIP/BLOCKED acceptance criteria. Never treat broker self-reported JSON as OS isolation proof.
8. Look for hidden or bidirectional Unicode in PR changes and report only verified occurrences.

Report findings as [ID] file:line — observation → PASS/FAIL/SKIP/BLOCKED, and distinguish current source-only test scaffolding from genuine host/VM experiments. Eight genuine Windows OS integration probes remain SKIP/BLOCKED. PR #46 CI compiled a native read-only inspector and tested invalid unsigned image pins; this does NOT prove process confinement.

Relevant pinned files:
- native inspector: https://github.com/rinatikd/nss-engine/blob/50ca4b3bdb41ef83828af211142d50e2b7cdd7ee/tools/chrome-bridge-windows-broker-v10/native/image_inspector.cpp
- integration test scaffolding: https://github.com/rinatikd/nss-engine/blob/50ca4b3bdb41ef83828af211142d50e2b7cdd7ee/tools/chrome-bridge-windows-broker-v10/tests/windows-integration.test.mjs
- tests: https://github.com/rinatikd/nss-engine/tree/50ca4b3bdb41ef83828af211142d50e2b7cdd7ee/tools/chrome-bridge-windows-broker-v10/tests
- test report: https://github.com/rinatikd/nss-engine/blob/50ca4b3bdb41ef83828af211142d50e2b7cdd7ee/tools/chrome-bridge-windows-broker-v10/TEST_REPORT.md
- source contract: https://github.com/rinatikd/nss-engine/blob/50ca4b3bdb41ef83828af211142d50e2b7cdd7ee/tools/chrome-bridge-windows-broker-v10/policy.mjs

Important missing material: Windows VM trial report from local path `C:\Engineering\chrome-bridge\codex-handoff-output\windows-vm-trial-0015\TEST_REPORT.md` is not part of PR #46. The signed/hash-pinned broker is not yet implemented as a runnable verified Codex launcher; this handoff does **not** represent a full VM trial plan or run.

## Qwen review — native_windows_inspector_0017 (owner-supplied, source-only)

Qwen's feedback on v0.9: critical string path check TOCTOU in `canonicalLocalPath`; signature validation based on caller-provided objects; ACL snapshots not derived from trusted OS APIs; inheritance and Job Object separation risks. Recommended v0.10 review: native open-handle path identity, `WINTRUST_FILE_INFO.hFile`, `GetSecurityInfo` on trusted file handle, strict `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, plus OS VM-negative tests (synthetic symlink/hardlink, unsigned/tampered file, hidden handles, race, denied network/credentials, child cleanup). Cross-check against **actual v0.10 code**, which includes `image_inspector.cpp`, before labeling deficiencies as unaddressed. Avoid using real system credential stores as test targets. Proposed API details are hypotheses until validated on Microsoft API docs and actual tests.

## Coordination / constraints

Use GitHub **files at commit URLs** for delivery, not issue-comment anchors, since some third-party assistants see static HTML without Activity. Task discovery via GitHub alone is NOT proof of receipt; explicit ACK is required. Do not disclose credentials or local config. No production changes, no activation of CODEX_DISABLED, no actual Codex model execution, and do not claim sandbox proof from unit mocks. Direct calls to local Codex remain CODEX_DISABLED. Report to Issue #40 if your GitHub connection supports writes, or return a complete response to the operator.
