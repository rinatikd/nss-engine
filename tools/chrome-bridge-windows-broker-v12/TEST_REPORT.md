# Windows Broker v0.12 test report

Date: 2026-10-27 (Asia/Qyzylorda)

## Source revision and scope

This report accompanies draft PR #51, stacked on v0.11 PR #49. Latest native implementation commit: `52f63298018aeabb36b1e6b8b615ea6f9bf5862b`; latest PR head: `732f04f8e124aaca471c5824843182506cad1b32`. No Codex process or model was launched; production services, credentials, tunnel settings, active CODEX_HOME and project execution policy were not changed. The user's permission to remove `CODEX_DISABLED` is noted, but does not itself provide an isolated execution boundary.

## Validation results

- **PASS: 28, FAIL: 0** local Node source/unit tests, including watchdog regressions. Eight Windows integration placeholders are skipped because independent host observations are unavailable.
- **PASS:** PowerShell 5.1 AST parse of `Run-SyntheticVmProbe.ps1`.
- **PASS:** latest hosted source checks run `40459200587` for report snapshot `55b5bf8` (source head `732f04f`).
- **PASS:** Windows Server 2025/MSVC compile-only run `40459200619` compiled the native sources, including the additional token SID/capability checks; it launched neither native binary.
- **FAIL:** synthetic-only run `40458982032` failed at `ROOT_STORE_ADD_WATCHDOG_TIMEOUT` after the 30-second cap on `certutil -user -addstore`. Its logs show `Signature matches Public Key`, then no completion from the Root store add. The cleanup `certutil -user -delstore` completed successfully. Stage artifact: [run 40458982032 artifact 12713038721](https://github.com/rinatikd/nss-engine/actions/runs/40458982032/artifacts/12713038721), SHA256 `3284a6d583a59f983edd67739b696d915bab4efae9bd01aba76183f3ed223931`.
- **FAIL/BLOCKED:** earlier synthetic run `40457766208` timed out after 10 minutes in `X509Store.Add`; the two Root-store write mechanisms fail at the same phase on this hosted worker. Run `40456020612` also ended in failure with logs unavailable. No launcher success is evidenced.
- **FAIL:** repeat run `40459200559` reproduced the same `ROOT_STORE_ADD_WATCHDOG_TIMEOUT`; bounded certificate removal succeeded. Artifact `12713568327`, SHA256 `f70a73720b9696103c2a282e090145666ee06a96b26e8a192a49fcabf22e7db2`.
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

**PARTIAL; NO-GO for local Codex execution and production activation.** Source tests, source checks and compile-only validation pass. The latest synthetic probe failed at the bounded Root-store add; no native launcher run was reached. All eight independent VM scenarios and crash recovery remain blocked. The active ChatGPT-to-local-CLI path remains fail-closed by `CODEX_DISABLED`; no job was created. Permission to remove the gate is not equivalent to verified isolation. Do not enable execution based on compilation, broker self-report or JSON attestation alone.

## Follow-up: bounded diagnostic artifact

Implementation commit `df49e1674c113bacef11bbe1d4adde1b6e4ed462` adds timestamped synthetic-only stage logging to a runner-temp text file and uploads that file with three-day retention even when the probe fails. It contains phase names and generic error markers only; it is not treated as host attestation. Regression tests assert the logging and artifact wiring.

- **PASS: 28, FAIL: 0, SKIP: 8** local Node suite after the logging change.
- **PASS:** PowerShell AST parse of the modified probe script.
- **PASS:** hosted source checks `40458270563` and compile-only `40458270659` on head `df49e16`; neither launched the native binary.
- **FAIL:** run `40458270520` completed after the 10-minute watchdog; see the later Root-store diagnostic entry below.

This logging change improves future diagnosis; it does not close the isolation gate or change the NO-GO decision.

## Follow-up: Root-store watchdog diagnosis and bounded certutil trial

Run `40457766208` completed with failure after its 10-minute outer watchdog. Its logs show worker compilation and ephemeral certificate creation succeeded; the last marker was `add-public-ephemeral-certificate` immediately before the blocked `X509Store.Add`. This identified the Root-store write phase for that version. It is a **FAIL**, not an isolation pass.

Implementation head `5acde624644a0d87d0e73cc1e611a3c3b7695a1d` replaces Root-store addition/removal with `certutil -user -addstore/-delstore`, each guarded by a 30-second process-tree watchdog; cleanup failure now fails the probe. This is a new synthetic-only experiment. It does not touch this workstation's certificate stores.

- **PASS: 28, FAIL: 0, SKIP: 8** local Node tests after the certutil change.
- **PASS:** PowerShell AST parse after the certutil change.
- **FAIL:** `certutil -user -addstore` also blocked, then the 30-second watchdog terminated the process. `certutil -user -delstore` cleanup succeeded. The log artifact is linked above.
- **PASS:** hosted source checks `40458982050` and compile-only `40458982198` on head `732f04f`; native binaries were not launched by compile-only.
- **PASS: 28, FAIL: 0, SKIP: 8** local Node tests after the AppContainer token SID and empty capability validation was added; PowerShell AST parse also passed.

No result here authorizes Codex launch. Runtime integration and all eight host-observed isolation scenarios remain blocked.

