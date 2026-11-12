# Windows Job Object supervisor — required implementation contract (LAB ONLY)

Status: **NOT IMPLEMENTED / NO-GO**. This is a specification, not evidence of process containment.

## Mandatory native sequence

1. Validate the Codex executable's absolute local path and workspace, and obtain explicit local-console authorization.
2. Create a Windows Job Object with `CreateJobObjectW`; configure `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` via `SetInformationJobObject`.
3. Create anonymous stdin/stdout/stderr pipes with inheritable child ends and non-inheritable parent ends; prevent unintended handle inheritance.
4. Use `CreateProcessW` with `CREATE_SUSPENDED`, `STARTF_USESTDHANDLES`, an explicit executable path, a correctly quoted argument string, and an explicit working directory. Never use a shell.
5. Before calling `ResumeThread`, assign the suspended process to the Job Object using `AssignProcessToJobObject`. If assignment fails, terminate the suspended process, close all handles and report failure; **never resume uncontained**.
6. Resume the thread and expose a Node-compatible child facade with `pid`, `stdin`, `stdout`, `stderr`, `once('close')`, `on('error')`. A native helper may use a framed IPC protocol; do not fake process close.
7. On cancellation, timeout, output limit or shutdown, call `TerminateJobObject`, wait for job membership to become empty (e.g. `QueryInformationJobObject` with `JobObjectBasicAccountingInformation` and bounded polling), then close handles. If verification fails, report `TREE_KILL_UNCONFIRMED` and block subsequent jobs.
8. On normal parent exit, **still** verify the job contains no descendants; if descendants remain, terminate the job and verify empty before success.
9. Limit stdout/stderr buffers, terminate on client disconnect, redact prompts and secrets from audit logs, and ensure all resources are closed on failures.
10. Do not accept the supervisor implementation, executable, shell arguments or privileged flags from MCP request parameters. Only locally configured and reviewed binaries may implement this contract.

## Important limitations

Windows Job Objects do not establish a security sandbox or privilege boundary. The requested Codex `danger-full-access` mode can modify any resource accessible to the current Windows user. The administrative gate must be temporary, local-console approved and **lab-only**. A process already running outside the job or a detached process created before assignment is not contained. If Windows rejects assignment because of incompatible existing jobs, fail closed.

## Required Windows E2E gates

- Successful Codex invocation returns valid JSONL agent response.
- Two simultaneous requests with the same ID cause one launch only.
- Local operator rejects session or job: zero launches.
- Abort during native suspended launch: zero resumed uncontained processes.
- Cancel while Codex has spawned a descendant: both parent and descendant exit.
- Normal parent exit with surviving descendant: descendant is terminated before job completes.
- Native assignment failure: child is never resumed.
- Kill failure / verification timeout: future jobs blocked.
- Server crash / restart: `KILL_ON_JOB_CLOSE` terminates descendants.
- Confirm no changes to production ports 17381/17382, credentials or tunnel.

Run tests on isolated Windows lab with actual Codex executable. Do not mark PASS based on mocked or Linux tests.
