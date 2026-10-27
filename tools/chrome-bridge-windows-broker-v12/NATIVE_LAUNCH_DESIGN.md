# Native launch gate design — not an implementation

## Status

**BLOCKED.** This v0.11 package does not contain a compiled or callable launcher. The only native source inherited from v0.10 is the read-only image inspector; it does not call `CreateProcessW` or `ResumeThread`. No unsigned binary was built or run. A source-only event fixture checks the order below but cannot establish that Win32 calls work or enforce isolation.

## Required single-use launch transaction

The implementation must live in one reviewed native broker function. Do not split image verification and process creation across JavaScript code that accepts caller-supplied paths, signature objects, ACL JSON or “verified” booleans.

1. Parse a strict policy with an exact image SHA-256, signer-certificate SHA-256, normalized volume-GUID final path, owner SID, read-only workspace identities, and bounded limits. Reject zero/example pins. The pins must come from a separately reviewed test manifest.
2. `CreateFileW` the exact worker image with `FILE_FLAG_OPEN_REPARSE_POINT`, `GENERIC_READ|READ_CONTROL`, and a sharing mode that denies write and delete access. Keep the handle until the child exits. Reject directories, reparse points and `NumberOfLinks != 1`; query volume/file ID and final path on this handle.
3. Stream SHA-256 from that same handle; call `WinVerifyTrust` using `WINTRUST_FILE_INFO.hFile`; extract and pin the validated signer certificate hash; obtain owner and DACL with `GetSecurityInfo` on this handle. Reject null/unprotected DACLs, inherited/unknown ACEs, non-allowlisted SIDs, or write/delete/ACL-owner rights. Record only redacted, handle-bound evidence.
4. Create a fresh AppContainer profile with no capability SIDs. Prepare an explicit environment block and exactly three standard pipe handles. Initialize `STARTUPINFOEXW` and `PROC_THREAD_ATTRIBUTE_LIST` containing `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY`, and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. No arbitrary plugin, shell, command string, or caller-provided handles.
5. Create the Job Object first. Set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, active-process limit 1, memory and CPU caps; omit both breakaway flags. Create the fixed synthetic worker with `CreateProcessW`, explicit `lpApplicationName`, a fixed argv vector, the attributes above and `CREATE_SUSPENDED`. Never use `cmd.exe`, PowerShell, `ShellExecute`, or a mutable PATH lookup.
6. While the thread is still suspended, query the image path through the process handle. Open that OS-reported image read-only and compare volume/file ID, normalized final path, SHA-256 and signer with the still-open candidate handle. Query the child token/AppContainer SID/capabilities; query and confirm Job membership/limits; verify the explicit handle/environment contract. Any query failure is a denial.
7. Assign the suspended process to the Job before resume. If assignment fails, terminate the child, wait for process exit, close the Job and every handle, remove the fresh AppContainer profile and fixture directory, and return denial. Re-check the Job/process state after assignment.
8. Call `ResumeThread` only after all prior checks pass. Keep the candidate file handle and Job alive until a bounded wait ends. For timeout, cancel, malformed IPC, crash or any unexpected child, terminate the Job, wait until `ActiveProcesses == 0`, close every handle, remove temporary profile/workspace, and record a failure. There is no retry/fallback launch.

## Image identity and race conditions

The original file handle must remain open with write/delete sharing denied from before hashing/signature/ACL reads through the post-`CreateProcessW` image comparison and process termination. The process image path is obtained from the child process handle, then reopened and compared by volume/file ID with the locked candidate. String path equality alone is not sufficient. The filesystem must be recorded; if it does not honor the expected share semantics or file ID, return BLOCKED. Any DACL change/query race, identity mismatch, `CreateProcessW` failure, or Job assignment failure takes the rollback path; never resume.

This design still needs a Windows systems engineer to validate the exact share behavior, process image query, AppContainer attributes, Job semantics and filesystem assumptions on supported Windows versions. The synthetic JS trace tests in this package do not substitute for that review.

## Mock fixture event contract

`tests/launch-trace.test.mjs` validates only a fixture event trace:

`candidateHandleOpened → hashSignerAclPinsVerified → createProcessSuspended → childImageFileIdAndHashMatched → appContainerTokenAndCapabilitiesMatched → jobAssignedWithBreakawayDisabled → explicitHandleListAndEnvironmentMatched → resumeThread`

Negative fixtures require denial and rollback. Once a child exists, rollback is exactly terminate → wait exit → close Job → close handles → deny. A bad image ID, an AppContainer mismatch, a missing explicit handle list, Job assignment failure, or any unexpected state must never reach `resumeThread`. These are model tests with synthetic input only; no native API is called.

## What is still missing

- No implementation of `CreateProcessW(CREATE_SUSPENDED)`, process-image handle verification, or guarded `ResumeThread`.
- No signed broker or trusted test certificate/pin chain.
- No trusted native IPC/provider that can give `policy.mjs` authenticated handle-derived signer/ACL evidence. v0.11 therefore rejects caller JSON and fails closed with `NATIVE_HANDLE_VERIFIER_NOT_LINKED` / `NATIVE_HANDLE_ACL_PROVIDER_REQUIRED`.
- No independently observed Windows VM probe has passed.
