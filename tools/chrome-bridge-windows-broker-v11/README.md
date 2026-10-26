# Windows Broker v0.11 — fail-closed source-only design

This separate proposal is stacked on PR #47, which is stacked on PR #46. It hardens the JavaScript policy boundary, defines a single-use bounded nonce ledger, documents the required Windows suspended-launch transaction and gives an eight-case disposable-VM test specification.

## Decision and limits

**NO-GO for a native launcher, Codex execution, or production activation.** `policy.mjs` rejects caller-supplied signature/ACL snapshots because no authenticated native verifier/provider is linked. `verifyPinnedImage()` always fails with `NATIVE_HANDLE_VERIFIER_NOT_LINKED`; `validateProtectedAcl()` always fails with `NATIVE_HANDLE_ACL_PROVIDER_REQUIRED`. The source-only JS event fixtures model sequencing; no Win32 process is created or measured.

No C++ executable was built or run. No unsigned binary was launched. The previous read-only `image_inspector.cpp` source remains a diagnostic and does not call `CreateProcessW` or `ResumeThread`. See [NATIVE_LAUNCH_DESIGN.md](NATIVE_LAUNCH_DESIGN.md) for the required implementation and exact rollback path, and [VM_TEST_PLAN.md](VM_TEST_PLAN.md) for the eight probes.

## Source-only checks

```powershell
Set-Location C:\Engineering\chrome-bridge\codex-handoff-output\windows-broker-v11
node --check .\policy.mjs
node --check .\launch-trace.mjs
node --test .\tests\policy.test.mjs .\tests\launch-trace.test.mjs .\tests\native-inspector.test.mjs .\tests\windows-integration.test.mjs
```

These checks validate parsing, fail-closed JavaScript behavior, event-trace fixtures and source shape. The eight integration scenarios remain explicit skips. They do not establish Windows sandboxing.

The GitHub workflow is `workflow_dispatch` only, requires a boolean source-only acknowledgment, has read-only contents access and does not build/execute native binaries. Do not dispatch it as an OS isolation test.

## Policy behavior

- Strict JSON-only parsing, fixed key allowlists, bounded policy size, exact SHA-256 pins, exact signer certificate SHA-256 pins, fixed version strings and Windows path syntax checks.
- Zero/example pins are rejected. The `.json.in` example deliberately contains zero pins and cannot be accepted as runnable policy.
- Path syntax is not file identity; the module does not claim TOCTOU protection from strings.
- Caller-provided bytes/signature and ACL JSON are never accepted as OS trust evidence.
- Challenge nonce is generated internally from 256 random bits, bound to all policy/image/workspace pins, single-use, consumed before evidence validation, monotonic-time limited, bounded to a configured maximum, purged on expiry and cleared when the process generation restarts.
- Attestation checking validates report shape only; it always returns `hostOriginVerified:false`, `osIsolationProven:false`, and `executionAuthorized:false`.

## Review coordination

Qwen, DeepSeek, Gemini and Grok source handoffs are posted in Issue #40 after the PR head SHA is known. Their receipt is unconfirmed until each reviewer posts its own ACK in that issue. Do not attribute any finding to those reviewers before a matching ACK/RESPONSE.
