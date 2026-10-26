# Windows Broker v0.11 validation report

Date: 2026-10-26 (Asia/Qyzylorda)

## Revision and scope

This report describes the source-only v0.11 package proposed in draft PR #48. The authoritative revision is the PR head commit SHA linked from Issue #40 after publication. No Windows Broker executable was built or launched. No Codex process, model, MCP tool, production service, credential, tunnel setting, active CODEX_HOME, or CODEX_DISABLED setting was changed.

## Local source-only validation

- **PASS: 21** Node tests: policy trust-boundary and nonce lifecycle, synthetic launch ordering and rollback, native-inspector source contract, package/schema/workflow gates.
- **PASS:** `node --check .\\policy.mjs` and `node --check .\\launch-trace.mjs`.
- **FAIL: 0** in the final local run.
- **SKIP: 8** explicitly skipped Windows OS integration scenarios.
- **BLOCKED: 8** host-observed VM probes: AppContainer/LPAC token and capabilities; Job Object limits and breakaway/kill-on-close; protected ACL and reparse/hardlink race; explicit inherited handles/environment; network denial; synthetic credential/profile denial; child-process escape; crash cleanup.

Command run from `codex-handoff-output\\windows-broker-v11`:

```powershell
node --check .\\policy.mjs
node --check .\\launch-trace.mjs
node --test .\\tests\\policy.test.mjs .\\tests\\launch-trace.test.mjs .\\tests\\native-inspector.test.mjs .\\tests\\package-gates.test.mjs .\\tests\\windows-integration.test.mjs
```

## Trust boundary and launcher status

`policy.mjs` accepts only strict bounded policy data with non-placeholder SHA-256 pins and signer certificate SHA-256 pins. It rejects caller-provided signature/ACL snapshots. Nonces are internally generated, bound, single-use, TTL-limited, capacity-bounded, and cleared on process generation restart. Attestation parsing checks shape only and always reports `hostOriginVerified:false`, `osIsolationProven:false`, and `executionAuthorized:false`. `verifyPinnedImage()` and `validateProtectedAcl()` fail closed because authenticated native providers are not linked.

The launch transaction exists only as a JavaScript event-trace fixture and a reviewed native implementation design. There is no native `CreateProcessW(CREATE_SUSPENDED)` launcher; therefore image identity continuity through `ResumeThread`, `STARTUPINFOEX/HANDLE_LIST`, AppContainer assignment, and Job Object enforcement are unimplemented and unproven. The event tests are not OS evidence.

The eight VM procedures in `VM_TEST_PLAN.md` are specifications, not runs. They require a disposable, independently observed Windows VM, synthetic fixtures, evidence tied to the exact tested commit, and cleanup/rollback records. The workflow added by this proposal is manual source-only CI and was not dispatched in this local validation; no GitHub CI result is claimed here.

## Decision

- **GO:** continue source-only review and implementation in the draft branch.
- **NO-GO:** native launcher use, local Codex execution through the broker, VM isolation claims, production activation, or cutover until a native launcher is implemented and independently verified with all eight host-observed VM probes.
