# Codex activation: verified source-level root cause (2026-11-12)

## Observed
Chrome Bridge MCP `browser_status` is connected; `codex_submit` rejected with `CODEX_DISABLED: isolated local execution policy required`. Operator's read-only Windows scan found no present values for the narrow env names CODEX_DISABLED/CODEX_ENABLED; that scan did **not** include CHROME_BRIDGE_CODEX_POLICY.

## Source trace
1. `server/tools.mjs` advertises `codex_submit`, `codex_job`, `codex_cancel` with `kind: 'cli'`.
2. `server/bridge.mjs` `createBridge(..., { codexJobs = null })` rejects any CLI call if `!codexJobs` (error CODEX_DISABLED).
3. In the standalone startup path, `server/bridge.mjs` loads `server/codex-runtime.mjs` **only if** `CHROME_BRIDGE_CODEX_POLICY` is set.
4. `server/codex-runtime.mjs` currently rejects **all** policy module paths with `CODEX_ISOLATION_UNAVAILABLE`, without importing them. Therefore merely setting the env variable cannot activate Codex.
5. `server/codex-policy.mjs` is a dormant contract for a verified isolated runner. It hardcodes `read-only`, `--ephemeral`, and an empty child environment; it is not an implementation of approved write-enabled Codex development.

## Safe implementation direction
- Replace unconditional rejection only after a trusted native runner / broker exists and its Windows process-tree termination, authorization, workspace ACL and crash-recovery guarantees are demonstrated.
- Do not dynamically import arbitrary user-provided JavaScript policy modules; an env-supplied JS file is executable code, not a safe configuration boundary.
- Define a **separate** write-enabled development policy: explicit workspace allowlist, restricted file mutation scope, auditable approval, bounded lifetime, credential isolation, native process-tree control, and emergency stop. No implicit write permission from the existing read-only schema.
- Keep the existing fail-closed behavior for unknown, missing or corrupt policy and for unverified recovery.
- Validate in isolated Windows lab first. Do not change production 17381/17382, tokens, credentials, or tunnel during lab work.

## Immediate next action
Implement and review a native lab-only broker handshake and startup policy attestation, then add Windows end-to-end tests. Operator consent to development work is acknowledged, but does not prove that an arbitrary executable policy is safe to load.
