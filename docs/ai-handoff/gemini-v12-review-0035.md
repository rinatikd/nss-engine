# Gemini assignment 0035 — Independent review of Windows Broker v0.12 (PR #51)

Recipient: Gemini. Source transport: GitHub repository Markdown and PR; Issue #40 for acknowledgements. This is an assignment publication, NOT proof that Gemini received it.

## Pinned source baseline
- PR #51 (draft, unmerged): https://github.com/rinatikd/nss-engine/pull/51
- Exact head SHA: `c960e795f150d8775bae26eb8416be7907bc18e3`
- Complete PR diff: https://github.com/rinatikd/nss-engine/pull/51.diff
- Source folder: https://github.com/rinatikd/nss-engine/tree/c960e795f150d8775bae26eb8416be7907bc18e3/tools/chrome-bridge-windows-broker-v12
- VM test plan: https://github.com/rinatikd/nss-engine/blob/c960e795f150d8775bae26eb8416be7907bc18e3/tools/chrome-bridge-windows-broker-v12/VM_TEST_PLAN.md
- VM execution runbook: https://github.com/rinatikd/nss-engine/blob/c960e795f150d8775bae26eb8416be7907bc18e3/tools/chrome-bridge-windows-broker-v12/VM_EXECUTION_RUNBOOK.md
- Native test launcher: https://github.com/rinatikd/nss-engine/blob/c960e795f150d8775bae26eb8416be7907bc18e3/tools/chrome-bridge-windows-broker-v12/native/test_launcher.cpp
- Synthetic worker: https://github.com/rinatikd/nss-engine/blob/c960e795f150d8775bae26eb8416be7907bc18e3/tools/chrome-bridge-windows-broker-v12/native/synthetic_worker.cpp
- Test report: https://github.com/rinatikd/nss-engine/blob/c960e795f150d8775bae26eb8416be7907bc18e3/tools/chrome-bridge-windows-broker-v12/TEST_REPORT.md
- Communication protocol: https://github.com/rinatikd/nss-engine/blob/fab590f8af785dbf5976f6c1bfbd20975c18f6ce/docs/ai-handoff/github-only-communications-0032.md

## Known status — do not misrepresent
Codex reports local source-only 27 PASS, 0 FAIL, 8 Windows integration SKIP/BLOCKED; portable GitHub checks successful. Native C++ compile and all eight real disposable-Windows-VM isolation probes remain BLOCKED. Scenario 8 (crash cleanup) lacks deterministic pausepoints/independent external cleanup controller. This is NO-GO for local Codex execution or production. No independent Gemini review has been confirmed.

## Required work
1. Perform an INDEPENDENT pinned-SHA source review of PR #51. Verify actual code rather than repeating status claims. Give file/line links and severity (CRITICAL/HIGH/MEDIUM/LOW) for each demonstrated issue; mark hypotheses separately.
2. Review trust boundary for CreateProcessW(CREATE_SUSPENDED), file identity between verifier and resumed image, ACL/reparse/hardlink/TOCTOU, STARTUPINFOEX explicit inherited HANDLE_LIST, AppContainer/LPAC security capabilities, Job Object kill-on-close/breakaway and cleanup. Distinguish implemented APIs from intended design and test fixtures.
3. Assess all eight VM scenarios individually: what kernel/host-side observations prove PASS, what merely supports a weak inference, what instrumentation is missing, and what constitutes FAIL vs BLOCKED. Design a minimal, independently verifiable evidence manifest, controller architecture and chain of custody; distinguish GitHub-hosted Windows runner from independently controlled disposable VM.
4. Prioritize missing crash-cleanup scenario 8: deterministic synthetic worker pausepoints, independent host controller for forced broker death, PID/process tree and Job Object observations, timeouts and no retry on ambiguous state, artifact privacy and disposal.
5. Audit VM_EXECUTION_RUNBOOK.md ordering for pins, signatures and safe rollback; review test-only signing and evidence provenance. Identify requirements before *any* VM execution, not approval to execute.
6. Return a concise independent recommendation for the next Codex patch: concrete fixes ranked P0/P1/P2 and tests to add. Do not claim build/runtime PASS unless verified evidence is linked.

## Mandatory acknowledgement and response
On ACTUAL receipt, post to GitHub Issue #40 (if GitHub write available):
```text
[CODEX-CHAT ACK gemini_v12_review_0035]
Agent: Gemini
Source SHA: c960e795f150d8775bae26eb8416be7907bc18e3 (or NOT_ACCESSIBLE)
Status: ACCEPTED | NEEDS_INPUT | BLOCKED | DECLINED | UNSUPPORTED
GitHub write access: YES | NO
Polling every 5 minutes: VERIFIED <evidence> | POLLING_BLOCKED
Missing inputs: <exact link/file or NONE>
```
Always provide final status, including if blocked:
```text
[CODEX-CHAT RESPONSE gemini_v12_review_0035]
Outcome: DONE | PARTIAL | BLOCKED | FAILED | DECLINED
Evidence: <pinned code links, findings, independent measurements or NONE>
Unresolved: <blockers>
```
If no GitHub write access, declare POSTING_BLOCKED. Do not fabricate a direct GitHub ACK. The coordinator must clearly attribute any relay; no receipt is inferred from this publication. No independently running agent-side scheduler is assumed.

## Safety scope
Source review only. No real Codex launch, local Windows broker execution, privileged modifications, credential/tunnel changes, production changes or modification of CODEX_DISABLED. All code changes through separate draft PR with explicit authorization; findings in Issue #40.
