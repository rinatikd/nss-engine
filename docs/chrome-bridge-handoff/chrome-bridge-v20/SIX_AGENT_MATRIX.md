# Chrome Bridge six-provider integration matrix

Target: Claude, Gemini, DeepSeek, Grok, Cursor Cloud Agents, Qwen.

| Provider | Web origin | Discover and browse | Chat adapter | Send control |
| --- | --- | --- | --- | --- |
| Claude | https://claude.ai | Existing | Existing | Existing approval gates; needs real browser ACK |
| Gemini | https://gemini.google.com | Existing | Existing | Existing approval gates; needs real browser ACK |
| DeepSeek | https://chat.deepseek.com | Existing | Existing | Existing approval gates; needs real browser ACK |
| Grok | https://grok.com | Candidate after owner grants site access | Read-only probe | OFF pending live selector calibration |
| Qwen | https://chat.qwen.ai | Candidate after owner grants site access | Read-only probe | OFF pending live selector calibration |
| Cursor Cloud Agents | https://cursor.com/agents | Candidate after owner grants site access | Read-only probe | OFF; task creation may have external side effects |

Cursor **desktop IDE** is NOT a browser tab and needs a separate IDE/CLI connector; this change addresses only its official web Cloud Agents product at https://cursor.com/agents. See https://docs.cursor.com/en/background-agent/web-and-mobile.

Activation workflow for candidate pages:
1. Open the signed-in provider page in Chrome.
2. Add exact HTTPS origin in Chrome Bridge and select AI Chat.
3. Grant Chrome per-site permission locally. The site is marked discovery-only and will appear in browser_tabs/agent_list.
4. Run read-only browser_read and agent_selftest, inspect composer/send/reply selector availability, and confirm actual stable conversation URL identity and no unattended prompt submission.
5. Implement and independently review each adapter under separate PR with synthetic and real-browser tests, explicit Control grant and per-send approval. Only after that permit writing.
6. Cursor Cloud Agents may launch jobs/incur charges. Require separate, explicit operator approval for initiating such tasks, with a cost/workspace summary.

These new candidate origins are intentionally NOT members of CONTROL_ORIGINS. No account credentials, browser key, or policies change. Any unverified send outcome remains UNKNOWN and cannot be automatically retried.
