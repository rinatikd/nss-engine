# Direct ChatGPT → local Codex CLI tunnel report (v21)

**State: transport prototype; Platform/ChatGPT tunnel is not connected.** This channel is independent of Chrome Bridge. The MCP server lives under `src/server.mjs` and advertises only `codex_submit`, `codex_job`, and `codex_cancel`.

## Verified behavior

- Node syntax check passed.
- MCP `initialize` and `tools/list` returned the expected protocol response and exactly three tool schemas.
- A valid `codex_submit` call returned `CODEX_DISABLED`; it returned no job ID and did not launch Codex CLI.
- The local source has no Codex process-launch implementation.
- The Windows native MXC sandbox capability check failed on the build host (`native MXC is unavailable on this executor`); execution must remain disabled.
- No Platform tunnel or ChatGPT MCP app was created. This source snapshot contains no executable or credentials.

## Tunnel client provenance

The local workspace downloaded official OpenAI `tunnel-client` release v0.0.18 for Windows amd64 and matched the archive SHA-256 against the release `SHA256SUMS.txt`: `8d0da1ce79532d44ccc5ed5d8bd36cdfffba37dfd287c602d69635c8bb5db2b2`. The executable and downloaded archive are excluded from this GitHub snapshot per repository artifact rules.

## Remaining setup

A Platform administrator must provision a Secure MCP Tunnel and runtime key; ChatGPT Developer Mode must allow a custom MCP app associated with the target workspace. Enter the runtime key only through the local launcher's hidden prompt. Confirm discovery and the expected `CODEX_DISABLED` response before considering any further work.

No production Bridge, MCP proxy, credentials, tunnel settings, or global configuration were modified. See the OpenAI guides for [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [custom MCP apps](https://developers.openai.com/api/docs/guides/custom-mcp-server).

