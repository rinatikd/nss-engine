# Chrome Bridge v2.0 — ChatGPT-approved Lab cutover runbook

**Purpose:** prove that the chat-only approval path is present in the isolated PR102 Lab runtime before sending a real provider message.

**Scope:** PR #132 only, isolated Lab endpoint and Lab Chrome profile. Production, the legacy 17381 listener, Production credentials, profile, ports, services and autostart are excluded.

## 0. Hard stop conditions

Stop without local fallback if any of these occur:
- The user has not approved the exact challenge in the current ChatGPT conversation.
- The Lab tool registry does not expose all four session tools.
- Bridge epoch changes, the browser/extension restarts, or a selected origin/tab/conversation changes.
- A request returns UNKNOWN, queue full, stale epoch or an ambiguous acknowledgement.
- A tool requests local Windows approval. This runbook does not authorize that route.

Never state that a provider received a message because a tab exists, a composer was filled, a click returned, a GitHub comment was written, or a response already existed in the chat.

## 1. Deployment preflight (read-only)

Capture and retain:
- exact Lab workspace, branch and commit SHA;
- build artifact SHA-256 and package manifest;
- Lab endpoint and its expected port;
- Lab extension ID and manifest version;
- current process owner (PID + process start time + executable path);
- current tool registry and browser status;
- Production isolation check: no Production process, URL, credential, port or Chrome profile selected.

Required health state before proceeding:
- Lab browser connected;
- pending command queue is zero;
- selected tabs exist and are configured as AI-chat tabs;
- each selected tab passes its adapter-specific composer/send/stop/reply self-test;
- Bridge and extension agree on the same epoch;
- no stale approval, stale lease or stale prepared provider transaction exists.

Do not kill a process by port alone. Do not modify or restart Production components.

## 2. Prove tool discovery before consent

Query MCP tools/list from the Lab endpoint. The active registry must include:
- session_request
- session_authorize
- session_status
- session_revoke

It must also expose the provider operations required by this release:
- provider_prepare
- provider_commit
- provider_status
- provider_stop
- provider_revoke
- provider_events

A source file or passing CI is not evidence of runtime discovery. If a tool returns UNKNOWN_TOOL, deployment is incomplete: stop and capture server version, endpoint, extension version and registry snapshot. Do not try the legacy agent_send path.

## 3. Prepare a non-authorizing challenge

Call session_request with the exact chosen providers and an allowed duration (60, 180 or 240 minutes). Claude is mandatory as the permanent co-operator. Every selected provider must be present, adapter-matched and covered by Chrome host permissions.

The result must show:
- ready=true;
- approvalRequired=true;
- changedNothing=true;
- exact provider list and exact origins;
- exact capabilities: agent_send, provider_prepare, provider_commit;
- current Bridge epoch and challenge expiry (120 seconds).

If any selected provider is missing, do not silently remove it from the scope. Present the missing-provider status and prepare a new exact scope only after correcting the Lab tab/adapter state.

## 4. Owner approval in the current ChatGPT conversation

Present this exact approval request to the owner:
- Lab endpoint and exact Lab commit;
- Bridge epoch;
- provider names and origins;
- duration;
- permitted capabilities;
- explicit exclusions: arbitrary browser click/fill, navigation, files, GitHub, PowerShell, OS commands, Production and autostart;
- challenge expiry and whether anything has changed (must be false).

Do not expose the challenge ID to participant agents or GitHub comments. Do not call session_authorize until the owner explicitly approves this exact challenge in the current ChatGPT conversation. A generic earlier instruction to continue work is not approval of an undisclosed scope.

## 5. Activate and verify

After exact owner approval:
1. Call session_authorize with that challenge ID.
2. Require active=true, exact providers/origins, expected epoch, expected capabilities and the requested expiry.
3. Call session_status independently and compare the returned scope.
4. Confirm arbitrary browser_click and browser_fill remain excluded.
5. Confirm no Production or OS capability was added.

If any field differs, immediately call session_revoke and report the mismatch. If status is UNKNOWN, do not retry authorization blindly.

## 6. First provider transaction

Start with one non-sensitive engineering task and Claude only. Use a stable requestId and taskId. Read the current tab URL/conversation identity and Bridge epoch. Compute SHA-256 over the exact UTF-8 message.

- provider_prepare must fill the exact bound composer, return prepared=true, clickedSend=false, sideEffect=composer-filled-no-send, matching requestId/taskId/payloadHash, a preparedId and expiry.
- Re-read provider_status and verify exact identity, payload hash, epoch and prepared state.
- provider_commit must revalidate origin/tab/conversation/hash/epoch/fencing token and return clickedSend=true plus clickedAt. This proves a UI commit attempt, not server-side receipt or delivery.
- agent_wait may inspect a new response, but replyAttribution must remain UNVERIFIED unless independent provider correlation evidence exists. A stale tail, interrupted answer or count increase alone is insufficient.
- provider_events must retain the ordered prepare/commit/receipt/UNKNOWN evidence.

If prepare or commit becomes UNKNOWN, quarantine the request and do not resubmit with a new ID.

## 7. Stop and revoke

Call provider_stop for an active transaction before broader session stop when relevant. Distinguish STOP_REQUESTED / STOP_AFTER_COMMIT from STOPPED_CLEAN. A clean stop requires the in-flight lane to be drained and reconciled.

Call session_revoke, then session_status. Require active=false and verify session storage and temporary grants are gone. A click that already occurred is not undone by revoke.

## 8. Release gate

Only mark this Lab integration gate PASS after:
- tool discovery is verified against the live Lab runtime;
- a full owner-approved challenge/authorize/status/revoke round-trip succeeds;
- one controlled provider transaction has a correlated Bridge request record;
- prepare/no-send and commit/click evidence match exact hashes and identities;
- stale/expired challenge, wrong provider, wrong epoch, origin change, navigation, restart, queue-full, user rejection and unknown-ACK tests fail closed;
- Production isolation remains verified.

Even then, the result is a Lab E2E pass, not Production release approval.
