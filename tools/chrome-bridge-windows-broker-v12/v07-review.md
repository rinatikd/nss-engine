# v07 broker review and v0.9 design boundary

## Scope

Read-only review of `native/windows-runner-v07/broker.cpp`, `worker.c`, `ipc.mjs`, `server/codex-runtime.mjs`, `server/codex-policy.mjs`, and the related tests. The findings below are source observations; no v07 executable or Codex process was run.

## v07 observations

- `broker.cpp` is explicitly synthetic-only: it copies a sibling `worker.exe` into a disposable fixture and accepts only `echo`, `hold`, `crash`, or `flood`. It does not launch Codex.
- It requests an AppContainer with no capability SIDs, LPAC semantics, a restricted standard-handle list, a small environment, and a Job Object with kill-on-close, one active process, memory and CPU limits. It checks some properties by querying the child token and process image before resuming the worker.
- The protocol response includes `isolated:true` and `empty:true`, but those are values emitted by the broker itself. `ipc.mjs` checks their shape and request correlation; it does not authenticate the broker image or independently verify the claims.
- The v07 environment allowlist still passes `LOCALAPPDATA`; the inherited environment contract needs to be reduced and tested. The source does not provide negative probes for network access, credential/CODEX_HOME reads, workspace write access, or attempted child creation.
- Crash cleanup removes a synthetic AppContainer profile/fixture. That helper needs hostile PID/path/reparse/ACL tests and independent confirmation that handles and descendants are gone.
- `server/codex-policy.mjs` accepts a JavaScript `runner.verify()` callback and a `runner.launch()` callback. No concrete trusted implementation ties these callbacks to the native executable. `server/codex-runtime.mjs` rejects all policy-module candidates with `CODEX_ISOLATION_UNAVAILABLE`, so the candidate policy is not loadable.
- The checked-in `native/windows-runner-v07/build.ps1` is empty. The prebuilt EXEs/objects are local build outputs and are deliberately excluded from this source-only package.

## v0.9 contract

This stage defines strict JSON-only policy parsing, hash/signer pin comparisons, protected-ACL snapshot validation, a nonce-bound attestation shape, one-use challenge handling, and negative tests. It does not load executable policy code, call a broker, produce an authorization token, or wire into Bridge startup. Example pins are visibly placeholders and `enabled` is required to remain false.

The attestation contract is only a set of required fields and bindings. A complete mock fixture returns `contractShapeValid`, while explicitly returning `osIsolationProven:false` and `executionAuthorized:false`. Only a separately built and independently verified broker can produce evidence; a JSON response cannot prove its own truth.

## Required follow-up before any activation proposal

1. Implement a native verifier that pins broker and Codex file identities by SHA256 and verified Authenticode signer, rechecks identity immediately before launch, and rejects hardlinks/reparse paths and writable ancestors.
2. Protect data-only policy with a protected DACL; allow only the designated owner and SYSTEM full control and give the service read-only access. Check the actual ACL through native APIs, not a user-supplied JSON claim.
3. Bind a fresh random challenge to policy digest, broker digest, Codex digest, workspace ID/path identity, and request ID. Accept each challenge once, over an ACL-protected private IPC endpoint. Authenticate the broker independently before trusting the response.
4. Use a dedicated AppContainer/low-privilege token, zero network capabilities, no credential or user CODEX_HOME access, a read-only workspace, a minimal environment, explicit standard handles, child-process restriction, and a kill-on-close Job Object. Do not inherit LOCALAPPDATA or PATH by default.
5. Require separate local operator confirmation per job. Dangerous writes remain denied. A GitHub task/comment is never execution approval.
6. Run each skipped negative integration test in a disposable Windows VM with synthetic files and a synthetic credential marker. Observe actual token, ACL, process, handle, network and cleanup behavior independently. Do not use or read real credentials.

Until those steps pass, the active runtime gate remains closed. The user's permission to remove the gate is not evidence that the OS boundary is effective.
