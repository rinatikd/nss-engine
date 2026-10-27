# One UI/MCP owner with optional local Codex text service

Linux only for the Codex service. This does not change the Windows Bridge gate. No model API key is used; Ollama runs separately on127.0.0.1:11434. Native Codex must be the tested0.163.0 executable. Models are limited to qwen2.5:3b/7b installed locally, with local model metadata verified before claiming tasks.

From the Python dispatcher directory:

```sh
python run_workspace.py --db /absolute/state/interface.sqlite \
  --codex-executable /absolute/official/bin/codex \
  --codex-model qwen2.5:3b \
  --transport streamable-http --ui-port 18767 --mcp-port 18768
```

For Tunnel stdio use `--transport stdio`; stdout remains MCP only. The launcher's private child pipe receives a loopback port, never the generated bearer. The bearer stays in process memory/environment and is removed from the native CLI environment by local-only adapter isolation. No key file or secret CLI argument is created.

The launcher starts one fixed sibling Node service and then the existing shared UI/MCP runtime. It configures the latter with A2A_CODEX_RPC_URL/A2A_CODEX_RPC_TOKEN for that process's lifetime. The JS ledger is authoritative for Codex tasks; the separate Python reviewer queue remains separate.

A reachable service does not prove inference. When Ollama/model metadata is unavailable, the service remains reachable with model_available=false and leaves tasks unclaimed. It does not repeatedly reserve/release them. A real task completion establishes that request's execution.

Ctrl+C or SIGTERM closes the shared runtime, then aborts the active owned native process group. The scheduler records uncertain in-flight outcomes as UNKNOWN before closing its ledger; they are not automatically resent. Unix fixture tests cover this lifecycle. The launcher surfaces a shutdown failure rather than blindly killing the scheduler and orphaning a detached native child.

Offline checks:

```sh
python -m unittest -v test_run_workspace
# in tools/a2a-js-v040-reviewed
node --test tests/*.test.mjs
```
