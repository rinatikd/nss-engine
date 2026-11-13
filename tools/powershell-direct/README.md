# Chrome Bridge — Direct PowerShell Channel (P0, Issue #107)

**Status: developer preview / Draft PR #108. Not installed, not E2E-approved.**

A dedicated local Windows command executor that needs **no Codex CLI**. It exposes three MCP tools, `powershell_propose`, `powershell_job` and `powershell_cancel`, while actual execution is controlled by a separately authenticated, local-only **Approve once / Deny** browser form. It does not accept arbitrary PowerShell text or scripts.

## Authorization — two layers

1. The assistant shows the **exact task**, target directory and effects in ChatGPT and asks the user **«Отправить команду на исполнение?»**. Before affirmative consent, do **not** call `powershell_propose`.
2. `powershell_propose` creates a pending job in the local service and returns a SHA-256 fingerprint and expiry. It never executes the job.
3. The user opens the private LOCAL_APPROVAL_URL printed in the service's Windows terminal, inspects the exact command, workspace and fingerprint and clicks **Approve once** or **Deny**. A yes in ChatGPT must **not** substitute for local approval.
4. ChatGPT polls `powershell_job` or cancels an unstarted request with `powershell_cancel`; it does **not** re-submit an ambiguous or expired job.

The service binds to `127.0.0.1:17486` and has separate random secrets for the remote MCP client and the local approval page. There is **no generic MCP execute or approval tool**; `powershell_cancel` only cancels pending work. Mutations and arbitrary scripts are unsupported in v1.

## Allowed tasks

| Task ID | Fixed executable | Effect |
| --- | --- | --- |
| `powershell-version` | Windows PowerShell 5.1 executable | Read PowerShell version |
| `git-status` | Fixed Git executable | Read repository status |
| `git-diff-check` | Fixed Git executable | Check diff whitespace |
| `dotnet-version` | Fixed .NET executable | Read SDK version |
| `node-version` | Fixed Node executable | Read Node.js version |

Executable paths are pinned to `C:\Program Files\Git\cmd\git.exe`, `C:\Program Files\dotnet\dotnet.exe`, `C:\Program Files\nodejs\node.exe`, and `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`. Missing executables fail closed; users may have to review and update the allowlist for their installation.

No command accepts user-supplied arguments, redirects, pipes, an arbitrary `-Command` script, or `Invoke-Expression`. Scripts from GitHub cannot execute merely because they appear in a chat.

## Setup on Windows — isolated developer test

Use a CLEAN clone of branch `agent/chatgpt/powershell-approval-channel-20261113` from `rinatikd/nss-engine`. In a terminal, go to `tools/powershell-direct`. First run:

```powershell
node --version
node --test .\tests\service.test.mjs
```

Run the earlier contract tests separately from `docs/chrome-bridge-handoff/chrome-bridge-v20`:

```powershell
node --test .\tests\powershell-approval-contract.test.mjs
```

Only after all tests pass, choose an EXISTING, non-system folder that contains no secrets and restricts execution to intended project directories. Example:

```powershell
node .\service.mjs "C:\Engineering"
```

The server prints `PS_LAB_READY`, a private `LOCAL_APPROVAL_URL`, and `MCP_AGENT_TOKEN`. **Never paste either secret into chat, GitHub, screenshots or a public log.** The UI URL can be opened locally by the operator only; its capability-bearing secret appears in the local Windows terminal.

The process runs in the foreground. Closing that terminal stops the service. It never automatically installs anything, edits Chrome, changes browser tokens or starts Codex CLI.

## Attaching ChatGPT after approval and testing

The optional `mcp-stdio.mjs` adapter reads `PS_DIRECT_AGENT_TOKEN` from its own local environment and forwards MCP JSON-RPC requests to this service via loopback. It does not accept remote approval events. Use **a separate private tunnel and a separate ChatGPT plugin**, not the existing PR102 or production tunnel, to expose this adapter. Rotating/restarting the service changes both secrets, and the adapter must be reconfigured.

No tunnel or plugin has been created as part of this PR. ChatGPT will NOT see `powershell_propose` or `powershell_job` until an operator sets up and connects that new plugin.

## Release blockers

- Windows unit tests, service startup and end-to-end deny/approve/expiry/replay/missing-executable tests with an actual local operator.
- Adversarial security review of Windows child-process launching, workspace reparse points, Git configuration hooks, output masking and Windows process-tree cleanup. Current `child.kill` targets the direct child only.
- Durable replay journal across service restarts; right now request IDs are unique only per service lifetime. A restarted service uses new tokens and requires fresh pairing, but is **not** a complete cross-restart exactly-once guarantee.
- Output length bound and secrets redaction review, lost-connection behavior and clean rollback.
- Separate tunnel/plugin installation; ensure process remains inaccessible on external interfaces.

Keep production 17381/17382, RC1 17481, PR102 17484, Chrome profile and existing tunnels untouched until explicit review.

**NO-GO for uncontrolled shell, mutation commands and production use.**
