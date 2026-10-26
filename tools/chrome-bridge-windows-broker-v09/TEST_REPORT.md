# Windows Broker v0.9 source-only test report

Date: 2026-10-26

## Exact status

- **PASS: 12** Node unit tests; `node --check policy.mjs` passed.
- **PASS:** Both `.json.in` templates parse as JSON; PowerShell verifier parses as a script. Its source only reads file metadata/hash/signature and never starts the image; it was not run against a real Codex or broker executable.
- **PASS:** No executable, object, library, or debug-symbol artifacts are included in the staging package.
- **PASS:** Final GitHub Actions Windows source-only workflow and repository Source checks passed on head `2564679578dd92473105a527074f481fd191a773`.
- **FAIL: 0 outstanding.** The first repo guard run rejected `package.json` as a local config file; the manifest was removed, and both final workflows passed.
- **FAIL: 0** test failures.
- **SKIP: 8** Windows OS integration tests. These are marked in the suite and did not run.
- **BLOCKED: 8** real OS enforcement claims: AppContainer token/capabilities, Job Object kill-on-close, protected ACL/reparse/hardlink race, inherited handle/environment isolation, network denial, credential/CODEX_HOME denial, child-process escape, and crash cleanup.
- **BLOCKED:** no signed/hash-pinned Codex Broker release is present and no disposable Windows VM attestation was performed.
- **NO-GO:** no runtime wiring or execution-gate change; no Codex/model/tool launched.

## What actually ran

The suite ran on Windows against temporary synthetic fixtures. It exercised a real temporary NTFS/Powershell-host filesystem hardlink and symlink rejection path (no credentials or Codex files involved). The remaining unit cases use mock image/signature and ACL evidence and synthetic broker claims. They verify strict fail-closed parsing, policy pin fields, nonce/request binding, replay/expiry, and rejection of weak evidence. A complete mock attestation returns `osIsolationProven:false` and `executionAuthorized:false`.

The eight OS integration cases are intentionally skipped because the checked-in v07 executable is an untrusted synthetic fixture and no signed/pinned broker release or approved disposable VM exists. No tests launch Codex or the existing broker executable.

## v07 review

See `v07-review.md`. Key blockers: v07 launches a fixture worker rather than Codex; `isolated:true` is self-reported and not a trusted attestation; network, credential, workspace-write, and child-process denial are not measured; its environment includes `LOCALAPPDATA`; `codex-runtime.mjs` rejects all policy modules; and `codex-policy.mjs` is not connected to a trusted native runner.

## Remaining decision

Keep the master execution gate closed. User permission to remove the disabled gate does not validate the native trust boundary. Reconsider only after the skipped VM tests pass with independently observed token, DACL, network, process, handle, and crash-cleanup results.
