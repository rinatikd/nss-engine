# Secure MCP Tunnel — v0.23 staging

The Tunnel profile should use MCP stdio so no local network listener is needed. The local UI and MCP server must use the same absolute SQLite path.

## Local protocol validation

```powershell
py -3.14 -m pip install -r requirements-interface.lock
py -3.14 -B -m unittest -v test_mcp_bridge test_mcp_http
```

Tests use a temporary database and an ephemeral loopback port. They do not contact Platform, ChatGPT, Ollama, or a paid API.

## Platform requirements

- A real `tunnel_id` associated with the target Platform organization and ChatGPT Workspace.
- Runtime principal with Tunnels Read + Use. Creating/editing the tunnel requires Tunnels Read + Manage.
- Official `tunnel-client` installed. Begin with `tunnel-client help quickstart` and `tunnel-client help samples`.
- A private ChatGPT custom MCP app using that Tunnel.
- Runtime key stored in a local protected source, never in chat, source, command text, or logs.

In this session `tunnel-client`, runtime key, tunnel ID, and browser access to Platform settings are unavailable; no account configuration was changed.

## Prepare the shared paths

Run from this package directory and choose an absolute SQLite path:

```powershell
$python = (py -3.14 -c "import sys; print(sys.executable)").Trim()
$source = Join-Path $PWD 'mcp_bridge.py'
$db = Join-Path $PWD 'state\interface.sqlite'
$profile = 'a2a-dispatcher-v020'
$tunnelId = 'REPLACE_WITH_REAL_TUNNEL_ID'
$mcpCommand = '"' + $python + '" -B "' + $source + '" --transport stdio --db "' + $db + '"'
py -3.14 -B web_app.py --db $db --open
```

Keep the UI and Tunnel MCP command on this same `$db` value. Do not start another worker from the UI while the MCP worker is running.

## Initialize the profile

After validating exact syntax with the installed client help:

```powershell
tunnel-client init --sample sample_mcp_stdio_local --profile $profile --tunnel-id $tunnelId --mcp-command $mcpCommand
tunnel-client doctor --profile $profile --explain
tunnel-client run --profile $profile
```

Runtime key injection is intentionally not shown. Use the protected local secret source supported by the client, then verify readiness without printing the key.

## ChatGPT first exchange

The catalog contains nine tools: health, Codex preflight, Codex config audit, sandbox smoke, submit, start local worker, get task, cancel, and stop worker. Call `dispatcher_codex_preflight` to inspect the installed CLI before any future execution integration; it never launches a model. `dispatcher_codex_config_audit` returns only source counts and scans section headers without parsing assignment values; it never returns TOML values, paths, or server details. `dispatcher_codex_sandbox_smoke` runs fixed echo/write-denial probes only; a pass proves write denial only, not read or network isolation. It is a write tool requiring confirmation and does not start the Codex model. Require confirmation for each write tool in the private app; this setting could not be inspected here.

Create a random UUIDv4 and pass its 32-character hex value as `request_id`. Reuse the identical ID and payload after an uncertain response: same payload returns `EXISTS`, changed payload returns `CONFLICT`. The MCP catalog has no task-enumeration tool; task status omits the prompt, rubric, and stored worker request.

Do not claim the channel works until ChatGPT discovers the tools and completes a synthetic submit/status cycle through the running Tunnel. A real Ollama response must be checked separately.
