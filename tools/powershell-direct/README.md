# PowerShell Direct — isolated local-approval channel

**Status: Draft hardening branch. Not deployed. No Work PC service or tunnel was started by these source changes.**

This project exposes three MCP tools:
- `powershell_propose` — create a pending fixed read-only task.
- `powershell_job` — inspect its state/result.
- `powershell_cancel` — cancel a pending task.

A proposal is never execution. Execution requires a separate local browser approval through the supervised local proxy. There is no arbitrary PowerShell, shell, approval MCP tool, Chat Read-only tool, or diagnostics tool.

## Approval sequence

1. ChatGPT shows the exact task, workspace and effect and asks for explicit permission to submit it.
2. After the user's affirmative response, `powershell_propose` creates a pending request with a SHA-256 fingerprint and 90-second expiry. It does not execute.
3. The operator opens the ephemeral `LOCAL_APPROVAL_URL` printed by the local supervisor. The URL contains a random, process-lifetime proxy nonce, not the service UI token.
4. The local proxy forwards only `GET /approve` and `POST /decide` to the loopback service. The UI bearer token remains in supervisor memory and is sent only as an Authorization header between local processes. It is not placed in a URL, HTML, tunnel environment, or ChatGPT payload.
5. The operator verifies task, workspace, command and SHA-256, then selects **Approve once** or **Deny**. ChatGPT can only poll or cancel via MCP; it cannot approve.
6. On supervisor shutdown, the proxy and its nonce become unavailable. Restart creates new in-memory tokens and a new proxy URL.

The approval proxy binds only to 127.0.0.1 on an ephemeral port. It accepts only the current random nonce path, rejects other paths and query strings, checks same-origin POSTs, limits request bodies, and forwards no UI credentials to the tunnel. The underlying MCP service remains on 127.0.0.1:17486.

## Server-enforced task allowlist

The service enforces the proposal allowlist itself; it does not rely only on MCP input-schema validation:

| Task ID | Fixed executable | Effect |
| --- | --- | --- |
| `powershell-version` | Windows PowerShell 5.1 | Read version |
| `git-status` | Fixed Git executable | Read repository status |
| `git-diff-check` | Fixed Git executable | Check diff whitespace |
| `dotnet-version` | Fixed .NET executable | Read SDK version |
| `node-version` | Fixed Node executable | Read Node.js version |

The server rejects additional runner policy entries unless they are explicitly added to `ALLOWED_PROPOSALS` and reviewed. Chrome Bridge peer, port, session, extension and tunnel diagnostics are not exposed through this service.

Executable paths are pinned in `runner.mjs`. Missing executables fail closed. No user-supplied command text or arguments are accepted.

## Supervisor behavior

`stack-supervisor.mjs`:
- starts the loopback service with Chat Read-only disabled (the service does not register that tool);
- creates the ephemeral approval proxy;
- starts only the named `powershell-direct-work` tunnel profile;
- passes only the MCP agent token as an explicit PowerShell Direct secret to the tunnel child;
- does not pass the local UI token to the tunnel child; the existing `CONTROL_PLANE_API_KEY` handoff is preserved pending verification that the tunnel client does not require it;
- does not print either bearer token;
- waits for the tunnel health endpoint before reporting `STACK_READY`;
- closes the proxy and service on shutdown.

The launcher retains its existing hidden prompt / environment handoff for `CONTROL_PLANE_API_KEY`. This branch does not rotate, rewrite, persist or otherwise change that credential. Whether the tunnel client truly requires it remains to be verified from the exact client build and profile contract before any attempt to remove it.

The local approval URL is a temporary capability for the current supervisor process. Keep it on the Work PC and do not paste it into chat, tickets, screenshots or GitHub. It is not a persistent DPAPI credential and is invalidated by stopping the supervisor.

## Read-only preflight

From the validation worktree:

```powershell
$root='C:/Engineering/ChromeBridge-PowerShell-Direct-Validation'
& "$root/tools/powershell-direct/Start-PowerShell-Direct-Stack.ps1" -Mode Check
```

`Check` performs syntax checks, unit tests and listener-owner inspection for ports 17486 and 18086. It does not stop processes or start services. It does not inspect or modify 17487, Production 17381/17382, PR102 Lab 17484, or other tunnel profiles.

## Cutover is a separate gated operation

The `Cutover` mode is not part of this hardening validation. It stops verified 17486/18086 owners before launching the replacement and does not yet provide a fully automated rollback if startup fails. Do not run it until a separate operator-approved cutover plan, exact Windows validation and rollback procedure are complete.

## Tests

Run on a disposable Windows development checkout with Node.js:

```powershell
node --check .\approval-proxy.mjs
node --check .\service.mjs
node --check .\stack-supervisor.mjs
node --test .\tests\service.test.mjs
```

Tests cover local approval, denial, immutable fingerprint, expiry, duplicate IDs, cancellation, MCP authentication, server-side task allowlisting, rejection of chat/diagnostic MCP tools, and the ephemeral proxy's nonce and same-origin behavior.

These tests do not prove a real tunnel connection or Work PC end-to-end operation. Those remain separate acceptance gates.

## Explicit isolation boundaries

Do not change Production Chrome Bridge 17381/17382, PR102 Lab 17484, RC1 17481, Codex, Chrome extensions, existing tunnel profiles, credentials or permissions as part of this work. Keep the private ChatGPT plugin permission at **Always ask**. Do not enable Chat Read-only, Full access or automatic approval.

**Current state: source-only hardening branch; no deployment, cutover or production readiness claim.**
