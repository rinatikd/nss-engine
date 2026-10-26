# Chrome Bridge Windows Broker v0.10: native inspection, execution blocked

This staged package addresses the five PR #45 review findings. It adds a read-only Windows image inspector that uses one open file handle for the image hash, Authenticode verification, file identity, final-path inspection and DACL/owner reads. It has no API or code path to create a process. It always reports `executionAuthorized:false`; it is diagnostic evidence only and is not a launcher or a sandbox.

## Local source-only checks (PowerShell)

```powershell
Set-Location C:\Engineering\chrome-bridge\codex-handoff-output\windows-broker-v10
node --check .\policy.mjs
node --test .\tests\policy.test.mjs .\tests\windows-integration.test.mjs .\tests\native-inspector.test.mjs
```

These tests include contract checks over native source and synthetic filesystem cases. Windows OS integration scenarios remain explicitly skipped.

## Native build and negative probe

On a Windows machine with Visual Studio C++ Build Tools:

```powershell
Set-Location C:\Engineering\chrome-bridge\codex-handoff-output\windows-broker-v10
.\tests\native-compile.ps1
```

This compiles to the runner temp directory, then inspects a synthetic unsigned file using all-zero hash/signer pins. It must reject the fixture. It does not inspect Codex, a production Bridge, user credentials or a real pinned broker. GitHub Actions runs the same compile and negative probe on `windows-latest`.

The inspector invocation, if built locally, is:

```powershell
.\image_inspector.exe <candidate-path> <pinned-sha256> <pinned-signer-cert-sha256> <pinned-owner-sid> <pinned-final-path>
```

It opens the candidate with read-only access and denies write/delete sharing, rejects reparse points and hardlinks, hashes the bytes read from that handle, asks `WinVerifyTrust` to validate the file using `WINTRUST_FILE_INFO.hFile`, pins the signer certificate DER SHA256, gets the file ID and queries owner/DACL through the same handle. It resolves the opened handle's normalized volume-GUID path and compares it with the pinned final path. It fails closed for unprotected DACLs, inherited ACEs, unapproved trustees, or write-capable ACEs. The diagnostic omits the local path. It prints file identity and hashes, so treat output as restricted host evidence.

The expected owner SID is a pin supplied by the operator; the inspector checks the observed Windows owner against it. The allowed DACL trustees are exactly that owner and LocalSystem, and their ACEs may not grant write/delete/ACL/ownership rights. This narrow policy can reject legitimate installation layouts; do not weaken it to make a candidate pass.

## Trust limits and activation gate

- The inspector is not proof of a safe process launch. A later launcher must bind the process it creates to the verified file identity and close the create/resume race.
- `GetSecurityInfo` can fail if the descriptor changes while queried; the result is only an observation. The file is never launched based on it.
- A locally supplied pin is not inherently trustworthy. Pins must come from a separately authenticated release record.
- This stage has no signed pinned broker, no positive signed-image fixture, and no independent disposable-VM results.
- `policy.mjs` still rejects `enabled:true`; no runtime wiring is added. Do not remove `CODEX_DISABLED` or start Codex through this package.

## Current decision

**NO-GO for execution and production cutover.** Keep the gate closed until a separate reviewed launcher binds immutable image identity across process creation and an independent disposable Windows VM completes the security probes. See `TEST_REPORT.md` for exact counts and evidence.
