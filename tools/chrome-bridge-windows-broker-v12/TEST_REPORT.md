# Windows Broker v0.12 test report

Date: 2026-10-27 (Asia/Qyzylorda)

## Source revision and scope

This report accompanies draft PR #51, stacked on v0.11 PR #49. Latest reviewed implementation commit: `429cd003d74eb5bc295a84982e63e304cbc9fd01`. PR head at report time: `9ea70018dea1b38fe88a2dd0d5026f57a54d2992` (report/metadata update after the implementation commit). No Codex process or model was launched; production services, credentials, tunnel settings, active CODEX_HOME and project execution policy were not changed. The user's permission to remove `CODEX_DISABLED` is noted, but does not itself provide an isolated execution boundary.

## Validation results

- **PASS: 28, FAIL: 0** local Node source/unit tests, including watchdog regressions. Eight Windows integration placeholders are skipped because independent host observations are unavailable.
- **PASS:** PowerShell 5.1 AST parse of `Run-SyntheticVmProbe.ps1`.
- **PASS:** GitHub source checks run `40457651965` for PR head `9ea7001`.
- **PASS:** Windows Server 2025/MSVC compile-only run `40457651968`; both native sources compiled and neither binary was launched. The compiler reported unused-variable/parameter warnings.
- **BLOCKED/PENDING:** synthetic-only run `40457652019`, job `122034622176`, was still `in_progress` on last inspection. Its step log endpoint returned `404 BlobNotFound`; no stage-level evidence or successful launcher result is available. Do not count this run as PASS.
- **FAIL/BLOCKED:** prior synthetic run `40451830379` ended with `SYNTHETIC_PROBE_OUTER_WATCHDOG_TIMEOUT`; logs last reached certificate trust setup before export/import. Run `40456020612` ended in failure, but GitHub logs returned `404 BlobNotFound` and the job step remained stale as in progress. Neither reached an evidenced successful launcher result.
- **SKIP: 8** Windows integration placeholders; **BLOCKED: 8** independent host-observed VM scenarios below.
- **FAIL: 0** in the latest local test suite. This is not evidence of native runtime isolation.

Local command:

```powershell
node --check codex-handoff-output/windows-broker-v12/policy.mjs
node --test codex-handoff-output/windows-broker-v12/tests/*.test.mjs
```

## Source review summary

The native prototype is test-only and gated on generated `test_pins.h` plus an explicit compile macro. It opens the candidate read-only with restrictive sharing, rejects reparse points/multiple links, hashes the held file handle, passes that handle to WinVerifyTrust and compares the signer leaf certificate SHA256. After `CreateProcessW(CREATE_SUSPENDED)`, it checks process image path/file ID/hash, Job membership/limits and AppContainer token before `ResumeThread`. Startup uses explicit inheritable pipe handles via HANDLE_LIST, AppContainer capabilities plus LPAC policy, and Job-list assignment with kill-on-close/resource limits and no breakaway flags. Failure paths terminate and wait.

These are source observations, not proof of runtime enforcement. The Wintrust helper ABI remains a risk and needs direct supported-API validation. File-ID/path comparison plus share denial does not by itself establish a complete process-image transaction guarantee. Independent host observation remains required.

## VM scenario status

| # | Scenario | Status | Evidence needed |
|---|---|---|---|
| 1 | AppContainer/LPAC/capabilities | BLOCKED | Independent token/SID/capability observation before resume |
| 2 | Job limits/kill-on-close/breakaway | BLOCKED | Host queries of Job limits, membership, process count and kill-on-close |
| 3 | ACL/reparse/hardlink mutation race | BLOCKED | Controller-observed handle ACL/file ID and adversarial mutation results |
| 4 | Inherited handles/environment | BLOCKED | Host-side child handle enumeration and environment allowlist comparison |
| 5 | Network denial | BLOCKED | Independent loopback listener and OS/network evidence |
| 6 | Synthetic credential/profile denial | BLOCKED | Verified synthetic canary ACL, access denied and unchanged host hash |
| 7 | Child-process escape | BLOCKED | Process-create telemetry, Job count and descendant inventory |
| 8 | Crash cleanup/rollback | BLOCKED | Deterministic crash pausepoints and external recovery controller are not implemented |

`VM_EXECUTION_RUNBOOK.md` documents a future acceptance procedure, not completed evidence. Hosted synthetic runs do not provide independent host attestation. The root workflow is source-only/manual.

## Decision

**PARTIAL; NO-GO for local Codex execution and production activation.** Source tests, source checks and compile-only validation pass. The synthetic probe is pending without retrievable logs; previous attempts failed or timed out. All eight independent VM scenarios and crash recovery remain blocked. The active ChatGPT-to-local-CLI path remains fail-closed by `CODEX_DISABLED`; no job was created. Permission to remove the gate is not equivalent to verified isolation. Do not enable execution based on compilation, broker self-report or JSON attestation alone.
