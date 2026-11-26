# Windows process-tree lifecycle design

Status: native proof-of-concept implemented and Windows CI smoke-tested; production N-API integration is not implemented or validated.

## Problem

The current Node runner uses `child.kill()` for cancellation and timeout. The supervisor also kills only the direct tunnel-client child. Neither operation proves that descendants have exited. A process can spawn descendants before a parent-only termination completes.

## Required launch invariant

A process must not execute user-supplied work until it is assigned to a dedicated Windows Job Object. Starting a process normally and assigning it afterward is not sufficient: the child can create descendants in the interval before assignment.

The implementation must therefore use a Windows-native launcher that:

1. Creates a private Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
2. Creates the requested process suspended (`CREATE_SUSPENDED`).
3. Assigns the suspended process to the Job Object.
4. Resumes its primary thread only after assignment succeeds.
5. Owns the Job Object handle for the entire process lifetime.
6. On cancellation, timeout, or launcher shutdown, calls `TerminateJobObject` (or closes the final job handle) and waits for job completion, not merely the root process exit.
7. Reports a distinct failure if job creation, assignment, termination, or completion confirmation fails.

The native launcher must preserve the current contract: exact executable path and argument vector, selected working directory, non-elevated current-user token, bounded stdout/stderr, bounded execution time, and no inherited agent/UI/control-plane credentials.

## Why not taskkill /T

A PID-tree walk followed by termination is not an equivalent ownership primitive. The tree can change while it is enumerated, and PID-based termination does not provide the same lifetime-bound association as a Job Object. Do not add `taskkill /T /F` as a fallback.

## Nested jobs and compatibility

The launcher must detect and report assignment failures. The host process may already belong to a Job Object (for example, CI or managed desktop environments). Nested-job behavior depends on Windows version and parent-job policy. Do not silently fall back to uncontained execution when assignment fails.

## Test requirements

Windows CI and disposable Windows smoke tests must cover:

- successful launch and exit code/stdout/stderr forwarding;
- a child that spawns a grandchild, followed by cancellation;
- timeout with a grandchild still running;
- launcher crash/forced close with kill-on-close behavior;
- assignment failure while the host is already in an incompatible job;
- repeated cancel/timeout/shutdown calls;
- no false `PROCESS_TREE_EXIT_CONFIRMED` until the Job Object reports completion;
- bounded shutdown and no orphaned descendants.

Tests must use uniquely identified disposable child processes and verify their actual exit, not infer it from the launcher PID.

## Release gate

Until the native launcher and Windows tests exist, process-tree termination remains unconfirmed. The current `child.kill()` implementation is not to be described as process-tree safe. No production cutover, plugin permission change, tunnel change, or deployment is authorized by this design note.

## Refined implementation decision (2026-11-26)

A separate short-lived launcher executable is not the preferred owner of process creation. It introduces another process boundary and another failure interval around process creation. The preferred prototype is an N-API native module loaded by the long-lived PowerShell Direct Node service. The service process itself will own the Job Object and process/thread handles for each approved execution.

### Creation API

On supported Windows versions, evaluate `STARTUPINFOEX` with `PROC_THREAD_ATTRIBUTE_JOB_LIST` and `CreateProcessW`. Microsoft documents this attribute as assigning the listed jobs to the child during process creation; support begins with Windows 10 / Windows Server 2016. Keep the attribute list and its backing job-handle array alive until the attribute list is destroyed. Do not silently fall back to post-creation assignment.

If the supported deployment baseline or host-job nesting rules prevent creation-time assignment, fail closed. The implementation must not create an uncontained process as a fallback.

### Important contract limitation

The public Win32 API documentation does not fully specify all outcomes if the creating process itself is terminated while `CreateProcessW` is still in progress. Do not claim a transactional all-or-nothing guarantee for that interruption scenario. The native module reduces the extra launcher boundary and keeps creation and Job ownership in the long-lived service, but this specific OS-level interruption case remains a documented uncertainty unless Microsoft provides an authoritative clarification.

### N-API lifecycle contract

The native module API must be asynchronous and expose an opaque execution handle:
- `start(spec)` creates the process and returns a stable operation handle only after successful creation and Job association;
- `wait(handle)` resolves only after the root process exit and the Job Object reports no active processes;
- `terminate(handle, reason)` terminates the Job Object and waits for confirmed job completion;
- `close(handle)` releases process, thread, job, and completion resources exactly once;
- duplicate terminate/close calls are idempotent;
- all Win32 failures include operation name and captured `GetLastError()` code;
- module unload/service shutdown must terminate and drain every active job before releasing handles.

No breakaway flags are enabled on the per-execution Job. Descendants created through normal process creation should remain members of the job. This can affect applications that attempt to create their own Job Object; test this explicitly and fail/report rather than weakening containment.

### Additional test gates

- supported Windows baseline and `PROC_THREAD_ATTRIBUTE_JOB_LIST` availability;
- host already inside a parent Job, including nested-job acceptance/rejection;
- native module loaded/unloaded repeatedly without leaked handles;
- service cancellation during process creation, immediately after creation, and during descendant creation;
- forced service termination during native creation (record observed behavior; do not infer an undocumented guarantee);
- Job completion confirmation after root exit while a grandchild remains alive;
- child attempting breakaway or nested Job assignment;
- stdout/stderr pipe closure only after all associated writers have exited;
- architecture/build matrix (x64 first; ARM64 only if explicitly supported).

The first deliverable is now present: `native/job-object-poc.cpp` plus a `windows-latest` MSVC compile/run job. On 2026-11-26, the Windows Job Object proof-of-concept and Node.js checks passed in GitHub Actions. The smoke test demonstrates creation-time Job assignment, descendant retention after root exit, and confirmed `TerminateJobObject` completion. It does not yet test stdout/stderr, timeout/cancel races, kill-on-close after service crash, incompatible parent jobs, N-API memory ownership, or the production service. Do not wire it into production dispatch until those additional tests pass and the N-API boundary, memory ownership, cancellation races, and handle lifetime have been reviewed.
