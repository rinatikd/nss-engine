# v0.12 disposable VM execution runbook

**Status: BLOCKED; these commands are a future acceptance procedure, not evidence of execution.** Use only a fresh disposable Windows VM, never this workstation. This package has no generated test pins or independent observer executable. The native source has not been compiled, so the sequence must first pass independent C++ source review and compilation.

## Source-only validation (safe on the development checkout)

From the package root in PowerShell:

```powershell
node --check .\policy.mjs
node --check .\launch-trace.mjs
node --test .\tests\policy.test.mjs .\tests\launch-trace.test.mjs .\tests\native-inspector.test.mjs .\tests\native-launcher-contract.test.mjs .\tests\package-gates.test.mjs .\tests\windows-integration.test.mjs
```

These are JavaScript/source assertions only. They do not compile C++ or run a native process.

## Native compile-only check

Run from Visual Studio Developer PowerShell in a disposable VM:

```powershell
Set-Location C:\cb-v12\tools\chrome-bridge-windows-broker-v12
& .\tests\build-native.ps1
```

The script compiles into a fresh `%TEMP%` subdirectory, deletes it afterward and never executes either output. If `cl.exe` is unavailable, record **BLOCKED**, not PASS.

## Synthetic fixture preparation (not yet cleared to run)

The future VM operator must create an ephemeral code-signing certificate in that VM, trust it only in the disposable user's certificate stores, compile `synthetic_worker.cpp`, and sign only that synthetic image. The private key and trust-store changes must be deleted when the VM snapshot is discarded. Create a synthetic credential canary outside the worker workspace with random contents and confirm its path is not a real profile/credential path. Start a controller-owned loopback listener on a dedicated port. Do not use external hosts or real credentials.

Before compiling the worker, generate only its synthetic probe pins:

```powershell
& .\tests\Write-WorkerTestPins.ps1 `
  -SyntheticCredentialPath C:\cb-v12\fixtures\fake-secret.bin `
  -LoopbackPort 47231 `
  -OperatorConfirmedDisposableVm
```

Then compile `native\synthetic_worker.cpp` to `C:\cb-v12\fixtures\synthetic_worker.exe` and sign only that image with the ephemeral VM certificate. After signing, generate the launcher pins:

```powershell
& .\tests\Prepare-DisposablePins.ps1 `
  -WorkerPath C:\cb-v12\fixtures\synthetic_worker.exe `
  -SignerThumbprint '<ephemeral VM certificate thumbprint>' `
  -SyntheticCredentialPath C:\cb-v12\fixtures\fake-secret.bin `
  -LoopbackPort 47231 `
  -OperatorConfirmedDisposableVm
```

`Write-WorkerTestPins.ps1` writes `native\worker_test_pins.h`; `Prepare-DisposablePins.ps1` writes `native\test_pins.h` only. The latter refuses invalid Authenticode status and pins the present worker bytes/certificate. Treat generated headers as disposable, untrusted test inputs; never commit them or use production signing material.

## Required gate before a probe launch

There is currently **no approved launch command**. Before one can be published, the project needs all of the following on the exact PR SHA:

1. Successful native compile of launcher and synthetic worker, with build logs and compiler/SDK versions.
2. Independent review of `test_launcher.cpp`, including file-handle sharing behavior, Wintrust signer extraction, final-path/FILE_ID matching, AppContainer/LPAC policy, Job-list semantics, environment block, HANDLE_LIST and every cleanup branch.
3. A controller-side observer executable/script outside the broker sandbox. It must gather token/capability data, process image file ID/hash, Job limits/membership, actual inherited handles and environment, ACLs, descendant process table, network-listener evidence and cleanup. Broker/worker output is never accepted as primary evidence.
4. A host-approved disposable VM and separately approved one-shot execution plan. No workflow is automatically dispatched by this package.

The current launcher entry point is deliberately gated on both generated pins and `CHROME_BRIDGE_V12_DISPOSABLE_VM_BUILD`, but that compile flag is not itself authorization or proof of a VM. Do not define it or run the executable until the separate gate is satisfied.

## Eight scenarios and exact observer evidence

1. **AppContainer/LPAC:** controller opens the worker token before resume; record `TokenIsAppContainer`, AppContainer SID, capability SID count and an OS-observed LPAC indicator. Confirm the synthetic canary is denied. Unsupported LPAC observation is BLOCKED.
2. **Job containment:** controller queries `JobObjectExtendedLimitInformation`, `IsProcessInJob`, active process count and kill-on-close/breakaway bits; close the job only in the dedicated hold subcase, then verify process exit and zero members.
3. **File/ACL race:** use a disposable candidate copy and file-ID-bound observer; concurrently attempt write/delete/rename/reparse and hardlink aliases while the candidate handle is open. Record each Win32 return code and pre/post volume serial + FILE_ID_INFO. All unsafe candidates must be denied before resume.
4. **Inherited handles/environment:** controller compares child handle table against the exact three pipe handles and reads the child's environment through a host-side process inspector. Seed only harmless sentinel variables in the parent; confirm they are absent.
5. **Network:** controller listener logs accepted connections on `127.0.0.1:47231`; the worker's failed connect alone is insufficient. Record Winsock error plus listener event log and a separate controller connectivity control.
6. **Synthetic credentials:** controller records fake canary file ID, hash, and DACL before and after; worker must get `ERROR_ACCESS_DENIED`; controller verifies no read access and unchanged file hash. Missing canary is FAIL/BLOCKED, never a successful denial.
7. **Child escape:** worker attempts only its own pinned image with fixed `--child` args while suspended; controller records process-create events and enumerates Job/process tree until empty. Any child or escape is FAIL.
8. **Crash cleanup:** **not executable with the current source.** There are no deterministic controller pause points/worker hold mode or external cleanup agent yet. Add those in a reviewed follow-up before any crash/kill trial. Do not infer crash cleanup from normal RAII or Job kill-on-close.

For each scenario the controller must write a signed, SHA-pinned manifest containing case ID, PR source SHA, image hashes, Windows build, API results, timestamps, evidence hashes, rollback actions and residual-process/workspace inventory. A broker-generated JSON report is secondary only. Missing data, ambiguous errors or cleanup failure is BLOCKED/FAIL.


