# OpenAgents integration spike (2026-11-16)

Status: architecture staged; no local runtime deployment or E2E claim.

## Upstream
- https://github.com/openagents-org/openagents (Apache-2.0; preserve LICENSE and notices when redistributing copied source)
- https://github.com/openagents-org/openagents-sdk
- https://openagents.org/docs/en/getting-started/overview
- Otdano source/license remains unverified; do not import its web assets as application source.

## Goal
Use OpenAgents Workspace/Launcher for human-agent threads and local agent orchestration, while retaining existing PowerShell Direct R2, Chrome Bridge and Free-AI-Workbench boundaries. Do not change production 17381/17382, credentials or tunnels.

## Adapter contract v0
TaskEnvelope:
- taskId: stable UUID; correlationId: stable UUID
- project: NSS Engine | APS Expert | Chrome Bridge
- agent: codex | claude | gemini | deepseek | kimi | qwen
- workspaceRoot: explicit allowlisted path
- operation: inspect | build | test | review
- payload: structured, non-executable description
- approvalState: pending | approved | rejected
- idempotencyKey: unique per dispatch

TaskResult:
- taskId, correlationId, agent, state (queued|running|succeeded|failed|blocked)
- startedAt, finishedAt, exitCode, artifactPaths, logDigest, evidence
- delivery acknowledgement distinct from execution completion.

## Implementation boundaries
1. OpenAgents adapter accepts events and translates to TaskEnvelope; no direct shell command from untrusted event text.
2. Windows executor uses only approved, bounded PowerShell Direct engineering operations and explicit workspace allowlist.
3. Chrome Bridge browser operations remain behind origin-specific grants; no implicit global Control.
4. Workbench mirrors task status; never mark DONE without test/log evidence.
5. Credentials stay local; do not place tokens in GitHub, event payloads or logs.
6. Preserve upstream copyright/license notices for any copied code.

## First acceptance tests
- duplicate correlationId => no second execution
- event received => queued but not executed until approved
- rejection => no execution
- allowed node-test/dotnet-build => real exit code and log digest
- disconnect/reconnect => no duplicate dispatch
- missing agent => BLOCKED, not success
- production ports unchanged
- 7/7 actual local tests and logs required before claiming E2E.

## Environment observed
- PowerShell Direct staged preflight PASS, importsOk=true, serverListening=false
- Workbench at 127.0.0.1:18791 reports execEnabled=false and providersConnected=[]
- Therefore no local Codex dispatch has occurred.

## Next implementation
Inspect OpenAgents Launcher agent runtime APIs and workspace event schema at a pinned commit; implement a thin adapter in isolated staging. Run unit tests, then local E2E on Windows after executor activation.