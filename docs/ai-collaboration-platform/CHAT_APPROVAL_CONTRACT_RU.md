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

## Findings from official OpenAI MCP documentation (2026-11-15)

- OpenAI's MCP plugin guidance documents **host-mediated confirmation of write tools**, with write actions requiring confirmation by default, and `readOnlyHint` used for read-only classification: https://developers.openai.com/api/docs/guides/custom-mcp-server
- This confirmation is controlled by **the ChatGPT host and app permissions**, not by the Windows server and not by assistant-written UI. Permissions can sometimes be remembered in a conversation. Therefore a plain MCP call carrying `approved:true` does not constitute a cryptographic user attestation and cannot unlock our current local approval by itself.
- The product's app configuration may need refresh/publication for changed tool schemas; adding a tool to `service.mjs` does not automatically make it appear in the currently connected app: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- Practical implementation path: expose a **separately classified write action** to the ChatGPT host only after security review, configure its app permissions to **Always ask** and use a narrowly scoped, server-verified authorization protocol. For the strongest guarantee independent of client settings, obtain signed, user-identity-bound attestation from a trusted host or a separate operator-controlled authentication flow. **The current tool set has no such verified attestor.**

## Additional source-only prototype

- `tools/ai_collaboration/chat-approval-redemption.mjs`: post-attestation redemption contract. It rechecks pending `requestId + planSha256`, accepts only a verified grant and requires an atomic compare-and-swap before any runner is authorized. It is **disabled**, has no live MCP registration, and contains no shell execution.
- `tools/ai_collaboration/chat-approval-redemption.test.mjs`: cases for valid one-shot claim, denial, spoofed grants, mismatched plan and atomic-claim failure. These are unit tests, **not** evidence of host-mediated ChatGPT confirmation or Windows execution.
- The `verifyAttestation` and `authorizePending` dependencies must be independently secure and durable before integration. Do not silently substitute a local in-memory Map/Set for production replay protection.

**Gate: NO-GO** for direct chat approvals until supported host confirmation is tested end-to-end and the chosen trust model is audited. The prior job `pr113_sync_20261115_01` is `DENIED / APPROVAL_EXPIRED`; do not revive it.
