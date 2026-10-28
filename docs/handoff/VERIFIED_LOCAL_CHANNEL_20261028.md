# Verified local managed channel — 28.10.2026 (UTC+5)

Real CI: https://github.com/rinatikd/nss-engine/actions/runs/40616780857
Source commit: f5dbeaa. Status observed: Success,59s.

Actual official tunnel-client0.0.18 local dev proxy → generated profile → Python shared UI/MCP launcher → managed Node worker → native Codex0.163.0 → recording loopback proxy → Ollama0.40.11/qwen2.5:3b.

Observed:13MCP tools; completed task returned A2A_MANAGED_WORKSPACE_E2E_OK; measured12output tokens; tools=[]; same result in UI/MCP; one model request despite repeated request ID; one durable completion event;9owned processes observed and0remaining after SIGTERM; transport exit0. Model digest:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b. Paid APIcalls0.

Not established: hosted ChatGPT app, hosted Secure MCP Tunnel, Windows read/network isolation, interruption during active inference, general coding/tool execution, AI review or human acceptance of that CLI marker result. These flags remain false.

Observer regressions were retained and corrected:40615191425 and40616110471 failed final lifecycle observation. Two distinct concrete issues were reproduced: task/children discovery and Node24comm=MainThread. The observer now uses all task children, PID/PPID fallback for managed kernels, and executable basename/starttime identity. Seven boundary regressions PASS, full Python suite256PASS. No acceptance assertion was deleted.

Separate real executor/reviewer math checks40615191408 and40616110448 passed8Mbit/s and86.4decimalGB, with APPROVE plus optional recommendations. Historical semantic failure40564442377 stays documented; these narrow successful samples do not guarantee arbitrary mathematical correctness.
