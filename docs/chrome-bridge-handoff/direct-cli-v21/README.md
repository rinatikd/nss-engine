# ChatGPT chat → local Codex CLI: direct MCP prototype

This is a separate integration from Chrome Bridge. It runs as a local stdio MCP server and advertises only `codex_submit`, `codex_job`, and `codex_cancel`. It does not read Chrome Bridge credentials, tunnel settings, or its MCP proxy configuration.

## Safety state

Execution is deliberately hard-disabled in this prototype. Every valid tool call returns `CODEX_DISABLED`; it does not launch Codex CLI, create a job, or access a workspace. The managed executor cannot prepare the official Windows MXC sandbox (`native MXC is unavailable on this executor`). Do not change the guard until a host-local isolation runner has been independently verified for filesystem denial, network restrictions, process-tree cleanup, and credential/config isolation.

## Tunnel setup

1. In OpenAI Platform tunnel settings, create a Secure MCP Tunnel associated with the ChatGPT workspace you will use. This requires Platform Tunnels Read + Manage, and ChatGPT Developer Mode access. Keep the tunnel ID and runtime API key private.
2. A checksum-verified Windows amd64 `tunnel-client` v0.0.18 is included under `runtime`. For a fresh download, use the official [OpenAI release page](https://github.com/openai/tunnel-client/releases), then verify the release archive checksum/provenance before extracting it. The documented local flow is `tunnel-client help quickstart`. The original verified release ZIP is retained separately in the workspace, outside this setup package.
3. Open PowerShell in this folder and run:

   ```powershell
   .\Start-SecureTunnel.ps1 -Initialize -TunnelId 'YOUR_TUNNEL_ID'
   ```

   The script prompts for the runtime key using hidden input, sets it only in the child-process environment, initializes profile `chatgpt-local-codex`, runs `doctor`, then runs the tunnel. It does not write the key to disk or command arguments. On later runs, omit `-Initialize -TunnelId` and reuse the profile.
4. In ChatGPT web, add a custom MCP app in Developer Mode, choose Tunnel, select/paste the tunnel ID, and install it. Refresh discovery and confirm the three tool names appear. Workspace permission changes should be performed by the user/admin; this script does not change ChatGPT settings.
5. Test a valid tool call; expected response is `CODEX_DISABLED`. The local tunnel session remains foreground until Ctrl+C.

Never paste Platform runtime credentials into chat or place them in shell history. The script intentionally has no execution activation switch.

## Local protocol smoke check

Requires Node.js 20+. From this directory:

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | node .\src\server.mjs
```

## Current state

Transport prototype, checksum-verified tunnel client, and local setup script are prepared. The Secure MCP Tunnel is not provisioned or connected in this environment: no browser surface, Platform tunnel ID, or runtime credential was available. No local Codex command was executed, and no production service was changed. See `REPORT.md` for evidence and next steps.



