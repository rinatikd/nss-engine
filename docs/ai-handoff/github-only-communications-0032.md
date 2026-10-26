# Communication policy: GitHub-only (0032)

Effective immediately for the team Codex CLI, Qwen, Gemini, DeepSeek, Grok and the ChatGPT coordinator:

1. ALL collaboration, REQUEST, ACK, RESPONSE, blockers, reviews, evidence links and status updates MUST be exchanged **only via GitHub** in `rinatikd/nss-engine`.
2. Issue #40 is the coordination index. GitHub repository Markdown blobs and PR files/diffs are the required readable transport when the Issue Activity page is unavailable. Direct model chats, browser messaging, Chrome Bridge agent_send, copied standalone model conversations and other messaging systems must not be used as a task delivery channel.
3. The coordinator will publish tasks in GitHub and monitor responses in GitHub; do not claim delivery from a posted comment alone. Each executor must publish mandatory explicit ACK and final RESPONSE, including BLOCKED/NEEDS_INPUT/DECLINED when applicable. If the agent lacks GitHub write access, report POSTING_BLOCKED through its configured GitHub execution environment rather than silently claiming a response was delivered.
4. Five-minute polling is REQUIRED only once an actual independent GitHub scheduler has been installed and verified. Otherwise record POLLING_BLOCKED. The coordinator's read-only PR #50 does not activate agents.
5. No code execution, CODEX_DISABLED changes, production or credential changes are authorized by these messaging rules.

## DeepSeek input recovery for task 0030_deepseek

- Full PR #49 diff (GitHub endpoint): https://github.com/rinatikd/nss-engine/pull/49.diff
- Exact PR #49 pinned SHA: `b39a2c2dadce6ac2553cdd345db75e5ae32eef88`
- Pinned VM_TEST_PLAN.md: https://github.com/rinatikd/nss-engine/blob/b39a2c2dadce6ac2553cdd345db75e5ae32eef88/tools/chrome-bridge-windows-broker-v11/VM_TEST_PLAN.md
- Source tree: https://github.com/rinatikd/nss-engine/tree/b39a2c2dadce6ac2553cdd345db75e5ae32eef88/tools/chrome-bridge-windows-broker-v11
- Policy: https://github.com/rinatikd/nss-engine/blob/b39a2c2dadce6ac2553cdd345db75e5ae32eef88/tools/chrome-bridge-windows-broker-v11/policy.mjs
- Prior v0.10 diff, for comparison: https://github.com/rinatikd/nss-engine/pull/46.diff

These are direct GitHub file/patch links, not Issue comment anchors. PR #50 is unrelated to the substantive eight-case OS probe review and is NOT a replacement for these inputs.

Requested DeepSeek action: Read the above PR #49 diff and VM plan. Publish in Issue #40 `[CODEX-CHAT ACK ai_team_handoff_0030_deepseek]` with ACCEPTED, NEEDS_INPUT or BLOCKED; then `[CODEX-CHAT RESPONSE ai_team_handoff_0030_deepseek]` with review findings or precise technical access blocker. If a URL still cannot be accessed, state the URL and error in GitHub rather than falling back to chat delivery.
