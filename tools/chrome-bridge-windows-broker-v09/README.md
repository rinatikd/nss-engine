# Chrome Bridge Windows Broker v0.9 source-only stage

This package is a reviewable source-only security contract for the next Windows Broker stage. It does not patch or import the live Bridge runtime, launch Codex, call a model, or enable execution. The example configuration is data-only and `enabled:false`; its zero hashes and placeholder version are not usable pins.

## Windows PowerShell source-only checks

```powershell
Set-Location C:\Engineering\chrome-bridge\codex-handoff-output\windows-broker-v09
node --check .\policy.mjs
node --test .\tests\policy.test.mjs .\tests\windows-integration.test.mjs
```

These run pure validator tests and synthetic filesystem fixtures. They do not launch the broker executable or Codex. AppContainer/Job Object/ACL/network/credential/process-escape behavior is not claimed by these tests.

## Configuration and trust boundary

- `policy.example.json.in` is a JSON template (the `.in` suffix keeps it out of local-runtime dump classifications). It allowlists named workspaces, forces read-only access, pins broker and Codex path/hash/signer/version, requires local per-job confirmation, denies dangerous actions, and sets hard limits. The parser rejects `enabled:true` in this stage.
- `policy.mjs` parses JSON only; it never imports policy code or returns an execution capability. Path, ACL, hash, signer and challenge helpers are validators, not native trust providers.
- `verify-image.ps1` is a read-only helper that compares file hash and Authenticode signer. It does not start the executable and does not prove ACLs, hardlink identity, or sandbox behavior. The example all-zero pins are placeholders; do not use them for a real executable.
- `attestation.schema.json.in` defines required AppContainer, network, credential, workspace, handle/environment, Job Object, and cleanup fields. A broker response cannot prove its own assertions; trusted native measurement and broker-image verification are still required.
- `v07-review.md` records the exact design gaps and the acceptance criteria for a future activation proposal.

## Status

- **PASS:** data-only schema and policy checks, mock hash/signature checks, ACL shape checks, path hardlink/reparse checks, nonce replay/expiry, and negative contract tests.
- **SKIP:** no real Codex or broker execution; no production configuration access.
- **BLOCKED:** real Windows OS boundary tests require a signed, hash-pinned broker and a disposable VM. Eight Windows integration scenarios are explicitly skipped.
- **NO-GO:** no execution gate change or Codex launch.

See `TEST_REPORT.md` for exact local results and limits.
