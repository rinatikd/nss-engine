# Node.js ↔ Windows Job Object supervisor: staged IPC v1

Status: **design + Node transport skeleton only; NOT integrated, NOT approved for Codex execution**.

## Verified prerequisite
Windows MSVC x64 native smoke passed 3/3 on operator machine: normal exit, kill-on-close, pipe echo (2026-11-12). This is not a supervisor implementation.

## Protocol
Native executable invoked with `--stdio-v1`. Node writes one UTF-8 JSON object per line. Requests:
- `{"type":"launch","requestId":"...","executable":"C:\\...\\codex.exe","args":["..."],"cwd":"C:\\..."}`
- `{"type":"terminate","requestId":"..."}`

Native acknowledgements:
- `{"type":"ready","requestId":"...","pid":1234,"contained":true}` **only after** suspended child was assigned to a kill-on-close Job Object and resumed.
- `{"type":"terminated","requestId":"...","verified":true,"activeProcesses":0}` **only after** process tree termination and OS accounting confirms zero active processes.

## Required implementation before enabling
1. Implement native supervisor binary with Windows Job Object, bounded pipe I/O, handle inheritance allowlist and process creation suspended; prevent nested-job breakaway.
2. Separate control channel from Codex stdin/stdout/stderr. Current Node transport prototype uses supervisor stdio for control and is **not** a child-process adapter compatible with `windows-codex-lab-runner.mjs`.
3. Add cancellation/timeout paths, including native crash, lost acknowledgement, orphan detection, and restart recovery; ensure no uncontained fallback.
4. Add Node protocol tests (framing, malformed JSON, partial messages, wrong requestId, duplicate IDs, max size, timeout, cancellation), native tests and local E2E.
5. Explicit approval gate, audit trail, and only lab scope; production ports 17381/17382, tokens and tunnel remain unchanged.

## Security rule
Do not treat a `ready` JSON message from an arbitrary binary as proof of containment. Pin the trusted native executable and independently verify its Windows behavior in E2E tests. The transport skeleton is not connected to the dispatcher.
