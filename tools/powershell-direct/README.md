# Chrome Bridge — Direct PowerShell Channel (P0, Issue #107)

**Status: developer preview / Draft PR #108. Original two-step local-approval E2E passed on Windows; optional ChatGPT-only approval mode remains untested and disabled by default.**

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

## Isolating MCP from the local approval UI

**Never tunnel port 17486 directly.** It contains both the MCP endpoint and
the operator's private approval page (`/approve` and `/decide`).

The additional `mcp-only-gateway.mjs` module listens on loopback **17487**.
It forwards exclusively authenticated `POST /mcp` requests to 17486 and
returns 404 for everything else. In particular, `/approve`, `/decide`
and all other URLs are not exposed.

It requires TWO DIFFERENT secrets, set only in the local process environment:

- `PS_DIRECT_AGENT_TOKEN`: the bearer token printed by the already running
  17486 server. Supply locally; never publish.
- `PS_DIRECT_GATEWAY_TOKEN`: newly generated 64-hex bearer token for the
  external MCP client, never the same as the first token.

**This gateway is NOT a tunnel.** A separate, authenticated HTTPS tunnel and
private ChatGPT plugin are still needed. The gateway explicitly requires a
local loopback Host header and has no generic web endpoint. Tunnel settings
must preserve/rewrite the upstream Host to `127.0.0.1:17487`; if not,
connection deliberately fails closed.

The gateway contains no remote approval API. Its existence never bypasses
the two manual confirmations.

## Experimental ChatGPT-only approval (opt-in, fixed read-only tasks)

For operators who prefer confirming the tool invocation in ChatGPT instead of
opening the local approval page, a separate `powershell_chat_readonly` MCP tool
is available **only if** the Windows service starts with process environment
`PS_DIRECT_CHAT_READONLY_ENABLED=1`. Default is OFF. It supports the same five
pinned, read-only task IDs, fixed executable arguments, workspace checks and
output/time bounds. Arbitrary PowerShell and mutating commands remain forbidden.

Before opting in, set ChatGPT plugin **PowerShell Direct — Work PC** permission
to **Always ask** (never Full access). The user reviews the exact proposed
`task` and `workspace` in the ChatGPT approval prompt. A confirmed tool call
starts the fixed task immediately and returns a request ID; poll `powershell_job`
for the bounded result. There is **no additional local Approve once** in this mode.
The existing `powershell_propose` path retains its local approval requirement.

**Security distinction:** the local service cannot cryptographically distinguish
user approval from a tool call; it relies on ChatGPT's host UI and plugin permission
policy for this mode. A user message such as 'yes' is not proof of host approval,
and no client should assert otherwise. Do not enable this mode if remote chat-only
approval is insufficient for the machine's sensitivity. For writes, project changes,
credential operations, or new executable commands, keep the independent local
approval gate and perform a separate design/security review.

Enable the opt-in setting only in the environment of the **17486 service process**,
then restart that service and its separately authenticated stdio tunnel using fresh
random tokens. Confirm the new tool is discovered after plugin refresh; keep
production Chrome Bridge and the 17487 gateway unchanged. Roll back by removing
`PS_DIRECT_CHAT_READONLY_ENABLED` and restarting the service. Never expose the
local approval URL or bearer tokens through the tunnel or ChatGPT.

## Single-window Work PC stack (experimental)

The new `Start-PowerShell-Direct-Stack.ps1` works in two explicit stages
from the validation worktree. **No running process is stopped by Check.**

```powershell
$root='C:/Engineering/ChromeBridge-PowerShell-Direct-Validation'
& "$root/tools/powershell-direct/Start-PowerShell-Direct-Stack.ps1" -Mode Check
```

If Check passes, close unrelated terminal windows only after identifying their
functions. The supervisor can replace **only the verified** 17486 server and
18086 `powershell-direct-work` tunnel. It **never stops 17487**, production
Chrome Bridge, or other tunnel profiles. To opt in to this replacement:

```powershell
& "$root/tools/powershell-direct/Start-PowerShell-Direct-Stack.ps1" -Mode Cutover
```

Enter the existing control-plane runtime API key locally through the hidden
prompt (unless the current console already supplies `CONTROL_PLANE_API_KEY`).
The supervisor creates the PowerShell service and fresh MCP agent token in the
same Node process and passes the agent token to the child tunnel **only in process
environment**. It neither prints nor stores the token or local approval URL.
It validates that `powershell_chat_readonly` exists in the local MCP tool
registry before starting the child tunnel. Leave this one console running.

The ChatGPT permission for the private plugin **must remain Always ask**.
After cutover, reconnect/refresh the plugin's discovered tools, then confirm
the fourth tool is visible in ChatGPT. **A passing unit test does not prove
that ChatGPT will present an approval dialog**, nor does it prove the tunnel is
ready: verify 18086 health and an end-to-end test before claiming success.
If the new stack fails, the old server/tunnel will already have been stopped;
recovery requires restarting the old configuration with its own new tokens.
This launcher intentionally has no unattended auto-restart, no credential
persistence and no claim of production readiness.

## Release blockers

- Windows unit tests, service startup and end-to-end deny/approve/expiry/replay/missing-executable tests with an actual local operator.
- Adversarial security review of Windows child-process launching, workspace reparse points, Git configuration hooks, output masking and Windows process-tree cleanup. Current `child.kill` targets the direct child only.
- Durable replay journal across service restarts; right now request IDs are unique only per service lifetime. A restarted service uses new tokens and requires fresh pairing, but is **not** a complete cross-restart exactly-once guarantee.
- Output length bound and secrets redaction review, lost-connection behavior and clean rollback.
- Separate tunnel/plugin installation; ensure process remains inaccessible on external interfaces.

Keep production 17381/17382, RC1 17481, PR102 17484, Chrome profile and existing tunnels untouched until explicit review.

**NO-GO for uncontrolled shell, mutation commands and production use.**
