# Claude handoff — Chrome Bridge v21 Audit-Fixed + Consilium Lab 0.4.0

**Owner request:** integrate this exact codebase with Claude's existing HTML Control Room artifact/UI. Do not create a competing dashboard. Preserve Claude's visual language and wire it to the actual Bridge/Consilium runtime.

## Source identity

- Package version: `0.4.0`.
- Candidate server: Kimi v21 single-file server corrected by the audit patch and aligned to Claude's provider transaction model.
- Extension/Consilium base: PR #132 HEAD `16e07aa1a8c7c6f39af20da8a7eec33662fe0b09`.
- Lab extension ID: `ojkfdjndmcpnphecoadbcnmlnadmmkah`.
- Lab MCP: `http://127.0.0.1:17484/mcp`.
- Consilium API/UI: `http://127.0.0.1:18765/`.
- Full package ZIP SHA-256: `06ad9ea00a3d6c91e1809821f3d0d1cd1ce2f16fd5c8a90be9217adfa26ba5bf`.
- Package manifest: `release-manifest.json`; file checksums: `SHA256SUMS.txt`.
- The package's `CLAUDE_GUI_INTEGRATION_TASK.md` contains the detailed source map, requirements and acceptance gates.

## Test evidence on the exact package

- Package/static check: PASS.
- Server syntax: PASS.
- Server audit regressions: 13/13 PASS.
- Built-in server selftest: 23/23 PASS.
- Control Room + ProviderTransport + synthetic integration suite: 56/56 PASS.
- Loopback MCP smoke: 29 tools, initialize PASS, exact Lab Origin 204, foreign Origin 403, `Bearer undefined` 401.
- Real Windows Lab and real Chrome MV3 load: NOT RUN (Lab bridge disconnected).
- Real Claude provider send/reply: NOT RUN.
- Reply attribution: UNVERIFIED.
- Release manifest deliberately keeps `providerDispatch=false`.

## Integration requirements

1. Reuse the existing HTML UI; do not make a duplicate dashboard.
2. Show actual Bridge connection, extension ID, per-provider readiness, Session Authorization scope/expiry, provider journal and request IDs.
3. Preserve seven equal AI members: ChatGPT, Claude, DeepSeek, Qwen, Kimi, Grok and Gemini all have `ai_member` rights. ChatGPT + Claude are the mandatory dual-review pair, not a hierarchy. Owner retains final approval for consequential changes.
4. `session_request` is non-authorizing. `session_authorize` must not be invoked by the HTML UI/AI member; it requires exact owner approval in the current ChatGPT conversation. UI may display `session_status` and revocation results.
5. Use the two-phase flow: `provider_prepare` (composer filled, no Send click), then `provider_commit` with exact identity, preparedId, payloadHash and fencingToken. Raw token must never be rendered or logged.
6. Ambiguous acknowledgement means `UNKNOWN` + quarantine; no automatic retry, no new requestId and no hidden resend.
7. Distinguish `STOP_REQUESTED`, `STOP_AFTER_COMMIT`, `STOPPED_CLEAN`, `REVOKED` and `UNKNOWN`. CLEAN requires valid signed, epoch-bound quiescence proof.
8. Reply attribution must remain `UNVERIFIED` until a request-correlated provider receipt exists. Do not infer it from response count, tail text or DOM change.
9. Keep all secrets server-side; no bearer token, cookies, browser token, agent token or fencing token in HTML, localStorage/sessionStorage, event payloads, GitHub or prompts.
10. Work on a separate branch/PR. Add role, owner-gate, no-secret, UNKNOWN-replay, stop/revoke, desktop/mobile and accessibility tests. Do not merge or deploy.

## Safety scope

- Lab ports only: 17484 and 18765. Never target Production 17381/17382 or its tunnel/credentials/profile.
- Keep the exact six provider origins plus Lab loopback host permissions. No wildcard origins.
- No arbitrary shell/filesystem/URL controls.
- Integrate read-only status/events first. Keep `providerDispatch=false` until owner-gate, replay, quarantine and secret-exposure tests pass.
- Synthetic tests must be labelled synthetic. Do not claim a real provider round-trip without the isolated Windows Chrome Lab test.

## Suggested sequence

1. Inspect the full package and Claude's existing HTML artifact.
2. Map the existing UI components to the Control Room API and ProviderTransport v1.
3. Implement live status/event surfaces first, without mutation controls.
4. Add guarded prepare/commit UI only after the existing lease/session and server gates are proven.
5. Return a separate reviewable PR, commit SHA, diff, tests, screenshots and PASS/FAIL/NOT RUN matrix.

No Production changes or deployments are authorized by this handoff.
