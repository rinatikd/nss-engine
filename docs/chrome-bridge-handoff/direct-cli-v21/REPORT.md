# Direct ChatGPT → local Codex CLI tunnel setup report

Date: 2026-10-26
Workspace: `C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21`

## Status

**Local tunnel client and launcher prepared; Platform/ChatGPT connection remains BLOCKED on account-side setup.** This is a separate route from Chrome Bridge. The route is ChatGPT Developer Mode MCP app → OpenAI Secure MCP Tunnel → local stdio MCP server. No Chrome Bridge endpoint or credentials are used.

## Completed locally

- Downloaded official OpenAI `tunnel-client` release `v0.0.18` Windows amd64 bundle into `runtime/`; the extracted `tunnel-client.exe` is included in the setup ZIP.
- Verified the downloaded ZIP SHA256 against the release's official `SHA256SUMS.txt`: `8d0da1ce79532d44ccc5ed5d8bd36cdfffba37dfd287c602d69635c8bb5db2b2` (match).
- Extracted `tunnel-client.exe`; `tunnel-client help quickstart` confirms `sample_mcp_stdio_local`, `tunnel-client init`, `doctor`, and `run` are supported.
- Added `Start-SecureTunnel.ps1`. It accepts a tunnel ID on first initialization, prompts for the runtime key as hidden input, supplies it only through the process environment, restores the caller's prior environment on exit, uses loopback ephemeral health binding, and starts the daemon in the foreground. It never places the key in a command-line argument or log file.
- PowerShell parser check for the launcher: PASS.
- MCP local smoke behavior remains as documented in `src/server.mjs`: exactly three tools are advertised; every valid tool call returns `CODEX_DISABLED`; the endpoint has no CLI launch implementation.

## Blockers preventing actual connection

- No browser surface is available in this environment (`cua` inventory reported no browsers), so I could not create a tunnel in Platform or add the MCP app in ChatGPT settings.
- No Platform tunnel ID or runtime API key was available to this session. No matching OpenAI/tunnel environment variables were present; their values were not displayed.
- Creating/selecting the tunnel requires Platform tunnel permissions; selecting it in ChatGPT requires Developer Mode and the correct ChatGPT workspace association. These are separate permissions.
- The local tunnel daemon has **not** been started and the remote tunnel has **not** been created. No credentials were generated or stored.

## Operator path to finish

1. In Platform Tunnels settings, create a tunnel associated with the target ChatGPT workspace. Create a separate runtime key with Tunnels Read + Use; do not use an admin key as the long-running runtime credential.
2. In PowerShell, from this folder, run `.\Start-SecureTunnel.ps1 -Initialize -TunnelId 'YOUR_TUNNEL_ID'`. Enter the runtime key only into its hidden prompt. Keep the foreground process running.
3. In ChatGPT web settings, create a Developer Mode custom MCP app, select Tunnel and the tunnel ID, then install/refresh the app.
4. Confirm `codex_submit`, `codex_job`, `codex_cancel` are discovered. A valid call must still return `CODEX_DISABLED`.

The setup ZIP includes the extracted client, its license/SBOM sidecars, and the official checksum manifest; the original checksum-verified release ZIP is retained in the workspace `runtime/` folder. Never share the runtime API key in chat or source control.

## Safety / production state

- Codex execution remains disabled by construction; there is no execution activation switch in this package.
- The Windows MXC isolation probe previously failed on this executor (`native MXC is unavailable on this executor`). Do not enable local execution until an independent approved isolation runner has been verified.
- Production Bridge, MCP proxy, their credentials, tunnel settings, and global configuration were not changed. No production process was stopped or restarted.

## References

- OpenAI Secure MCP Tunnel setup and permissions: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- ChatGPT custom MCP app setup: https://developers.openai.com/api/docs/guides/custom-mcp-server
- Official tunnel-client release page: https://github.com/openai/tunnel-client/releases



