# IPC v1.5.6 — Final lab acceptance and release decision

## Scope
Windows self-only native Job Object supervisor and restart gate in PR #103. The tests never execute Codex CLI, change production Chrome Bridge ports 17381/17382, tokens, credentials, or tunnel.

## Final command
From `docs/chrome-bridge-handoff/chrome-bridge-v20`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native\Run-FinalLabAcceptance.ps1
```

Expected: `IPC_FINAL_LAB_ACCEPTANCE_PASS: 4/4 suites; 19/19 assertions`.

The suite checks: 7 model assertions; 3 native gated launch/release assertions; 5 crash/race assertions including direct child handle; 4 crash-tree assertions including all pre-crash captured job member handles. Test results require actual operator Windows execution. Previous individual suites were reported PASS, but this combined suite is not yet verified.

## Release decision
- **GO**: isolated, self-only laboratory proof and diagnostics, after the final suite passes.
- **NO-GO**: production recovery, real Codex CLI execution, automatic stale-marker removal, and general-purpose process launch.

## Why production recovery remains blocked
The current supervisor creates an unnamed Job Object. After controller death a new process cannot reliably reopen that same Job Object to prove its membership is empty. A PID is reusable and a process snapshot is not atomic. No amount of successful pre-crash handle checks alone makes later automatic marker deletion safe.

## Requirements before production recovery
1. Establish a secure, durable, uniquely identifiable job/recovery protocol with explicit ownership and restricted access; prove no stale/foreign handle can keep the job alive.
2. Prevent launch-versus-recovery races with OS-backed exclusive reservation and generation identifiers.
3. Independently prove old controller termination and zero live members, including late-created descendants, without relying solely on PID snapshots.
4. Preserve the marker and deny launch on timeout, access denial, corrupt state, partial writes, or uncertainty.
5. Add crash injection and negative tests for those cases, security review, and explicit operator authorization before any production integration.

**No automatic recovery is implemented in v1.5.6.** The safe default is fail-closed. Deleting a persistent marker is not a recovery procedure.
