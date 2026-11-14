# ChatGPT-only approval UX — implementation and trust boundary

## Verified capability

ChatGPT plugin write actions can prompt the operator inside the ChatGPT UI; the plugin's tool annotation `readOnlyHint` informs classification. The current PowerShell Direct service already exposes `powershell_chat_readonly` for five fixed, read-only diagnostics (requires ChatGPT permission **Always ask**), and `powershell_engineering_submit` for broader operations requiring a separate, local Windows decision.

These are **different trust boundaries**. The MCP server receives an authenticated tool call but not a separately verifiable cryptographic proof that the human approved a particular plan in the ChatGPT UI. A model-authored `approved=true` property or a freeform chat message is **not** sufficient proof. Never silently convert write/build/script operations to the read-only path.

References:
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/guides/security-privacy

## Target: no separate approval page in the routine workflow

The desktop shortcut is a strictly temporary fallback, **not** the target user experience. The design goal is to approve or deny work within ChatGPT itself, with no local browser tab, PowerShell command, tray icon, or per-operation Windows interaction. An unavoidable initial enrollment of trusted workstation credentials and policy can be separate, but must not be repeated for each operation.

**Technical decision:** classify operations as (A) fixed read-only pinned diagnostics, (B) bounded tests/builds that can execute arbitrary project code, and (C) filesystem/Git mutations. For A, use native ChatGPT approval, already available in the pinned read-only tool. For B/C, test whether ChatGPT's tool approval gate can provide an authenticated server-side attestation bound to the exact plan. If not, use a pre-enrolled, locally signed *bounded execution policy* for narrowly scoped operations where the operator has explicitly opted into autonomous execution; keep separate local approval for anything outside this policy. Never treat the assistant's message or a model-supplied field as authorization. Local protection is not replaced by an in-chat button that merely sends text.

MCP's elicitation capability can request information via client UI, but general elicitation acceptance alone is not a cryptographic host-verified authorization for executing code. Verify actual ChatGPT support and transport behavior before adopting it. See https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/client/elicitation.mdx .

## Stage 1: implemented ChatGPT-native read-only Git path (not deployed)

The existing host-consented `powershell_chat_readonly` tool is extended with fixed `git-branch` and `git-log` operations. A single call uses an exact operation enum, absolute workspace validation, a fixed executable/argv and bounded runtime; no separate `/approve` page is queued. The new source tests `tools/powershell-direct/tests/chat-approval-ux.test.mjs` verify the enum, fixed commands, no arbitrary shell/pull, once-only request ID, and absence of a local approval queue. **These code changes still require Windows test and controlled deployment.** The already-running pinned `git-status` diagnostic was directly exercised from ChatGPT with exit code 0 and no local page.

For native ChatGPT consent to remain meaningful, plugin permissions must stay `Always ask`. Do not claim the MCP server can cryptographically verify host consent.

## Stage 1b: temporary fallback (no change to running service)

1. Keep `powershell_chat_readonly` for safe fixed diagnostics, with **Always ask** permission.
2. Optionally provide `Install-ApprovalShortcut.ps1` for a user-owned desktop shortcut labeled "Engineering MCP Approval" **only until in-chat authorization is solved**. The shortcut points to the already-tested `Open-Approval.ps1` and never contains the protected token, approval URL or secrets.
3. Require explicit operator installation using `-Mode Install`; `-Mode Inspect` is read-only, `-Mode Remove` only removes an exact matching shortcut. Refuse to overwrite a conflicting existing shortcut.
4. Continue displaying `requestId`, operation, workspace, exact executable/argv, hash, risk and expiry in the local page; never aggregate broad approvals by default.

## Stage 2: eliminate local page for regular work

Before implementing any host-only approval for operations that execute code or modify local files:

- Identify a **host-backed** proof or transport with an authenticated user decision and explicit binding to `requestId`, exact plan digest, workspace, scope, expiry, and single-use nonce. Define a trust anchor that a remote model cannot forge.
- Test `Allow`, `Deny`, expiry, altered arguments, duplicate requestId, replay, revoked connection and time-of-check/time-of-use changes.
- If there is no verifiable host approval attestation supported by this connector, **do not remove local confirmation**. A ChatGPT UI prompt may still be used as an additional approval layer.
- Keep potentially mutating operations (`git-pull-ff-only`, `node-test`, `powershell-script`, `dotnet-build`) separate from truly read-only diagnostics.
- For bounded batch approvals, prefer a short locally approved scope with fixed file hashes and operation enums; forbid wildcard shell commands, `git push`, `git reset`, arbitrary paths, or stored credentials.

## Acceptance criteria

- Desktop shortcut opens the same DPAPI-verified loopback approval page with one click and no terminal command.
- Shortcut contains no token or URL query; `Inspect` and `Remove` do not affect the supervisor or tunnel.
- ChatGPT pinned diagnostic still runs through native tool consent.
- Engineering write/code execution still requires separately authenticated local approval until a host-verifiable attestation exists.
- Real Windows E2E testing validates fresh host consent, denial, replay prevention, local page, and unaffected production services.

This document does not claim ChatGPT-native verification has been implemented.

## Proof-of-support checklist

1. Confirm ChatGPT's live connected MCP call actually requests host consent and whether any attestation is transmitted to the MCP server. The Responses API `mcp_approval_request`/`mcp_approval_response` exchange is processed by the OpenAI client; it does not imply a server-verifiable signature on each invocation. See https://developers.openai.com/api/docs/guides/tools-connectors-mcp .
2. Inspect request metadata and connector capabilities for any authenticated, non-model-authored token scoped to the exact call. Never log credentials; synthetic test service only.
3. If absent, prefer a **single locally enrolled allowlisted policy**: exact allowed workspace roots, operation enum, acceptable source hashes, TTL and revocation, audit/at-most-once. No arbitrary shell or rights escalation. Per-operation ChatGPT consent is an additional layer but not a substitute for enrollment.
4. Test prompt injection, fabricated `approved`, replay, branch divergence, dirty worktree, modified test source, expiry, operator revocation, and rollback. Require no pending local approval for enrolled requests in the successful E2E case.
5. Keep non-enrolled and high-impact operations fail-closed pending a separate operator decision until a cryptographically meaningful attestation exists.

## Engineering MCP controlled lab preparation (PR115)

The PR introduces a first *fixed capability* `lab-checkout-pr115`, accepted by `powershell_engineering_submit` with `requestId`, `operation`, and the **exact** base checkout `C:\\Engineering\\ChromeBridge-Recovery-Install-20261114`. The plan resolves to a fixed HTTPS repository, the PR branch, and `C:\\Engineering\\PowerShellDirect-Approval-Lab-PR115`. The runner rejects existing targets (including junctions), a redirected parent folder, and any alternate workspace before invoking Git with `shell:false`. The normal durable engineering audit claim and operator approval remain mandatory.

This capability is deliberately not general-purpose `git clone`, `git checkout`, or arbitrary PowerShell. Future labs should be defined as independently reviewed preset configurations with explicit root/remote/branch policy; do not accept model-supplied Git arguments. The first lab capability must pass real Windows E2E before it can become a reusable family of safe operations.

Tests: `tools/ai_collaboration/engineering-lab-checkout.test.mjs` checks target collision, redirected parent, invalid source, forbidden arguments and operation enum. This code has **not been deployed** in production or tested on Windows as of this update. The GitHub draft is not a replacement for local runtime approval.
