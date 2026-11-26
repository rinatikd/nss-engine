# PowerShell Direct — risk-reviewed, one-time local execution

**Status: development branch only. Not deployed. No Work PC service or tunnel was started by these source changes.**

## Operating model

This edition does not use a fixed task-ID allowlist. It accepts a general process request consisting of:
- an absolute executable path (local or UNC);
- an exact argument array (never a shell command string);
- an existing absolute working directory selected for this request;
- a purpose and preliminary risk assessment;
- a bounded timeout.

The assistant must assess the requested action before submitting it. The user confirms the proposed action in chat. The local approval page displays the exact executable, arguments, workspace, purpose, risk assessment, timeout, resolved executable path, executable-content SHA-256 and proposal SHA-256. At proposal time, the service resolves the executable path and hashes the file content in 1 MiB chunks (files over 1 GiB are rejected). The runner repeats the content hash immediately before dispatch and fails closed with `EXECUTABLE_IDENTITY_MISMATCH` if the resolved path or hash differs. The process is dispatched only after the operator selects **Approve once** locally. This narrows executable replacement risk but is not an atomic handle-based launch: a residual TOCTOU interval remains between final verification and Windows process creation.

This is deliberately capability-flexible, not an automatic trust system. No request is executed merely because it is syntactically valid or because ChatGPT submitted it.

## Execution boundary

- Uses `spawn(..., {shell:false})`; no shell interpolation by the service.
- Exact executable path and argument array are included in the immutable proposal fingerprint.
- Workspace is selected per request and must resolve to an existing absolute directory; it is not restricted to a fixed project root.
- No elevation is requested; the child runs with the supervisor's current Windows user privileges.
- Child environment is restricted to ordinary Windows runtime variables; control-plane and agent credentials are not passed to the executed process.
- Request queue, argument count/size, timeout and output size are bounded.
- Each request expires after 90 seconds and can be approved only once.
- A running process is not dispatched a second time by replaying an approval.
- The timeout and supervisor shutdown request termination of the direct child and wait for its `close` event. If the supervisor cannot confirm exit within the bounded shutdown window, it returns a non-zero result and reports the uncertainty. Process-tree cleanup is not guaranteed; do not assume descendants are stopped.
- This does not bypass Windows ACLs, UAC, application prompts or other OS authorization.

The assistant's risk assessment is advisory context, not a security verdict. The operator must inspect the actual command and arguments on the local approval page. For destructive, security-sensitive, credential, network, service, registry or production actions, the assistant should call out the exact scope and reversibility before requesting approval.

## Approval transport

The MCP endpoint and approval UI bind to loopback. A supervised ephemeral proxy exposes a random process-lifetime URL and forwards only the approval page and decision POST. The service UI bearer token remains in supervisor memory and is not placed in the URL, HTML, tunnel environment or MCP payload. The tunnel profile remains `powershell-direct-work`; the existing `CONTROL_PLANE_API_KEY` handoff is preserved pending independent verification of the tunnel client's contract.

Keep ChatGPT plugin permission at **Always ask**. Do not enable automatic approval or Chat Read-only. No production credentials, tunnel profile, Production Chrome Bridge 17381/17382, PR102 Lab 17484, or local Work PC service is changed by these source-only commits.

## Validation

On a disposable Windows development checkout with Node.js 24:

```powershell
node --check .\tools\powershell-direct\runner.mjs
node --check .\tools\powershell-direct\service.mjs
node --check .\tools\powershell-direct\approval-proxy.mjs
node --check .\tools\powershell-direct\stack-supervisor.mjs
node --test .\tools\powershell-direct\tests\service.test.mjs
```

Unit tests exercise the general proposal schema, immutable fingerprint, no execution before local approval, denial, one-time dispatch, expiry, working-directory validation, active-job cancellation on supervisor stop, local UI authentication, proxy nonce and MCP authentication. These tests do not establish Windows end-to-end acceptance, tunnel health, process-tree cleanup or production readiness.

## Not yet approved for cutover

Do not run the old Cutover launcher against this branch. Before any Windows deployment, separately review the launcher and rollback design, validate the exact tunnel-client behavior, test on a disposable Windows environment, inspect process-tree termination, and perform an operator-approved acceptance sequence. The legacy PR #172 remains Draft and is not the source branch for this work.
