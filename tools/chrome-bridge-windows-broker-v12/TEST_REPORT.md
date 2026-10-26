# Windows Broker v0.12 test report

Date: 2026-10-26 (Asia/Qyzylorda)

## Source revision and scope

This report accompanies the source-only proposal for draft PR #50, stacked on v0.11 PR #49. The authoritative source SHA is the current PR head linked from Issue #40. No C++ executable was built or run. No Codex process, model, MCP tool, production service, credential, tunnel, active CODEX_HOME, or CODEX_DISABLED setting was changed.

## Local validation

- **PASS: 27** Node source/unit tests: inherited strict policy/nonce tests, synthetic launch-order/rollback traces, native-inspector source checks, package gates, and six new v0.12 native source-contract tests.
- **PASS:** `node --check .\\policy.mjs`; `node --check .\\launch-trace.mjs`.
- **FAIL: 0** in the final test run. An initial run had three overstrict new source assertions; the test expectations were corrected and the complete suite was rerun successfully.
- **SKIP: 8** Windows integration test placeholders.
- **BLOCKED: 8** real host-observed Windows VM scenarios.
- **BLOCKED:** Native compilation. No `cl.exe`, `clang-cl.exe`, `clang++.exe`, or `g++.exe` was available; `tests/build-native.ps1` was not run.

Exact local test command:

```powershell
node --check .\\policy.mjs
node --check .\\launch-trace.mjs
node --test .\\tests\\policy.test.mjs .\\tests\\launch-trace.test.mjs .\\tests\\native-inspector.test.mjs .\\tests\\native-launcher-contract.test.mjs .\\tests\\package-gates.test.mjs .\\tests\\windows-integration.test.mjs
```

## Source review summary

The v0.12 native prototype is test-only and gated on a generated `test_pins.h` plus an explicit compile macro. Candidate open uses `GENERIC_READ` and `FILE_SHARE_READ`, rejects reparse points and multiple links, hashes the held handle, passes that handle to WinVerifyTrust and compares the signer leaf certificate SHA256. After `CreateProcessW(CREATE_SUSPENDED)`, it checks process image path/file ID/hash, Job membership/limits, and AppContainer token before `ResumeThread`. Startup uses explicit inheritable pipe handles via HANDLE_LIST, AppContainer security capabilities plus LPAC policy, and JOB_LIST assignment with kill-on-close/active-process/memory/time limits and no breakaway flags. Failure paths terminate the Job/process and wait.

These are source observations, not proof. The exact Wintrust helper ABI is documented as potentially changeable; its code path is uncompiled. File-ID/path comparison plus share denial is not a documented end-to-end process image transaction guarantee. Independent observation is required.

## Eight VM scenario statuses

| # | Scenario | Status | Evidence needed |
|---|---|---|---|
| 1 | AppContainer/LPAC/capabilities | BLOCKED | Independent token/SID/capability observation before resume |
| 2 | Job limits/kill-on-close/breakaway | BLOCKED | Host queries of job limits, membership, process count and kill-on-close |
| 3 | ACL/reparse/hardlink mutation race | BLOCKED | Controller-observed handle ACL/file ID and adversarial mutation results |
| 4 | Inherited handles/environment | BLOCKED | Host-side child handle enumeration and environment allowlist comparison |
| 5 | Network denial | BLOCKED | Independent loopback listener and OS/network evidence |
| 6 | Synthetic credential/profile denial | BLOCKED | Verified synthetic canary ACL, access denied and unchanged host hash |
| 7 | Child-process escape | BLOCKED | Process-create telemetry, Job count and descendant inventory |
| 8 | Crash cleanup/rollback | BLOCKED | Deterministic crash pausepoints and external recovery controller are not implemented |

`VM_EXECUTION_RUNBOOK.md` contains the future commands, observer evidence design, and the precise current execution gate. No native VM workflow was dispatched. The root GitHub workflow is manual source-only and has not been run.

## Decision and unresolved risks

**PARTIAL; NO-GO for native execution or production activation.** The source-only contract tests pass, but native compilation, executable negative probes, all eight OS observations, crash-recovery validation, independent review of image identity continuity, and a dedicated test controller remain outstanding. A compile macro or JSON attestation does not prove disposable-VM approval or isolation.
