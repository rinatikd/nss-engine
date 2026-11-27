# Six-model AI consortium — Chrome Bridge integration matrix

**Snapshot:** 2026-11-22  
**Council participants:** Claude, DeepSeek, Qwen, Kimi, Grok, Gemini.  
**Trust model:** all six are equal participants operating through the same exact-origin Control policy and per-action approval path. Role assignments below are areas of emphasis, not permission tiers.

## Equal access and participation

| Provider | Exact origin | Control policy | Live technical readiness |
| --- | --- | --- | --- |
| Claude | `https://claude.ai` | Same Control origin grant, expiry, revocation and per-action approval as every council member | Composer 1; send 1 visible; reply 8 |
| DeepSeek | `https://chat.deepseek.com` | Same | Composer 1; send 1 visible; reply selector 0 in current inspected state |
| Qwen | `https://chat.qwen.ai` | Same | Tab exists; candidate DOM selectors need live calibration |
| Kimi | `https://www.kimi.ai` | Same | Tab exists; page currently reports exhausted free quota; DOM selectors need calibration |
| Grok | `https://grok.com` | Same | Tab exists; composer candidate found; send/stop/reply selectors need calibration |
| Gemini | `https://gemini.google.com` | Same | Composer 1; send 0; reply 0 in current inspected state |

**Important distinction:** permission parity is explicit in the source `CONTROL_ORIGINS` map for all six models. It does not manufacture a valid provider send selector or a completed message exchange. A selector that is still being calibrated must fail closed technically; this is not a lower trust level or a separate permission class.

Cursor Cloud Agents and Google AI Studio remain optional non-council integrations.

## Live observations and their limits

- Claude: composer selector matched 1 visible element; send selector matched 1 visible element; reply selector matched 8 elements. The send button was disabled while the composer was empty, which is expected. No task message was sent in this audit.
- DeepSeek: composer selector matched 1 visible element; send selector matched 1 visible element; reply selector matched 0 elements in the inspected state. Selector presence is not successful message delivery.
- Gemini: composer selector matched 1 visible element; send and reply selectors matched 0 elements. Recalibrate against a non-mutating DOM census before sending.
- Grok: live chat tab exists and the visible composer candidate was `<contenteditable aria-label="Написать Grok">`; send/stop/reply selectors remain uncalibrated.
- Qwen: live chat tab exists and visible DOM contains a textarea and button labelled `Отправить`; map these to stable, unique selectors and verify the reply container before message dispatch.
- Kimi: a browser tab exists at the exact `www.kimi.ai` origin. The currently inspected page reports the free quota exhausted; no live selector calibration or message send was completed.
- Some Lab MCP calls have intermittently returned `UNKNOWN_TOOL` or `COMMAND_NOT_MIGRATED`. A connected status alone is not acceptance evidence.

## Control contract (identical for all six)

- Exact HTTPS origin allowlisting; no wildcards and no lookalike hosts.
- Per-origin local Control grant, with the same supported grant durations.
- Every mutating browser action and message dispatch retains the same explicit local approval gate.
- Global Control off, expired grant, origin change, disconnect or restart must fail closed.
- Each participant can be individually revoked; no participant is silently treated as trusted merely because a tab exists.
- Same message envelope, request correlation, timeout, UNKNOWN-no-retry and evidence rules apply to every participant.

This is permission parity, not blanket approval of arbitrary code or content returned by another model. All provider outputs remain untrusted data and must be independently checked before being used as instructions or changes.

## Council role emphasis (not hierarchy)

| Provider | Default independent perspective |
| --- | --- |
| Claude | Source-code review, implementation risks, regression paths and patch critique |
| DeepSeek | Architecture critique, failure modes, alternative designs and adversarial challenge |
| Qwen | Systems-level reasoning, boundary conditions, deployment and recovery analysis |
| Kimi | Long-context review, history comparison, requirements and evidence extraction |
| Grok | Adversarial counterexamples and assumption falsification |
| Gemini | Independent verification, structured comparison and factual cross-check |

Rotate roles when useful. Every participant receives the same pinned evidence packet in Round 1 and cannot see the other participants' conclusions until Round 2.

## Release acceptance

1. All six exact origins are present in `CONTROL_ORIGINS` and their grant/revoke behavior passes the same tests.
2. Each participant's composer, send, stop and reply selectors are calibrated to unique, visible elements where relevant. Empty-composer send absence is not a defect.
3. A clearly identified, non-sensitive test message is sent once to each provider after the normal local approval; acknowledgement and the response are independently attributed to the correct origin/conversation.
4. Cross-provider dispatch is correlated so a response cannot be attributed to the wrong request or participant.
5. Expiry, revoke, navigation, stale tab IDs, provider quota/rate-limit errors, disconnect and restart are tested.
6. The council performs independent analysis, cross-examination and final synthesis, preserving disagreements and evidence.

Until these are demonstrated, describe the council as a **partially connected prototype with equal source-level Control eligibility**, not a completed autonomous multi-agent orchestrator.

See [CONSILIUM_PROTOCOL.md](CONSILIUM_PROTOCOL.md) for the shared task and review process.
