# Chat-native engineering approval — architecture gate (PR #110)

Status: **PROTOTYPE ONLY / DISABLED**, 2026-11-15. No production wiring, configuration, credentials, or local-approval changes.

## Objective
Allow the operator to authorize a **specific** pending Windows engineering plan in the ChatGPT UX without opening a separate Windows approval page. The machine must independently verify that a trusted identity/approval provider attested the *operator's* action.

## What DOES NOT authorize execution
- User text “approved”, assistant-authored buttons and GenUI.issueNewTurn, an MCP parameter `approved:true`, model-generated JSON, unsigned requests, GitHub comments, bearer possession alone, or the assistant clicking a local Windows confirmation button.
- Existing PowerShell Direct only exposes `powershell_engineering_submit/status`, plus local `/approve` and `/decide`. It has no trusted remote approval-attestation tool.
- A model-visible UI button does not itself generate an identity-backed platform attestation. **Do not enable remote approval based on chat text.**

## Required trusted components
1. **Host-approved attestor:** OpenAI/ChatGPT product (or a separately operator-controlled, authenticated approval service) must issue a verifiable signature **only after a real authenticated operator gesture**, not when the model requests it. This needs a documented, supported platform capability and key distribution mechanism. No such capability was verified here.
2. **Server-side pending-plan binding:** fetch pending exact `requestId`, `planSha256`, operation, workspace, and risk before presenting approval. Hash is computed and held on Windows.
3. **Signed claims:** immutable canonical JSON containing `version, issuer, audience, subject, requestId, planSha256, decision, issuedAt, expiresAt, nonce`, with Ed25519 signature and exact issuer/audience/user binding. Short expiry (at most 120 seconds); trusted clock.
4. **Durable one-shot consume:** atomic unique nonce claim stored outside the model and surviving restarts. Never rely on process-local Sets. Verify pending state and exact hash **again at execution time**, revoke/expire all stale attempts.
5. **MCP API:** only after attestation exists, add `powershell_engineering_approval_status` (read only) and a carefully scoped redemption endpoint/tool that accepts independently signed attestation. The model must not be able to mint or modify the signature.
6. **Fallback:** maintain operator-only local `/approve` flow; keep `Always ask` for remote app permissions.

## Current source deliverable
- `tools/ai_collaboration/chat-approval-attestation.mjs`: pure fail-closed verifier with strict claims, Ed25519, bounded validity and replayStore dependency; **not registered in service.mjs**.
- `tools/ai_collaboration/chat-approval-attestation.test.mjs`: isolated tests with ephemeral test-only Ed25519 key. Tests use a process-local Set as a fake replay store; this is suitable **only for tests** and not a deployment implementation.

## Acceptance gates
- Demonstrate attestor only signs genuine human approval, cannot be invoked or tricked by the assistant; independent red-team/authorization review.
- Real Windows E2E: ALLOW and DENY, mismatched plan, expired consent, duplicate, changed workspace, host user account mismatch, replay after process restart, cancellation, detached/reconnected tunnel.
- If any property is unverified: **NO-GO** for chat-native approval. Local approval remains mandatory.

## Existing expired job
`pr113_sync_20261115_01` ended `DENIED / APPROVAL_EXPIRED`. Do **not** attempt to approve that job. A new task requires a new requestId and genuine authorization.
