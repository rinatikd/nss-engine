# Hosted Windows runner feasibility — request 0020

## Verdict

**Feasible as a disposable Windows guest for non-production synthetic probes, with conditions. Not a complete independent hypervisor-attestation environment.** GitHub documents that each GitHub-hosted job is provisioned in a new VM and decommissioned after the job; Windows 2022 and 2025 are standard runner labels. A test controller process in the VM can independently query a child broker's Windows token, Job Object membership/limits, process image path, handles, ACLs and exit state. It is independent of the broker process, but still runs inside the same guest. It cannot independently attest GitHub's hypervisor, guest image integrity, or runner host internals.

This package does not start a workflow or compile/run broker binaries. Its workflow is `workflow_dispatch` only and contains source checks only.

## Eight-probe feasibility matrix

“Can run without admin” describes the likely API access for a future synthetic probe on the hosted guest, not a passed test. Actual permissions vary with runner image and policy; a probe must detect unsupported APIs and report BLOCKED rather than infer PASS.

| Probe | Hosted Windows 2022/2025 | Administrator / external dependency | What can be measured by a separate controller | Status now |
|---|---|---|---|---|
| AppContainer token, package SID, zero capabilities, LPAC | Likely feasible without admin for a process created with supported process attributes | Windows version/API support; API return state must be recorded | `OpenProcessToken`, `GetTokenInformation` and canary access probes | **BLOCKED**; no runnable launch binding |
| Job limits, kill-on-close, breakaway denial | Likely feasible without admin for a process the controller creates | Hosted runner may itself use a Job Object; nested job assignment can fail and is a hard BLOCKED | `IsProcessInJob`, `QueryInformationJobObject`, close job, inspect all descendants | **BLOCKED**; no broker/worker execution |
| DACL + reparse/junction/hardlink + mutation race | Owned temp files and hardlinks are normally user-creatable; symlink creation can depend on Developer Mode or privilege | Forcing OS-wide policy or privileged ACLs needs a different VM; filesystem and symlink support must be recorded | Handle identity, link count, reparse tag, ACL read through handle, competing writer/rename process outcomes | **BLOCKED**; no adversarial probe |
| Inherited handles and environment allowlist | Feasible without admin with explicit process attributes and a synthetic canary handle/env var | Requires implementing the restricted launcher | Controller checks handle list/inheritance and child reports only non-secret synthetic values | **BLOCKED** |
| Network denial | AppContainer network denial can be tested without admin with controlled local listener probes | External egress claims require a controlled endpoint and provider network policy; no public endpoint should be used as a security oracle | Controller owns a local TCP listener and verifies child connection denied; capture runner/child results | **BLOCKED**; no test run |
| Synthetic credential/profile denial | Feasible without admin using a random marker file with ACLs in the temporary workspace | Do not use runner secrets, account profiles, token files, credential stores or real data | Controller creates marker; child reports only access result and never reads/prints contents | **BLOCKED** |
| Child-process escape | Feasible without admin where child-process restriction is supported | Must be set at process creation; unsupported flag is BLOCKED | Controller observes `CreateProcess` denial and enumerates process tree | **BLOCKED** |
| Crash cleanup | Feasible without admin for a synthetic process tree/job and temporary profile | Runner hard-kill/reimage is controlled by GitHub; cleanup after VM destruction cannot be inspected from inside the guest | Controller kills synthetic broker at phases, waits job empty, checks temp profile/workspace removed | **BLOCKED** |

### Admin-only / host-level boundaries

- Creating or controlling a nested Hyper-V VM, changing global firewall/network rules, installing privileged services/drivers, or collecting hypervisor-level process/memory telemetry is **not available** as an ordinary hosted job and is outside this workflow.
- Host-side observations from a parent/controller process in the same guest are independent measurements relative to the tested broker, but do not qualify as hypervisor-side independent attestation. If the acceptance criteria require a second privileged observer outside the guest, use a customer-controlled disposable VM and host collector.
- The hosted test can prove only the recorded runner image and that run's OS behavior. It cannot certify production Windows endpoints or other runner image revisions.

## Missing precondition: bind verified image to process creation

PR #46's inspector does not create a process. Before any future synthetic OS probe, a separately reviewed staging launcher must:

1. Open the pinned worker executable with `FILE_FLAG_OPEN_REPARSE_POINT` and a share mode denying writes and deletes; reject reparse points and multiple links.
2. Hash the bytes on that handle; verify Authenticode via `WINTRUST_FILE_INFO.hFile`; pin signer cert hash, exact final handle path, file ID and handle-derived owner/DACL. Source pins must be in a reviewed test manifest.
3. Hold that file handle while calling `CreateProcessW` on exactly the pinned application path with `CREATE_SUSPENDED`, explicit inherited-handle list and AppContainer/child-process attributes.
4. Before resume, query the child image path through the process handle, open the reported image read-only, and compare `FILE_ID_INFO` and SHA256 with the still-open pinned handle. Query token, capabilities, Job Object and environment/handle state from the controller.
5. Assign the suspended child to a kill-on-close Job Object with breakaway disabled. Only after all checks succeed may `ResumeThread` be called. Every error path terminates the child, waits for death, closes the job and handles, and returns failure; there is no fallback launch.

The design is not implemented in this package. A hosted runner must not be used to paper over that missing control.

## Workflow policy

`.github/workflows/source-only.yml` has only `workflow_dispatch`; it is not scheduled by PR/push and this task did not dispatch it. It reads source only, checks the feasibility manifest includes all eight cases, and verifies the v0.10 image inspector has no process-launch APIs and remains `executionAuthorized:false`. It does not invoke `cl.exe`, compile binaries, create a process, access secrets, or change `CODEX_DISABLED`.

Before a future manual isolation workflow exists, reviewers must separately approve pinned source SHA, runner image label, test-only signer creation/trust, synthetic worker behavior, and the explicit `CreateProcessW` test. The test should use no user-supplied/repository/environment secrets; `GITHUB_TOKEN` should have only contents read for checkout and must not be passed to any child.

## Current result

- PASS: runner feasibility assessed from official GitHub-hosted runner lifecycle and label documentation; static package checks are designed to be source-only.
- FAIL: 0 executed probes.
- SKIP/BLOCKED: all eight probes; no binary was built or run.
- NO-GO for Codex launch, production cutover, or opening a direct Codex channel.
