# ChatGPT chat → local Codex CLI (v21 review snapshot)

This is a separate integration from Chrome Bridge. The stdio MCP server advertises `codex_submit`, `codex_job`, and `codex_cancel`. Valid tool calls return `CODEX_DISABLED`; this snapshot contains no CLI launch path.

## Secure MCP Tunnel setup

The GitHub snapshot excludes executables and credentials. The local workspace contains a verified Windows `tunnel-client` v0.0.18 release archive (SHA-256: `8d0da1ce79532d44ccc5ed5d8bd36cdfffba37dfd287c602d69635c8bb5db2b2`). For a clean checkout, download the official Windows release and verify its checksum/provenance before extracting `tunnel-client.exe` into a local `runtime` folder next to this script. The upstream instructions are at the [official release page](https://github.com/openai/tunnel-client/releases) and the [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Provision a tunnel ID in Platform and a separate runtime key with Tunnels Read + Use. Keep the key local. Then, from this folder, run:

```powershell
.\Start-SecureTunnel.ps1 -Initialize -TunnelId 'YOUR_TUNNEL_ID'
```

The launcher accepts the runtime key through hidden input, passes it via process environment, initializes a stdio profile, runs `doctor`, and starts the tunnel in the foreground. It does not alter ChatGPT settings. Add the MCP app in ChatGPT Developer Mode and verify the three tool names; valid tool calls must still return `CODEX_DISABLED`.

No Platform tunnel ID or credentials are embedded here. The connection has not yet been provisioned. The Windows MXC probe on the build host failed (`native MXC is unavailable on this executor`), so local CLI execution must remain disabled.

