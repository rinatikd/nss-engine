# Windows Broker v0.12 test report

Date: 2026-10-27 (Asia/Qyzylorda)

## Source revision and scope

This report accompanies draft PR #51, stacked on v0.11 PR #49. Latest published source head under validation: `73f220aa9afed6b0ea122bc749c514ba970de785`. No Codex process, model, production service, credential, tunnel, active CODEX_HOME, or `CODEX_DISABLED` setting was changed. A harmless `codex_submit` request in the active ChatGPT session returned `CODEX_DISABLED: isolated local execution policy required`; no job was created.

## Local validation

- **PASS: 28, FAIL: 0** Node source/unit tests; rerun locally on 2026-10-27, including a regression test for compiler and whole-step watchdogs. Eight tests were skipped because no approved independent host observation is available.
- **PASS:** Windows Server 2025/MSVC compile-only run `40454265656` compiled `test_launcher.cpp` and `synthetic_worker.cpp`; it launched neither binary. Source checks `40454265654` also passed. Prior compile-only runs passed as well.
- **FAIL / BLOCKED:** synthetic run `40451830379` ended with `SYNTHETIC_PROBE_OUTER_WATCHDOG_TIMEOUT`. Its logs show worker compilation completed in about 11 seconds and certificate creation completed. The last marker was `trust-ephemeral-certificate`, immediately before `Export-Certificate` and `Import-Certificate`; the stall is isolated to that export/trust block. No signed worker or launcher run was reached.
- **IN PROGRESS / NOT A PASS:** runs `40453483251` (head `8bdd523`) and `40454265636` (head `73f220a`) remain `in_progress` with no retrievable logs. Current head uses direct `X509Store` operations, removes unnecessary certificate-file export, and retains process/step watchdogs. This Windows change is still unverified.
- **SKIP: 8** Windows integration test placeholders; **BLOCKED: 8** independent host-observed VM scenarios.
- **FAIL: 0** in the latest local Node test run. This does not validate native runtime behavior.

Exact local test command:

```powershell
node --check codex-handoff-output/windows-broker-v12/policy.mjs
node --test codex-handoff-output/windows-broker-v12/tests/*.test.mjs
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

`VM_EXECUTION_RUNBOOK.md` contains the future commands, observer evidence design, and the precise current execution gate. The hosted workflow runs reported above are synthetic-only probes and are not independent host attestation. The separate root GitHub workflow remains manual source-only.

## Decision and unresolved risks

**PARTIAL; NO-GO for local Codex execution or production activation.** Source tests and compile-only checks pass. No hosted synthetic probe has produced a successful launcher result; one stalled in certificate export/trust and the current run has no retrievable result. All eight independent host-observed scenarios and crash-recovery validation remain blocked. The ChatGPT-to-local-CLI call is confirmed fail-closed by `CODEX_DISABLED`. A compile success, launcher self-report, or JSON attestation does not prove isolation and does not authorize changing that gate.

