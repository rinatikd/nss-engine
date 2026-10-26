# Disposable Windows VM probe specification

This is an execution-design document only. None of the eight OS probes have run. Synthetic JS event fixtures and JSON claim-shape checks are not OS evidence. Run only in a fresh disposable Windows VM after a reviewed, signed/pinned staging broker and the native launch gate exist.

## Evidence trust model

The broker under test must not be the source of truth for its own isolation claims. A separate controller process outside the broker's AppContainer/Job gathers Windows observations using its own process/token handles. Evidence must include:

- Git commit SHA, workflow/VM image label, OS build, architecture, filesystem and test-case ID.
- SHA-256 and signer-certificate SHA-256 of broker, worker, controller and policy manifest, measured before launch and pinned independently by the controller.
- Controller identity and PID; child PID and creation time; process exit code; kernel-reported image path hash; volume serial and file ID.
- Native API return status plus relevant `GetTokenInformation`, `QueryInformationJobObject`, `IsProcessInJob`, file ID, ACL and process-tree observations. Redact all local paths and SID values except synthetic AppContainer SID and explicitly approved test SIDs.
- Per-case random nonce, monotonic timestamps, raw evidence schema version and hash. The controller signs the final manifest using a per-VM test-only ephemeral key; publish the verification key out of band with the artifact. This signature proves evidence artifact integrity after collection, not that the VM/hypervisor or controller was trustworthy.
- Host/VM console output and broker self-report may be attached as secondary data only. Acceptance uses controller observations. A real independently controlled host collector is needed for hypervisor-level attestation.

Any missing measurement, unknown OS status, timeout, crash, signer mismatch, untrusted controller output, or cleanup failure yields **BLOCKED/FAIL**, never PASS. Each case starts from a clean snapshot and runs one time. No automatic retries after ambiguous delivery or partial probe.

## Test-only fixture constraints

- A synthetic worker handles only fixed probe opcodes; it cannot spawn a shell or read arbitrary paths. Pins and argv are constant in the fixture.
- The guest has a fresh local test account, synthetic marker files only, no active Codex profile, no browser profile, no user secrets and no production credentials. Egress is limited to a dedicated test listener if the approved network probe needs it.
- The broker is test-signed with an ephemeral test-only code-signing identity trusted only inside the disposable guest. Its cert SHA-256 and executable SHA-256 are in the host-pinned manifest. This tests plumbing only and is not a production trust claim.
- All probes use a new random workspace/profile/job ID and a cleanup journal. A controller watchdog holds VM snapshot metadata and process inventory. Do not copy secrets, crash dumps or credential stores into artifacts.

## Eight host-observed probes

### 1. AppContainer, LPAC and capabilities

**Fixture:** fixed synthetic worker, fresh AppContainer profile, zero explicit capability SIDs, LPAC opt-in. Include canary files protected from the AppContainer SID.

**Steps:** controller records worker token before resume; compare AppContainer SID to created profile, query `TokenCapabilities`, and run harmless access probes for blocked locations. Also exercise loopback behavior in the network case.

**PASS evidence:** controller-observed AppContainer token is true; SID matches; capability group count is zero; low-privilege/LPAC requirements are independently confirmed by supported token/access APIs; canary access denied. Unsupported API or ambiguous token result is BLOCKED.

**Rollback:** deny resume on any mismatch; otherwise terminate Job after the probe; delete profile and canaries; verify process and profile cleanup.

### 2. Job limits, kill-on-close and breakaway

**Fixture:** synthetic worker branches attempt fixed child creation/breakaway operation; Job configured for one active process, kill-on-close, memory/CPU caps and no breakaway.

**Steps:** create worker suspended; verify its file identity; assign it to the Job before resume; query Job limits and `IsProcessInJob`; ask worker to attempt the denied child path; close the Job during a separate hold subcase.

**PASS evidence:** controller confirms Job membership, exact limits, kill-on-close set, breakaway flags absent, child creation denied, and closing Job results in worker termination/zero active processes. Inability to assign inside hosted-runner nesting is BLOCKED for that runner.

**Rollback:** terminate Job on any mismatch; wait for no active processes; close all process/thread/job handles.

### 3. DACL and reparse/junction/hardlink mutation races

**Fixture:** separate synthetic candidate files for valid protected ACL, writable ACE, inherited ACE, broad SID, symlink/reparse, junction and hardlink cases. A competing actor performs bounded write/rename/repoint attempts against the open candidate.

