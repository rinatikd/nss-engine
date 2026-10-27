# NSS Engine cloud development

Use the existing checkout at /workspace/nss-engine. Each cloud task is already isolated; do not create a Git worktree unless the user explicitly requests one. Read AGENTS.md, README.md, docs/SOURCE_MAP.md and docs/PORTABLE_SKILLS.md before development. Preserve tracked files, dependency declarations and lockfiles during setup.

For every new shell:
```bash
cd /workspace/nss-engine
source /workspace/.venvs/nss-engine/bin/activate
python --version
```
Python 3.12+ and the virtual environment dependencies are retained in the environment snapshot. If the venv is missing or requirements change, run the saved install_script. Keep inherited proxy and TLS verification settings.

Readiness checks, matching the repository's Linux CI:
```bash
cd /workspace/nss-engine
/workspace/.venvs/nss-engine/bin/python -m pip --no-cache-dir check
/workspace/.venvs/nss-engine/bin/python tools/repo_guard.py --tree HEAD
/workspace/.venvs/nss-engine/bin/python tools/run_portable_checks.py
```
The initial validation ran 105 passing tests across five groups; the runner explicitly omits one private snapshot test. Check the actual counts/outcomes on each future run. No background service or secret is required for this portable workflow. The current runner may report that ezdxf cannot save its optional user cache; this does not prevent the tests from running.

This Linux workflow does not validate AutoCAD/Revit add-ins or private drawing fixtures. Native AutoCAD 2026 checks need Windows, .NET 8 Windows and the installed Autodesk API; Revit 2023 needs .NET Framework 4.8 and its host. Do not launch those hosts automatically or change SECURELOAD/TRUSTEDPATHS. Windows Chrome Bridge/Secure MCP Tunnel is separate and is not configured or required by this portable setup.


# A2A shared UI/MCP runtime — reviewed v0.23
Source: /workspace/a2a-source/tools/ai-coordination-dispatcher-v0.23-reviewed.
JavaScript CLI/HTTP: /workspace/a2a-source/tools/a2a-js-v040-reviewed.
Both are published on agent/codex/a2a-interface-mcp-v016, not merged into main. Do not create worktrees or overwrite dirty files. The tested install_script refreshes only the dedicated clean /workspace/a2a-source clone with fast-forward merge, preserving /workspace/nss-engine.

Paid model API budget is zero. Do not change PAID_API_ALLOWED or the Windows Bridge CODEX_DISABLED. Do not copy cached auth files or print credential values. Git native HTTPS uses existing platform authentication.

Read docs/A2A_REVIEW_2026-10-27.md in /workspace/a2a-source for exact evidence. Real Ollama/MCP executor+reviewer passed GitHub run40517940935 (qwen2.5:3b and7b), approving a correct answer with optional recommendations. Local shared runtime and official tunnel-client dev proxy are verified separately; hosted Tunnel/ChatGPT custom app are NOT verified. The newer shared-runtime and actual Codex local-model CI runs40520744532 /40520744564 must be checked independently; do not infer their success.

Validation:
cd /workspace/a2a-source/tools/ai-coordination-dispatcher-v0.23-reviewed
PYTHONDONTWRITEBYTECODE=1 /workspace/.venvs/a2a-interface/bin/python -m unittest discover -p 'test_*.py'
node --test ui/test-ui.mjs
cd /workspace/a2a-source/tools/a2a-js-v040-reviewed
node --test tests/*.test.mjs
No npm manifest restoration is needed for these .mjs commands. Optional npm manifest template is package.json.in; restore locally only if using npm commands.

Live processes do not survive snapshots. Retained official runtime binaries:
/workspace/a2a-runtime/ollama/bin/ollama (v0.40.11, archive SHA verified)
/workspace/a2a-runtime/tunnel-full/tunnel-client (v0.0.18, archive SHA verified)
Retained local model storage: /workspace/a2a-runtime/models. Partial blobs are not installed models. Inspect GET /api/version and /api/tags at127.0.0.1:11434 first. If Ollama is absent, start it in an owned background session:
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=/workspace/a2a-runtime/models OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_CONTEXT_LENGTH=8192 /workspace/a2a-runtime/ollama/bin/ollama serve
Keep logs outside source control. Do not stop services you did not start. The runtime requires /home/agent/.ollama; if missing and write-restricted, request narrow access to that directory rather than repurposing HOME. Never read the private key.

Current cloud egress spec2 still excludes Ollama/blob/OpenAI/ChatGPT custom domains. The saved network draft contains the required domains. Retry affected pulls only after actual applied policy change. Use official ollama pull and normal digest verification; no proxy or TLS bypass. Real inference was proven in GitHub CI, not on this blocked cloud machine.

For direct local UI+MCP, run ONE shared owner, not separate web_app and mcp_bridge workers:
cd /workspace/a2a-source/tools/ai-coordination-dispatcher-v0.23-reviewed
/workspace/.venvs/a2a-interface/bin/python unified_runtime.py --db /workspace/a2a-runtime/dispatcher.sqlite --transport streamable-http --ui-port 8765 --mcp-port 8766
Both listeners are loopback. Do not present localhost as a cloud preview link. For tunnel use the fixed connector stdio entry instead of launching a second runtime on the same database.

Official local-only transport check (no hosted registration/no inference):
/workspace/.venvs/a2a-interface/bin/python verify_local_tunnel.py --client /workspace/a2a-runtime/tunnel-full/tunnel-client --timeout 40
It must report hosted_tunnel_verified=false and chatgpt_app_verified=false.

Hosted connection requires existing CONTROL_PLANE_TUNNEL_ID plus A2A_TUNNEL_RUNTIME_KEY binding -> CONTROL_PLANE_API_KEY atapi.openai.com, with Tunnels Read+Use. Creating/editing tunnels requires Read+Manage and the owner must install/allow the custom MCP app in ChatGPT. No bindings were ready at current validation. Do not invent IDs or start placeholder pollers. See MCP_TUNNEL_SETUP.md for exact prepare/check/doctor/run commands. The launcher stores only env:key references; the unified MCP child excludes OpenAI/Tunnel credentials. Keep inherited HTTPS proxy/CA trust.

The local-only Codex worker mode uses A2A_CODEX_PROVIDER=ollama-local and pinnedqwen model via loopback; isolated subprocess configuration, read-only/never, model request tools=[] are checked by verify-real-codex.mjs. This does not prove the OpenAI subscription backend or Windows isolation. Run actual model verifier only after prerequisites and preserve uncertain delivery as UNKNOWN without automatic resend.

