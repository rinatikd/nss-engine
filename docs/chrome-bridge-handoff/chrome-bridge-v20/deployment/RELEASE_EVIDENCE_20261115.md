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

## Worker ACK protocol hardening — source commits after the initial report

- `496bc729320bdeab9b8b96684948ff972b9470fb`: transport Worker correlates `requestId` and sends `control-ack` only after processing start/stop. A stale start ACK after a later stop becomes a negative `START_SUPERSEDED_BY_STOP`.
- `77ae0fa9d0d40fa5c0ceb4c42c5d098fd45cb3cb`: offscreen host waits for an actual Worker ACK; never treats `worker.postMessage` alone as proof of completed control. Correlates command type/request ID, fails closed on post error or bounded timeout (5000 ms).
- `dd50e40c1eca2a2df303281cbd6bc249c48d2891`, `2916b9fb35009446817ae80d0fdfc601851897fe`, `93381294261a3ce0ac7c9cc10291d443fc67fbdb`: test cases and asynchronous test synchronization for the above control protocol, including stop overtaking a delayed start.
- `f922245bd26488532493ee91fb0e57c12a6daa8b`, `9b1c97d040a6f53e04d1335396809f2709da3002`: require the new transport ACK suite in existing release staging and ZIP source test scripts.
- `b7f23757082d84f66db880cc2c93c640a6f7c3e6`: add GitHub Actions Node 24 unit-test workflow over the full Chrome Bridge `tests/*.test.mjs` suite (not Chrome E2E).

**Evidence:** exact GitHub host/Worker source modules and eight test bodies executed in an isolated V8 harness with synthetic `vm.runInNewContext`, Worker, Chrome and assertion interface: **8/8 PASS**, zero failed. A separate in-memory message-exchange smoke check of exact host and Worker source confirmed positive start/stop ACK and no token in ACK. These remain **non-Node, non-browser tests**. A GitHub Actions workflow was queued on latest head during inspection; pending/failed CI must never be reported as successful testing.

**No user handoff:** no new local operator approval, download or manual command requested. No production, PR102 installation, runtime credentials or tunneling altered. Release remains **Draft / NO-GO** pending actual installed lab E2E and full validation.

### Latest CI availability verification

Workflow run `43732207788` (Chrome Bridge PR113 release source tests, triggered by commit `429d099e19ff88a1651a2fee82dedab3005a13f2`) finished with `conclusion=failure`, but the sole Node test job `132866918923` has **zero returned execution steps**. This is a CI infrastructure/runner-availability blocker, not evidence the Node tests failed. Do not re-run or treat this as a test result until GitHub runner/account restrictions are resolved. The release suite remains unexecuted on this new head in an actual Node runtime.

### Active credential mismatch / stale failure hardening

- Commit `c1f4f1ba8bb5f556bf6be84e49f7253febf24c78`: Worker refuses an attempt to change an already-active transport's browser token without a disconnect; previously, `BridgeTransport.start()` would return `false` and the Worker ACK would still be `{ok:true}`, leaving the old token silently active. A superseded start rejection no longer overwrites the later stop/reconnect transport state.
- Commit `d757a87067e676345a1a8439016779d363097687`: negative-path regression checks for active credential mismatch (including ensuring ACK never echoes tokens) and obsolete rejected start after stop.
- **Executed:** 10/10 V8 isolate evaluations of all current `tests/transport-control-ack.test.mjs` test bodies against fetched current `transport-host.js` and `transport-worker.js`; all PASS, zero failures. These are original JS test bodies using synthetic Node VM/assertion interfaces. They are not actual Node `node --test` and not Chrome E2E.
- No operator downloads, approvals or Windows commands. PR113 remains Draft / NO-GO until actual release-source Node CI and real isolated Chrome provider E2E.

### Status-check read/Disconnect race — 2026-11-15

