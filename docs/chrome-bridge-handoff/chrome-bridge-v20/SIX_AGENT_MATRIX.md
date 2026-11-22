# Six-model AI consortium — Chrome Bridge integration matrix

**Snapshot:** 2026-11-22  
**Priority participants:** Claude, DeepSeek, Qwen, Kimi, Grok, Gemini.  
**Operating rule:** visible browser tab is not the same as an approved, calibrated, send-capable agent.

## Consortium structure

### Primary circle

| Provider | Intended contribution | Integration state | Send policy |
| --- | --- | --- | --- |
| Claude | Code review, implementation audit, security boundary analysis | Control origin and adapter exist; live self-test found 1 composer, 1 visible send candidate and 8 reply nodes | Explicit per-origin and per-action local approval required |
| DeepSeek | Independent technical analysis, architecture critique, alternative designs | Control origin and adapter exist; live self-test found 1 composer and 1 send candidate; no reply node matched in the current page | Explicit per-origin and per-action local approval required |
| Qwen | Systems architecture, independent synthesis and challenge of assumptions | Discovery-only candidate; open chat tab exists; bind attempt returned `AGENT_SITE_NOT_APPROVED` | OFF; no send/stop/reply selectors |

### Second circle

| Provider | Intended contribution | Integration state | Send policy |
| --- | --- | --- | --- |
| Gemini | Independent verification, fact-checking and cross-review | Control origin exists; live self-test found 1 composer but 0 matches for current send/reply selectors | No message dispatch until selectors are recalibrated and verified |
| Grok | Adversarial review and counterexample search | Discovery-only candidate; existing chat tab; adapter has no send/stop/reply selectors | OFF; read-only probe only |
| Kimi | Long-context research, document review and independent synthesis | Added as discovery-only candidate at exact origin `https://www.kimi.ai`; existing browser tab observed | OFF; read-only probe only |

Cursor Cloud Agents remains a separately listed optional candidate, not part of this six-person priority roster.

## Live observations and their limits

- Claude: composer selector matched 1 visible element; send selector matched 1 visible element; reply selector matched 8 elements. The send button was disabled while the composer was empty, which is expected. No test message was sent.
- DeepSeek: composer selector matched 1 visible element; send selector matched 1 visible element; reply selector matched 0 elements in the inspected state. This proves selector presence, not successful message delivery.
- Gemini: composer selector matched 1 visible element; send and reply selectors matched 0 elements. Recalibrate against a non-mutating DOM census before enabling sends.
- Grok: current adapter is deliberately a blank-selector discovery candidate. Do not infer send capability from the open chat tab.
- Qwen: current adapter is deliberately a blank-selector discovery candidate. A bind attempt was rejected by site-approval policy.
- Kimi: the browser contains a signed-in Kimi page on `www.kimi.ai`; this change registers the exact observed origin for discovery only. No selector calibration or message-send test has been completed.
- Some Lab MCP calls have intermittently returned `UNKNOWN_TOOL` or `COMMAND_NOT_MIGRATED`. A connected status alone is not acceptance evidence.

## Candidate site permissions

The following exact origins are discovery-only and must remain outside `CONTROL_ORIGINS` until separately reviewed:

- `https://grok.com`
- `https://chat.qwen.ai`
- `https://www.kimi.ai`
- `https://cursor.com`

Discovery does not grant page mutation or message sending. Exact-origin matching is required; lookalike hosts and HTTP origins are denied.

## Required acceptance path for each candidate

1. Open the signed-in provider page in Chrome and grant the exact origin through the local Chrome Bridge site-permission UI.
2. Verify the page appears in the Lab tab inventory with the intended AI-chat mode and adapter key.
3. Run the read-only `agent_selftest`; capture selector counts and visible/enabled state without reading input values or prompt contents.
4. A reviewer checks that composer, send, stop and reply selectors are specific, unique and stable. Keep send/stop/reply blank until that review passes.
5. Separately review the candidate's origin against the Control security model. Do not add a discovery-only origin to `CONTROL_ORIGINS` merely to make `agent_bind` succeed.
6. Only after local per-origin approval, run one clearly identified non-sensitive test prompt. Verify a real response with `agent_wait` and independent tab attribution. UNKNOWN outcomes are never retried automatically.
7. Test expiry, revocation, navigation to a different origin, stale tab IDs, disconnect and restart.

## Safety boundary

The current approved Control origins remain exactly Claude, Gemini and DeepSeek. Candidate sites do not gain send capability in this change. No account credentials, browser keys, permissions for broad host patterns, Production ports or installed Production extension files are changed.

See [CONSILIUM_PROTOCOL.md](CONSILIUM_PROTOCOL.md) for the work-sharing and review protocol.
