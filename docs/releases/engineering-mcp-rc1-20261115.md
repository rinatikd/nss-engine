# Engineering MCP — RC1 release candidate

**Status:** CANDIDATE / NOT YET SHIPPED. Prepared 2026-11-15.
**Base branch:** `platform/ai-windows-control-release-20261114` (PR #110).
**Release branch:** `release/engineering-mcp-rc1-20261115`.
**Experimental features excluded:** `feature/chatgpt-approval-ux-20261115` (PR #115).

## Purpose

Give ChatGPT a real, bounded direct Windows engineering toolchain for Git diagnostics, approved Node.js tests, approved project scripts and .NET build/test, PID/port inspection, with an operator-controlled MCP service and audit log. The released capability is **not arbitrary remote shell**.

## Confirmed E2E evidence from installed Work PC

These have been observed as actual server responses, not simulated tests:

| Request | Operation | State | Evidence |
|---|---|---|---|
| `e2e-after-upgrade-git-status-20261115-r1` | `git-status` | FINISHED / exit 0 | Feature branch status |
| `e2e-node-test-20261115-r1` | `node-test` | FINISHED / exit 0 | 5/5 Node tests, 0 fail |
| Re-submit same Node requestId | at-most-once status check | No new result observed | Same terminal timestamp and stdout; does not establish every possible race is impossible |
| `e2e-deny-git-status-20261115-r1` | user denial | DENIED | `OPERATOR_DENIED` |
| `liveproof-git-branch-20261115-r1` | `git-branch` | FINISHED / exit 0 | `platform/ai-windows-control-release-20261114` |
| `liveproof-git-diff-check-20261115-r1` | `git-diff-check` | FINISHED / exit 0 | Clean diff check |
| `liveproof-node-version-20261115-r1` | pinned readonly Node version | FINISHED / exit 0 | v24.21.0 |

The operator has previously completed an explicit supervised cutover to the base service with `ENGINEERING_APPROVAL_UPGRADE_PASS`, and the local bootstrap/regression tests then reported 32/32. That evidence applies to the **then-deployed base**, not this new release branch's verification runner or PR #115.

## Release candidate scope

- Server on loopback `127.0.0.1:17486`, tunnel health `127.0.0.1:18086`.
- `powershell_engineering_submit` + `powershell_engineering_status`.
- Fixed command operations `git-status`, `git-diff`, `git-log`, `git-branch`, `git-diff-check`, guarded `git-pull-ff-only`, `node-test`, `node-script`, `powershell-script`, `dotnet-build`, `dotnet-test`, `process-inspect`, `port-inspect`.
- Unique request IDs, immutable plan digest, audit-first execution, bounded timeout, sanitized output, independent local operator approval for Engineering operations.
- Pinned read-only diagnostics through `powershell_chat_readonly`, **ChatGPT host permission must remain Always ask**.
- Existing protected DPAPI launcher for independent local approvals remains part of RC1. Direct in-chat approval for arbitrary code execution is **NOT** claimed.

## Explicit exclusions

- Codex CLI invocation, Codex checks, Codex token acquisition, paid Codex/API access; `CODEX_DISABLED` is intentionally accepted and is **not a blocker**.
- PR #115 preliminary enrollment, no-page execution, fixed `lab-checkout-pr115`, its tests and related GitHub Actions.
- Unrestricted shell, remote deployment/registry changes, service restarts from ChatGPT, broad filesystem mutation, `git push`, `git reset` or permission bypasses.
- Claims of automatic installation, full E2E on PR #115, or CI PASS without actual logs.

## Mandatory gates before promoting RC1 to RELEASED

1. On a **Windows checkout of the exact RC branch**, run `tools/powershell-direct/Verify-EngineeringMcpRc1.ps1 -Mode Verify -IncludeDpapi`; archive exit codes, test counts, timestamp, commit SHA.
2. Confirm installed tool discovery exposes exact Engineering operation enum, correct root and workspaces; local approval for writes/test execution remains enforced.
3. Exercise operator Allow and Deny on isolated benign job, read completed results, check reused requestId cannot re-run command.
4. Verify protected approval storage, audit directory ACL and redaction; no credentials in logs.
5. Confirm active parent/tunnel PID identities and health; verify other production listeners 17381/17382 and Workbench 18791 are unchanged.
6. Perform controlled rehearsal and only then operator-authorized deployment using reviewed scripts. No automatic service changes in this release preparation.
7. Test rollback to last-known-good stage with same connector registration and new request ID after recovery.
8. Record actual test evidence and release decision in PR. **Missing evidence = NO-GO**.

## Rollback and service boundary

- Existing supervised stack retains the known guarded upgrade path `Upgrade-EngineeringApproval.ps1`, which checks PID/health and backs up staged files before an authorized restart; the present release preparation **does not invoke it**.
- In case of failure stop only the verified new supervisor and its verified tunnel child; restore backed-up staged files, then revalidate health and connector tools. Do not touch 17381/17382, unrelated processes or credentials.
- PR #115 remains a separate draft. Only integrate it after its own isolated Windows E2E.

## Useful inspection commands (no service mutation)

The new `Verify-EngineeringMcpRc1.ps1` has `Inspect` (presence checks) and `Verify` (Node tests; optional isolated DPAPI tests). It never starts, stops or upgrades the supervisor, edits the production configuration, or invokes Codex.

**Release decision:** presently **RC1 PREPARED / NO-GO FOR PRODUCTION PROMOTION** pending Windows qualification evidence for the exact candidate.
