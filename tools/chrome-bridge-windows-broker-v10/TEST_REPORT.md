# Windows Broker v0.10 test report

Date: 2026-10-26 (Asia/Qyzylorda)

## Evidence and exact source revision

This report is part of the staged v0.10 source package. The authoritative tested revision is the exact commit recorded by the `Windows Broker v0.10 source checks` GitHub Actions run. That workflow writes `GITHUB_SHA` into the run's step summary after source checks and native compilation. The commit SHA is not hardcoded into this tracked file because changing this file to include the resulting commit SHA would itself create a different commit. The PR head and matching CI run summary must agree before accepting the report.

## Local source-only validation

- **PASS: 16** Node tests, including four new source contract tests for handle-bound hashing, Authenticode, final-path/file identity, native ACL evidence, fail-closed behavior, path redaction and absence of process creation APIs.
- **PASS:** `node --check policy.mjs`.
- **FAIL: 0** in the final local run.
- **SKIP: 8** existing Windows OS integration probes. They are explicit skips; no OS isolation claim is made.
- **BLOCKED: 8** actual isolation claims: AppContainer token/capabilities, Job Object kill-on-close, ACL and path race under adversarial mutation, inherited handles/environment, network denial, credential/CODEX_HOME denial, child-process containment, and crash cleanup.

## Windows CI native validation

The workflow compiles `native/image_inspector.cpp` with MSVC and runs a synthetic unsigned file with deliberately wrong all-zero hash and signer pins. The expected result is a JSON diagnostic with `authenticodeTrusted:false`, `sha256PinMatches:false`, `executionAuthorized:false`, and exit code 10. This only tests compilation and negative rejection on the CI host; it is not a positive Authenticode pin validation and not a VM isolation test. Record the workflow conclusion and exact commit SHA before treating these checks as PASS.

The current local environment has no discoverable `cl.exe`, `clang-cl.exe`, or `g++.exe`; therefore the native compile/negative probe has **SKIP locally** and is **BLOCKED pending successful Windows CI**.

## Review findings addressed

1. SHA256 is computed by streaming bytes from the open candidate handle; Authenticode receives that same handle in `WINTRUST_FILE_INFO.hFile`, and the signer certificate DER SHA256 is compared with a separate pin.
2. The candidate is opened without write/delete sharing and with `FILE_FLAG_OPEN_REPARSE_POINT`; reparse points and multiple hardlinks are rejected. Final normalized volume-GUID path is read from the handle and compared with an expected final-path pin. The path is never emitted in JSON.
3. Owner and DACL are obtained through `GetSecurityInfo` for the open file handle. The inspector requires a protected DACL and narrowly allows explicit ACEs for the pinned owner and LocalSystem, with write/delete/ACL/ownership rights denied.
4. `policy.mjs` remains non-activating. Native inspector contains no process-creation capability and emits `executionAuthorized:false`. A disposable Windows VM and independent host observations are still required before any future execution implementation.
5. The Windows Actions run summary records the exact commit SHA that was checked out and tested.

## Limits and decision

- **BLOCKED:** no independent disposable-VM test evidence; no real signed broker release or trusted release pin source; no positive signed-image test fixture.
- **BLOCKED:** this inspector does not solve the later create-process/resume identity race. It is not a broker launcher and must not be wired to Codex.
- **BLOCKED:** `GetSecurityInfo` may fail during concurrent security descriptor changes. This stage treats the inspection as diagnostic only and never launches based on it.
- **NO-GO:** no production cutover, runtime wiring, Codex execution, credential access, or change to `CODEX_DISABLED` is authorized by these results.
