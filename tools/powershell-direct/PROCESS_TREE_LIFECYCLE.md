# Windows process-tree lifecycle design

Status: proposed for implementation; not yet implemented or Windows-validated.

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