- Commit `433e54d9af9b4c3432ec4b3d74b878f04ab1a473`: add a synchronous `disconnectEpoch` fence before any asynchronous stop cleanup. Any in-flight positive `transport-status` validation initiated before Disconnect is rejected even if an asynchronous storage read later returns a stale enabled snapshot. Existing session-flag checks remain mandatory.
- Commit `e7266022dd1e092cefd539160f393738d5d0763a`: regression test specifically holds an async positive-status storage read, performs Disconnect, then releases an obsolete all-true snapshot and asserts no connected status.
- Current fetched source blob `01b52ba735a16d1227293f11fb854a219b4bac12` and regression test blob `6bbf7fa146c3e85162027050fde6e59c2724c62b`: **16/16 original test bodies PASS** in isolated V8 with substitute imported dependencies, zero FAIL. Not a Node.js run or Chrome E2E.
- Container Node.js is present (v22.16.0) but network access to GitHub is unavailable; current GitHub private source not materialized into this runtime. Do not describe these isolate results as authentic Node.js CI. Production and PR102 untouched; no Windows operations, downloads or confirmations requested.

### Failed Connect rollback and honest control_status — 2026-11-15 (latest)

- `4dc298724f2d8b992f07bc8a055af66622b930f3`: a failed attempted Connect now explicitly runs background `stop()` after persisted dispatch rights are disabled. A Worker that started before a lost ACK must not be left polling invisibly. Stop failure returns `CONNECT_ROLLBACK_UNCONFIRMED`; denial at permission/pairing stage does not stop pre-existing sessions.
- `d2c1ab103d7a92704401177de609a1ccbf0d6822`: three targeted tests for failed-start cleanup, uncertain rollback and refusing unnecessary stop on permission or pairing failure. Fetched exact JS blob `c9265ae80cb085177edb70f6a88d7212ac0b8413`, test blob `0efc84818038e1cf8d4bab69fd686ab9af2e4324`: all **20/20** test bodies passed in isolated V8 (URL parser and assertion shims; not Node.js test runner).
- `85d87cec8aa7b22d0d89df2f8a81e001712f9837`: `control_status` now distinguishes desired connection (`connectionDesired`) from actually observed coordinator transport (`connected`). `globalEnabled` requires live observed connection, all-tabs flags and both current wildcard host permissions; permission errors fail closed.
- `24ea6d684e848a1895fbe42c9f85b03420108bea`: coordinator supplies observed transport status to read-only dispatcher rather than treating `bridgeConnectionDesired` as proof of connection.
- `c033d93dee0887c37cb5fa078a3d2af1ae1ab81a`: tests for false positive disconnected transport and separately revoked HTTP/HTTPS permission. All **5/5** dispatcher test bodies passed in isolated V8 with simulated browser dependencies; not Node.js/Chrome E2E.

Independent real Node/Chrome testing on latest commit and full security review remain mandatory release gates. GitHub's PR113 test workflow previously failed with no executed runner steps and cannot be claimed PASS. No user action requested, no direct changes to production or PR102.

### Source-only release preflight: server / extension pair

- Fetched exact PR113 `server/bridge.mjs` blob `dd68accf9f81a925d9990de4a15309966e13ad68` for source review. Server declares component `VERSION='0.2.0'` while extension manifest declares `0.3.0` — these may represent independent component versions; release manifest must explicitly record both and prove compatibility on the staged pair, not assume they match.
- Server uses `CHROME_BRIDGE_PORT` (default 17381) and `CHROME_BRIDGE_HOME` (default user home). Existing separate staging scripts are required to force isolated lab settings. Never start the repository server directly without verifying stage-specific overrides.
- `loadConfig()` creates fresh random `agentToken` and `browserToken` when no isolated config exists; this does not automatically pair an unpacked extension. Exact extension origin pin (`extensionId`) is part of runtime config/validation.
- `/bridge/poll` and `/bridge/result` own dispatch/ACK handshake and a single active command; on ACK loss, do not infer successful delivery or retry non-idempotent operations. Source inspection is **not** a live E2E demonstration.
- Test evidence across earlier snapshots is deliberately kept separate. Most recent source-only tests were one-click session **20/20** and read-only dispatcher **5/5** in V8 using real fetched JS test bodies with injected shims; the latest release HEAD is not independently Node/Chrome-tested.