**Steps:** controller opens and measures the candidate; launcher must hold the exact handle denying write/delete shares; attempt each alias/race while suspended; query image handle/file ID before any resume. Do not use real executables.

**PASS evidence:** all unsafe ACL/alias fixtures fail closed; concurrent write/delete/rename fails while the measured handle is held; post-create process image file ID equals the pinned handle ID; no changed file reaches resume. If symlink creation is disallowed by runner policy, that subcase is BLOCKED, not inferred.

**Rollback:** terminate/wait child on any mismatch; close handle; remove all alias fixtures/junctions and confirm none remain.

### 4. Inherited handle list and environment

**Fixture:** three intended stdio pipes, one extra synthetic canary handle, and poisoned environment variables containing non-secret sentinels.

**Steps:** launch suspended with `STARTUPINFOEX` and explicit `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`; controller enumerates child handles using a supported inspection method and asks worker to print only variable names and sentinel-match booleans.

**PASS evidence:** only stdin/stdout/stderr are inherited; canary handle is absent/unusable; environment is exactly the configured allowlist; no sentinel values leak. If child handle enumeration is unavailable, use an instrumented signed test helper plus controller-side duplication/access checks and mark confidence; do not accept worker self-report alone.

**Rollback:** close child/pipe handles, clear parent environment changes if any, remove fixture marker.

### 5. OS-level network denial

**Fixture:** controller-owned loopback listener and an explicitly authorized disposable test endpoint if external egress is required. No public third-party site is used as an oracle.

**Steps:** worker attempts bounded loopback and controlled endpoint connections with the exact restricted token and no network capability; controller independently records listener acceptance, connection attempts and child token. Controller connectivity is tested separately as a control.

**PASS evidence:** worker connections are denied at the OS boundary and controller can reach its test listener; host firewall/network capture or socket status corroborates. If environment-level egress filtering prevents attribution, the result is BLOCKED rather than credited to AppContainer.

**Rollback:** stop listener, close sockets, remove firewall/route changes (prefer none), terminate and wait Job.

### 6. Synthetic credential/profile denial

**Fixture:** random synthetic marker files only, with a fake Codex profile directory and fake token-named file. Never inspect real profile or credential paths.

**Steps:** controller creates ACL-protected files and records file IDs/ACLs; worker makes fixed read-open attempts and returns only success/error codes. Controller re-reads ACL and hashes to detect mutation.

**PASS evidence:** every open is denied; no bytes/hash/content are emitted; ACL and marker hash remain unchanged. Any access success is FAIL.

**Rollback:** terminate Job; remove markers/profile; verify removal through controller handle/path inventory.

### 7. Child-process escape

**Fixture:** worker's only escape attempt is a fixed harmless child creation with a known test image; no shell or arbitrary command execution.

**Steps:** set `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY` before suspended creation; assign Job before resume; let worker issue one create attempt; controller enumerates process tree and active Job count.

**PASS evidence:** child creation returns the expected denial, no child PID/image appears, Job stays at one process, and no process escapes the Job. Unexpected OS behavior is FAIL.

**Rollback:** terminate/wait Job and enumerate until no descendants remain.

### 8. Crash cleanup and rollback

**Fixture:** synthetic worker pause points before creation, after suspended create, after image compare, after Job assignment, and after resume; controller can kill broker at each point.

**Steps:** controller holds process/Job/file/profile handles, triggers each one-shot crash point, waits bounded cleanup window, records process tree, Job count, handle accessibility and fixture/profile inventory.

**PASS evidence:** every surviving child is terminated; no Job members or descendant PIDs remain; all broker-owned handles are closed; temp profile/workspace is removed or a bounded, auditable recovery action removes it; cleanup journal reaches terminal `CLEAN`.

**Rollback:** controller terminates remaining Job/process by recorded PID+creation time, removes only the trial-unique profile/workspace, restores snapshot, and records residuals. Any orphan/residual is FAIL and blocks further trial runs.

## Acceptance

All eight cases need controller-signed evidence bound to the exact staged source SHA and test-manifest SHA, independent source review, and successful rollback/cleanup. A test run on `windows-2022` or `windows-2025` proves only that runner image's observed behavior. It does not enable production or Codex execution; those remain separately gated.
