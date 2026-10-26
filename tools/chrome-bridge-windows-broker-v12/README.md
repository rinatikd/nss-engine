# Windows Broker v0.12 — test-only native prototype

**Status: PARTIAL / BLOCKED.** This proposal adds a test-only native suspended-launch prototype and a synthetic worker. It is not a production broker. The native sources have not been compiled or run; the local machine has no `cl.exe`, `clang-cl.exe`, `clang++.exe` or `g++.exe`. No approved disposable VM/controller is available, so the eight OS probes were not executed.

## Safety boundaries

- The launcher accepts no command-line arguments. By default, it fails with `TEST_PINS_HEADER_MISSING`. It also requires a generated disposable-VM-only pin header and a separate compile-time flag.
- It is intended only for an ephemeral signed synthetic worker, never Codex or any real provider CLI. No generated pins, cert, synthetic credentials, or executable are included.
- Worker environment is explicitly rebuilt. Only created pipe handles are put in `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.
- Image SHA256 and Authenticode leaf cert SHA256 are checked against test pins from an open handle. The handle is opened with read-only sharing and held through suspended-process creation and recheck. Child image path is reopened and volume/file ID compared before resume.
- `CREATE_SUSPENDED`, AppContainer security capabilities, LPAC all-packages opt-out, Job Object limit/kill-on-close/no-breakaway, pre-resume job/image checks and rollback are present in source. These source claims are unverified until a native build and independent VM observation.
- `Prepare-DisposablePins.ps1` writes generated headers only after a signed worker passes Authenticode validation. Do not commit generated headers or use production certificates.
- No production, credentials, tunnel, active CODEX_HOME, or CODEX_DISABLED settings were accessed or changed. No native binary was built or launched.

## Source-only checks

From this folder:

```powershell
node --check .\policy.mjs
node --check .\launch-trace.mjs
node --test .\tests\policy.test.mjs .\tests\launch-trace.test.mjs .\tests\native-inspector.test.mjs .\tests\native-launcher-contract.test.mjs .\tests\package-gates.test.mjs .\tests\windows-integration.test.mjs
```

Local result: **27 PASS, 0 FAIL, 8 SKIP**. The eight `windows-integration` tests remain **BLOCKED**. The new native contract tests inspect source text only.

## Native build

`tests/build-native.ps1` is compile-only and deletes its temporary output. It was **not run**: no C++ compiler is installed in this session. See [VM_EXECUTION_RUNBOOK.md](VM_EXECUTION_RUNBOOK.md) for the exact future disposable-VM setup sequence and missing gate.

## Known blockers and decision

- **BLOCKED:** compile validity, Wintrust helper ABI/version behavior, exact image-section identity through `CreateProcessW`, LPAC token observation, real Job/handle/environment checks, and all Windows isolation evidence.
- **BLOCKED:** independent host/controller executable is not implemented.
- **BLOCKED:** deterministic crash pause points and controller recovery for probe 8 are absent. Normal RAII/Job close is not crash-test evidence.
- **NO-GO:** do not enable the probe compile flag, run the launcher, run any Codex CLI, dispatch native CI, or perform production cutover.

See [API_REFERENCES.md](API_REFERENCES.md), [VM_TEST_PLAN.md](VM_TEST_PLAN.md), and [VM_EXECUTION_RUNBOOK.md](VM_EXECUTION_RUNBOOK.md). The manual GitHub workflow only runs source-level tests and is not an OS isolation test.
