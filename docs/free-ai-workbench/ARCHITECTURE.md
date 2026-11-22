# Free AI Workbench — architecture and feasibility (2026-11-14)

Status: **DESIGN + OFFLINE PROTOTYPE**, not an installed multi-agent system.
Goal: one interface to converse with models, schedule multi-agent engineering work,
and automate repeatable workflows without paid orchestration SaaS.

## Three distinct layers

1. **Conversation UI / model comparison:** trial LibreChat (MIT, self-hosted,
   MCP and multi-provider). Open WebUI is an alternate but check its
   post-v0.6.6 branding-protection license. No API key is bundled. Shared
   subscriptions do not automatically authorize third-party API access.
2. **Agent coordinator / engineering worktrees:** benchmark Vicoa (AGPLv3,
   local CLIs, Windows, worktrees) for sessions, and Paperclip (MIT, roles,
   assignments, budgets, human gates). Avoid running both schedulers as
   authoritative simultaneously. Keep one project task state ledger.
3. **Workflow automation:** trial Activepieces Community (MIT core,
   self-hosted) or n8n Community (free self-host but Sustainable Use
   License, not MIT); test triggers, retries, notifications and approvals.
   CrewAI (MIT) is an optional code-level executor, not a universal UI.

## Explicitly excluded from the free core

- TypingMind: paid lifetime licence plus paid model API; inspect UX only.
- MultipleChat / Poe / CoChat: hosted free tiers and/or paid subscriptions;
  useful UX references, not local free platform dependencies.
- Make / MindStudio: free usage-limited hosted plans; may prototype but do
  not make them critical path.
- Flowise and AutoGen: archived/unmaintained in 2026; reference only.
- Volt, ChatHub, BotHub, StudyAI and other named aggregators: licensing,
  provenance and Windows operability require separate verification; not
  dependency candidates until confirmed.

## Zero incremental inference-cost policy

Priority order: (a) local Ollama for tasks within hardware capabilities;
(b) Gemini CLI free individual authorization when allowed by provider terms;
(c) OpenRouter :free models with explicit daily caps; (d) optional existing
subscriptions via **official** CLI. No scraping browser session cookies,
no credential sharing, no subscription-to-API substitution.
All hosted free tiers impose availability/rate/privacy constraints.
Do not submit private CAD drawings, confidential engineering data, token
values, or customer data to third-party free endpoints without approval.

## Components to implement in our private repository

- **Task ledger** (prototype below): proposed -> queued -> assigned ->
  submitted -> reviewed -> accepted/rejected. Durable event trail, no
  process execution. Human approval for mutating work.
- **Adapters**: agent CLI (Codex/Gemini/OpenCode/Claude if present),
  Git worktrees, MCP tools, GitHub issues/PRs, browser Bridge.
- **Model router**: pluggable provider capabilities, explicit budgets,
  rate limits, prompts and results, no implicit paid fallback.
- **Web UI**: chat, side-by-side compare, task board, diffs, cost/quota
  meters, approval inbox, logs, device status, Russian-first.
- **Windows worker**: connects via existing PowerShell Direct and separate
  controlled execution tool; no expansion of current five read-only
  commands until independent security review, sandboxing and approvals.
- **Workflow engine**: Activepieces first; cron/poll/notifications and
  retries with idempotency, backoff, dead-letter handling.

## Safety and topology

Keep service 17486, local gateway 17487, tunnel 18086, Chrome Bridge and
existing production ports unaffected. Do not modify PR #108. Pilot runs
entirely offline: does not call providers, launch subprocesses or access
secrets. Never expose localhost UI to public Internet without authenticated
TLS ingress. Do not store access tokens or API keys in Git, task event
logs or chat screenshots. Do not automatically merge to main or run
AutoCAD without approved Windows test policy.

## Milestones / proof gates

P0: Static research, capability matrix, task ledger + offline tests.
P1: Windows read-only preflight; model/CLI availability and hardware inventory.
P2: LibreChat + Ollama on isolated local machine; compare offline models.
P3: one orchestrator (Vicoa OR Paperclip) + tasks / worktrees / review.
P4: Activepieces trigger -> approved work item -> result; no arbitrary exec.
P5: cross-host Work PC/Home PC, backoff, disconnect/recovery, security E2E.
P6: productize integrated dashboard and document installation/rollback.

Never claim success at P1–P6 without observed Windows E2E evidence.

## Reference sources

- https://github.com/LibreChat-AI/LibreChat (MIT)
- https://github.com/vicoa-ai/vicoa (AGPLv3)
- https://github.com/paperclipai/paperclip (MIT)
- https://github.com/activepieces/activepieces (MIT core only)
- https://support.n8n.io/article/can-i-use-your-license-for-my-use-case
- https://github.com/langflow-ai/langflow (MIT)
- https://github.com/crewAIInc/crewAI (MIT)
- https://flowiseai.com/sunset (archived)
- https://github.com/microsoft/autogen (archived; use Agent Framework)
- https://openrouter.ai/collections/free-models
- https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md
- https://github.com/ollama/ollama/blob/main/docs/windows.mdx
