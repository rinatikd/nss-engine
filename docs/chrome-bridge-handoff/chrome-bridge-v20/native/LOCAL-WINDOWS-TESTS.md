# Local Windows Job Object smoke tests

These tests replace the **native smoke portion** of the blocked GitHub Actions job. They do not establish full Chrome Bridge / Codex CLI E2E readiness.

## Prerequisites

- Windows 10/11 x64
- Visual Studio 2022/2026 with **Desktop development with C++** (MSVC x64 compiler and Windows SDK)
- PowerShell 5.1+; no elevated shell required
- Both files in the same directory: `job-object-smoke.cpp` and `Run-JobObjectLocalTests.ps1`

## Run

From a checkout of branch `feature/codex-temporary-admin-gate-20261112`:

```powershell
cd docs\chrome-bridge-handoff\chrome-bridge-v20\native
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-JobObjectLocalTests.ps1
```

The script locates MSVC via `vswhere`, compiles into `%TEMP%\chrome-bridge-job-object-smoke`, and runs three tests: normal exit, kill-on-close, and contained stdin/stdout echo. Each test invocation is bounded to 15 seconds by the launcher; failures produce a nonzero PowerShell exit. A machine-readable report is written to `%TEMP%\chrome-bridge-job-object-smoke\results.json`.

The tests do **not** run Codex, connect to ChatGPT/MCP, modify production ports 17381/17382, touch tokens or tunnel configuration, or require GitHub billing.

## Limitations and safety

- Run only trusted repository code; the runner invokes the native executable with the current user's privileges.
- This is not an operating-system security sandbox and not an authorization to run untrusted prompts.
- A failed test may leave a child process if process-tree termination itself fails. Inspect the report and process list.
- Real Codex execution remains disabled until the native supervisor, cancellation, audit, and Windows E2E gates are complete.
- Share `results.json` and the console output for diagnosis; review output for local paths before sharing.
