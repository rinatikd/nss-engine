# ChatGPT-first approval UX — implementation and trust boundary

## Verified capability

ChatGPT plugin write actions can prompt the operator inside the ChatGPT UI; the plugin's tool annotation `readOnlyHint` informs classification. The current PowerShell Direct service already exposes `powershell_chat_readonly` for five fixed, read-only diagnostics (requires ChatGPT permission **Always ask**), and `powershell_engineering_submit` for broader operations requiring a separate, local Windows decision.

These are **different trust boundaries**. The MCP server receives an authenticated tool call but not a separately verifiable cryptographic proof that the human approved a particular plan in the ChatGPT UI. A model-authored `approved=true` property or a freeform chat message is **not** sufficient proof. Never silently convert write/build/script operations to the read-only path.

References:
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/guides/security-privacy

## Stage 1: immediate improvement (no change to running service)

1. Keep `powershell_chat_readonly` for safe fixed diagnostics, with **Always ask** permission.
2. Provide `Install-ApprovalShortcut.ps1` for a user-owned desktop shortcut labeled "Engineering MCP Approval". The shortcut points to the already-tested `Open-Approval.ps1` and never contains the protected token, approval URL or secrets.
3. Require explicit operator installation using `-Mode Install`; `-Mode Inspect` is read-only, `-Mode Remove` only removes an exact matching shortcut. Refuse to overwrite a conflicting existing shortcut.
4. Continue displaying `requestId`, operation, workspace, exact executable/argv, hash, risk and expiry in the local page; never aggregate broad approvals by default.

## Stage 2: ChatGPT-native approvals feasibility gate

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
