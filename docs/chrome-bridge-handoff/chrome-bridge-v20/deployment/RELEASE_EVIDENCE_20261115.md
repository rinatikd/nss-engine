# Chrome Bridge PR #113 — release evidence and remaining gates (2026-11-15)

## Proven from existing records (do not repeat without a material change)

- Windows (operator transcript): pinned GitHub ZIP commit `4d0982724b02a748aeba42bca5fe36602edf4b95`, **59/59 Node tests passed**, zero failed and skipped; this is not an authenticated Git checkout.
- Windows (operator transcript): `PR113_ZIP_PAIR_STAGED_NOT_INSTALLED` for `C:\Engineering\ChromeBridge-PR113-ZIP-Lab17484-Stage`, 48 files; staged but not started or installed.
- Windows PowerShell Direct: port `17484` has an existing `node.exe` listener, PID `29428`; operator supplied its process command line pointing into `C:\Engineering\chrome-bridge-pr102-release-test\...\server\bridge.mjs`. **17484 is PR102; do not stop, replace or borrow it.**
- Connected PR102 Chrome Bridge: browser `connected:true`, agents Claude/Gemini/DeepSeek/Grok discovered; this does **not** prove any PR113 send/reply.
- Connected production Chrome Bridge: browser `connected:false` at most recent inspection; leave production ports `17381/17382` and credentials unchanged.
- Windows Workbench `workbench_status`: `execEnabled:false`, `providersConnected:[]`. This prevents autonomous arbitrary Windows script deployment. Direct PowerShell tools allow only specific operations with separate local approvals.
- GitHub Actions workflows were previously unavailable/failing without completed job steps due account/service restrictions; do not cite their red state as test failures or passing evidence.

## New corrective changes after the Windows 59/59 source snapshot

- Commit `8a2a63b9a08b187052d8667ac6870d46def1afbf`: `extension/background-coordinator.js` refuses `start` without explicit offscreen ACK and rejects `stop` without explicit ACK unless Chrome proves the host no longer exists.
- Commit `2658cc5c3873d1095e054300e47f62c50e27d0ba`: four Node test cases for denied start ACK, denied stop ACK, unreachable live host, and absent host.
- Isolated V8 evaluation performed on the **exact GitHub source blob** `4f8b25d8b70a899cce9257c684ece92ad269ac73` and **exact test source blob** `5e39d98953f7be1198b2be04c700e19e5dac6b94`. Import statements were removed, imported approval/grant dependencies substituted with lightweight stubs, and existing 13 test bodies executed with assertion shims: **13 PASS / 0 FAIL**. This is **not** original Node.js test execution and not Chrome E2E. The most recent corrected code has **not** been run against the full original Windows test suite.
- The 17482 stage script is a candidate, not proof of a free port: historical project records have included a listener on 17482. Never start PR113 there without a fresh nonintrusive port-binding check.

## Objective release acceptance (still open)

1. Provenance: pristine staged PR113 source matches a pinned commit and its released extension/server pair; server-side origin pin and browser token are paired only to isolated lab, without exposing secrets.
2. Original Node tests including four new negative ACK tests pass in a real Node.js process on release source.
3. Port profile available, PR113 installed and connected to **its own isolated browser profile and own lab server**, distinct from existing PR102 and production.
4. One-click Connect/Disconnect permission request, externally revoked wildcard host scopes, startup recovery and explicit disconnect work in actual Chrome; no stale connected state.
5. Real provider agent send/ACK/reply and message correlation, uncertain-outcome no duplicate retry, blocked risky actions, grant revocation, restart, recovery and rollback demonstrated.
6. No production/PR102 server, credentials, extension IDs, profiles or tunnels changed without independent acceptance and recorded rollback.
7. Independent code/security review and actual reproducible package provenance.

## Current decision

**Draft / NO-GO.** Do not tag or publish production release or mark E2E passed until gates above have real evidence. Continue source review and local isolation work with already connected tools; no new request to the operator to download, run a script or approve a task.
