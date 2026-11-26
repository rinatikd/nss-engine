# R4-REL — release baseline and evidence snapshot

**Snapshot date:** 2026-11-26 (Asia/Almaty)  
**Status:** PREPARATION / NO-GO for declaring R4 released  
**Purpose:** refresh the 2026-11-22 R4-REL plan with current repository heads and exact CI evidence. This file is an additive status record; it does not merge PRs, deploy software, change Production, or approve cutover.

## 1. Release definition

R4-REL is one coordinated release train for the engineering automation platform, **not one monolithic binary**. The components remain separately versioned and built:

1. Consilium / Control Room — task planning, equal AI-member permissions, evidence and independent review.
2. Chrome Bridge — provider transport and verifiable request/response receipts.
3. EDRP — the single Windows orchestrator and owner of durable operation state, leases and recovery.
4. Free AI Workbench — authenticated UI / viewer projection; not a second source of truth.
5. PowerShell Direct / WM43 — restricted diagnostics and separately authorized operations.
6. NSS Engine, AGPT Plugin and APS Expert — separate engineering products/adapters integrated through versioned contracts.

The release manifest, ownership, contracts, evidence chain, acceptance matrix and release order are unified; product source trees and their deliverables are not collapsed into one build.

Terminology remains separate:
- **R4-REL** — the coordinated release programme.
- **EDRP R4 / Rebuild** — the offline Windows rebuild/recovery level. Passing one does not imply passing the other.

## 2. Exact source and PR inventory

### 2.1 Consilium and Chrome Bridge

| Area | Current source | State | Verified evidence | Remaining limit |
|---|---|---|---|---|
| Six-provider discovery | NSS Engine PR [#130](https://github.com/rinatikd/nss-engine/pull/130), head `699d6ef866a80dc47c77317d15570a7b66546f45` | OPEN / Draft | Source is the base for #131 | Stacked draft; not integrated into main |
| Seven-member Control Room | NSS Engine PR [#131](https://github.com/rinatikd/nss-engine/pull/131), head `42f1f0bec01a2e2dc28f14170e27e6bc8965a5b1` | OPEN / Draft | Source checks #45113512959, Control Gates #45113513011, Visual RC #45113512888 — SUCCESS; synthetic Control Room package: 41/41 tests | Package/loopback evidence is not deployment, authenticated live council use, or provider send/reply |
| Chat-approved session contract | NSS Engine PR [#132](https://github.com/rinatikd/nss-engine/pull/132), head `16e07aa1a8c7c6f39af20da8a7eec33662fe0b09` | OPEN / Draft | Source #45234931860, Control Gates #45234931712, Visual RC #45234932012 — SUCCESS | The active live Lab registry was previously observed without session/provider transaction tools; no current correlated send/reply/revoke proof |
| Provider reply receipts | NSS Engine PR [#141](https://github.com/rinatikd/nss-engine/pull/141), head `52966e57a2a836e4df268c64b99142643c15af70` | OPEN / Draft | Source included in later integration stack | Receipt logic needs exact integrated-tree CI and live Lab verification |
| SendJournal first-settle-wins | NSS Engine PR [#140](https://github.com/rinatikd/nss-engine/pull/140), head `61697f40f31c0ea332b2c9a25a747966643596d5` | OPEN / Draft | Included in disposable integration lineage | Its first integration PR #144 explicitly records its former CI evidence as invalid; use the corrected #145 integration only |
| Integrated package + 30-tool gate | NSS Engine PR [#145](https://github.com/rinatikd/nss-engine/pull/145), head `bc0bdf89438fccd8a795738ae123b755acc06631` | OPEN / Draft | Corrects PR-CI checkout to merge SHA and requires exactly 30 MCP tools, including `provider_reply_wait` | Must use exact integrated merge candidate evidence, not old #144 runs |
| Kimi adapter source fix | NSS Engine PR [#146](https://github.com/rinatikd/nss-engine/pull/146), head `9031d8e4078b653de8a238f4908f777814ad7e45` | OPEN / Draft | Three exact-head workflows SUCCESS; route and safe contenteditable-fill tests | Live Kimi send/stop/reply selectors remain uncalibrated; no send performed |
| Kimi integrated stack | NSS Engine PR [#147](https://github.com/rinatikd/nss-engine/pull/147), head `9b90dbea8c4af817a1af6fbf9441f716d1463351` | OPEN / Draft | Carries Kimi fix onto the PR145 integration line | Draft; no live Kimi calibration |
| PR102 Lab StateRoot isolation | NSS Engine PR [#148](https://github.com/rinatikd/nss-engine/pull/148), head `7bda91a77d884d52f2daa8a07747ac1b43ed1a3e` | OPEN / Draft | Post-merge PR checks: Source #45709551186 (4/4 jobs PASS), Visual RC #45709551229 (2/2 PASS), Control Gates #45709551455 PASS; push checks #45709540843 (4/4 PASS) | The proposed 17485 StateRoot ownership/existence and runtime identity still require read-only workstation inventory before any Apply |
| Provider journal hardening | NSS Engine PR [#149](https://github.com/rinatikd/nss-engine/pull/149) | CLOSED / MERGED into #148 branch | Squash merge `7bda91a77d884d52f2daa8a07747ac1b43ed1a3e`; includes fail-closed lock handling, dispatch outcome semantics, UNKNOWN quarantine and OS-process regression tests | This merged PR did not merge #148, #147, #145, or main |
| Stop/Revoke linearization | NSS Engine PRs [#127](https://github.com/rinatikd/nss-engine/pull/127) and [#128](https://github.com/rinatikd/nss-engine/pull/128) | OPEN / Draft | Source / Control Gates / portable / Windows synthetic CI passed at their recorded heads | Not yet included in the #148 stack; real Chrome/Windows no-click-after-Stop and quarantine-recovery E2E remain open |

**Interpretation:** #148 is the most advanced current Bridge integration candidate in this chain and its post-merge CI is green. It is still a Draft source candidate, not a deployed Lab release. The #127/#128 Stop/Revoke line is a separate required integration/review item and must not be silently assumed to be inside #148.

### 2.2 Windows platform, EDRP and Workbench

| Area | Current source | State | Verified evidence | Remaining limit |
|---|---|---|---|---|
| Platform release track | NSS Engine PR [#110](https://github.com/rinatikd/nss-engine/pull/110), head `674e1fad2b64910b470222c5f17c87cd1df4e8eb` | OPEN / Draft / NO-GO | AI collaboration protocol workflow #45452312420 passed | Source checks #45452312461 failed only at the portable CCTV assertion: expected `'Observe, м': 23.0`, actual CLI output is `Observe, м: 23.0`. This is a stale test assertion, not a Bridge/PowerShell failure |
| PowerShell Direct per-job workspace | NSS Engine PR [#138](https://github.com/rinatikd/nss-engine/pull/138), head `73f3ad8f9ba0455ded2173bb583c6ed90c11b8c6` | OPEN / Ready for review, not merged | Source workflow #45561294815, protocol #45561294551, CCTV guards #45561294534 — SUCCESS; 80/80 Node tests, Windows PowerShell 5.1 parser, 31 journal assertions / 7 transactions, staged R2 CI integration | No current-candidate Work PC deployment, service replacement, tunnel replacement or cutover. Current PR text records a pending local R1 test and R2 execution disabled/read-only |
| EDRP architecture / R4 gate plan | NSS Engine PR [#134](https://github.com/rinatikd/nss-engine/pull/134), head `4ee3f772142d9154bcd9d26ce969c4c28a9937e7` | OPEN / Draft | Source checks #45113166923 — SUCCESS | Documentation/architecture only. Supervisor + SQLite durable runtime, crash/fault/recovery E2E and offline rebuild are not implemented/accepted |
| Free AI Workbench | NSS Engine PR [#111](https://github.com/rinatikd/nss-engine/pull/111), head `9ee6e02fbc6a0796985bc3756cfda5e4e3823323` | OPEN / Draft | Source #45046307182 and CCTV guards #45046307226 — SUCCESS; 17/17 Node tests | Offline ledger + static viewer only; actor/role are caller-supplied, unauthenticated; no EDRP-backed live projection or browser E2E |

The platform PR #110 is behind the current main baseline and its recorded portable failure is reproducible from the stale assertion. PR #150 below carries the corrected expectation and has green CI; integrate that shared baseline correction before using #110 as a final source gate.

### 2.3 NSS Engine product work and shared test baseline

NSS Engine PR [#150](https://github.com/rinatikd/nss-engine/pull/150), current head `52dfd0a7ae8464b42890af2689416afbadc16d5d`, is OPEN and not merged. It adds 11 CCTV CLI E2E tests, launcher review corrections and a Russian user guide. Exact-head runs #45710229559 (CLI guards), #45710229133 (Source checks), and #45710229731 (compile smoke) all completed SUCCESS. The local report records 15/15 unit tests and a clean smoke build; real AutoCAD input/ESC/file-lock behaviour remains unverified in AutoCAD. This PR is product work, not evidence of a platform release.

### 2.4 AGPT Plugin

Repository: [rinatikd/AGPT_Plugin](https://github.com/rinatikd/AGPT_Plugin). All items below remain OPEN / Draft:

| PR | Exact head | CI evidence | Release boundary |
|---|---|---|---|
| [#1 palette](https://github.com/rinatikd/AGPT_Plugin/pull/1) | `3a74df36ac418d1d914d77a1a09d081c8245126c` | GasCalc portable workflow #45052707765 SUCCESS | Palette only; calculation actions remain intentionally unavailable |
| [#2 GasCalc input validation](https://github.com/rinatikd/AGPT_Plugin/pull/2) | `aa2cd4a0293c1f3a8f1bd43f8625b50df4eb30e1` | Workflow #45046804152 SUCCESS | Standalone numeric validation; not yet main AutoCAD DLL integration |
| [#4 M1 provenance gate](https://github.com/rinatikd/AGPT_Plugin/pull/4) | `5297fec7a1016e619d460ce45ccde92c638019e1` | Provenance #45054521022 and GasCalc validation #45054521036 SUCCESS | Provenance-aware service/tests only; main DLL and real AutoCAD extraction still absent |
| [#5 M1b XData adapter](https://github.com/rinatikd/AGPT_Plugin/pull/5) | `ada59ef1a8a58e2d9bc8a3aa943b4825adffaec5` | Workflow #45055750120 SUCCESS | Adapter accepts host-extracted key/value data; does not yet extract AutoCAD entities itself, migrate XData or replace legacy commands |

Manufacturer-backed catalogue provenance, one unified calculation path in the main DLL, AutoCAD 2026 build/NETLOAD and disposable-DWG E2E remain release gates.

### 2.5 APS Expert

The GitHub repository `rinatikd/APS_Expert_0_15_commit` exists, but no current PRs were returned in the audited repository search. Its local/project history is not yet pinned here to a reviewed release commit, dependency/test manifest and AutoCAD 2026/.NET 8 smoke evidence. Therefore APS Expert is a planned R4 adoption target, not a declared component of this release candidate yet.

## 3. Gate status — refreshed 2026-11-26

Gate statuses are intentionally conservative: green source CI does not promote deployment/runtime acceptance.

| Gate | Current status | Reason / exit proof |
|---|---|---|
| G0 — Baseline & governance | PARTIAL | This snapshot pins major source heads; still need a final cross-repository artifact manifest, dependency graph, rollback references and the linked-chat criteria crosswalk |
| G1 — Consilium source readiness | PARTIAL | PR #131 exact-head source/control/visual CI and 41/41 synthetic tests pass; still need isolated live deployment, authenticated actor identity and an evidenced council round |
| G2 — Provider transport readiness | BLOCKED | Need isolated endpoint tools/list with session/provider methods, exact provider/tab/conversation/epoch binding, one owner-approved correlated Claude send + reply receipt and revoke/expiry evidence; then readiness for the other providers |
| G3 — Windows approval/control readiness | BLOCKED | PR #138 source/CI is strong, but current Work PC R2 is explicitly read-only/disabled; chat-only approval needs a genuine supported host attestation, exact-plan binding, durable one-shot replay claim and independent verification. Reconcile queue and WM43 effective-state discrepancy |
| G4 — EDRP durable runtime | NOT STARTED | Architecture exists; no accepted Supervisor/SQLite WAL+FULL/outbox runtime with crash, replay, disk-full, lease and recovery proof |
| G5 — Workbench integration | PARTIAL | Offline tamper-evident ledger/viewer tested 17/17; authenticated actor, EDRP read API projection, Windows/browser E2E and stale-lock recovery are missing |
| G6 — Engineering product integration | PARTIAL | AGPT numeric/provenance/XData-source suites pass; main DLL/real XData extraction/AutoCAD E2E and manufacturer catalogue verification are missing; APS Expert release baseline not yet pinned |
| G7 — Integrated Lab acceptance | NOT STARTED | No single correlated flow across council → Bridge/worker → EDRP → product adapter → evidence → Workbench with injected failures, Stop/Revoke and UNKNOWN quarantine |
| G8 — Recovery and release candidate | NOT STARTED | No immutable integrated RC manifest and no isolated offline Windows VM proof of R0–R4, restore and rollback |
| G9 — Owner acceptance | NOT STARTED | No acceptance record tied to exact final artifact digests; Production remains a separate approval/change request |

## 4. Updated blocker register

| ID | Blocker | Next evidence-based action |
|---|---|---|
| R4-B01 | Consilium runtime not established | Exact Lab package/process/extension inventory, authenticated owner + AI-member identities, synthetic round receipt; provider dispatch remains disabled until G2 |
| R4-B02 | Active Bridge registry/session surface not proven | Deploy only to a verified isolated Lab after pre-deploy inventory; capture full tools/list and exact source/process/extension identity |
| R4-B03 | Provider adapters not uniformly calibrated | Independent provider readiness matrix; Kimi send/stop/reply selectors remain uncalibrated; no broad/guessed selectors |
| R4-B04 | Workbench not authenticated/integrated | Bind actor identity server-side and expose read-only EDRP projection; browser E2E |
| R4-B05 | Windows approval channel / WM43 state unresolved | Keep R2 read-only; reconcile service/runtime capability tuple and queue; prove exact-plan approval without treating an ordinary MCP call as a signed user gesture |
| R4-B06 | EDRP is architecture-only | Implement minimal authoritative runtime after contracts freeze; crash and fault-injection tests |
| R4-B07 | AGPT main DLL integration incomplete | Validate XData extraction/mapping and one calculation path; build/NETLOAD on AutoCAD 2026 disposable DWG |
| R4-B08 | Manufacturer catalogue provenance incomplete | Use approved datasheets and hashes; reject unverified residual values |
| R4-B09 | Integrated recovery not proven | Isolated offline Windows VM; immutable restore bundle; R0–R4 cold rebuild, rollback and independent review |
| R4-B10 | User's shared R4 chat criteria not cross-walked | Import criteria from the share when the text is available; do not invent its contents or claim it was reviewed |

## 5. Immediate execution order

1. Freeze the manifest and the actual dependency graph. Keep source PRs stacked only when their ancestry is explicit; do not mass-merge all Draft branches.
2. Close the common portable baseline defect using the tested PR #150 correction, then rerun the platform source checks against the intended integration commit.
3. Complete independent review and integration of the Consilium/Bridge stack (#130 → #131 → #132 with the #140/#141/#145/#147/#148 line), preserving separate #127/#128 Stop/Revoke gates.
4. Integrate PR #138 into the platform line only after its exact current-candidate review and local staging evidence; no service/tunnel cutover as a side effect of source merge.
5. Complete authenticated Control Room + approved provider send/reply/revoke in isolated Lab.
6. Implement/accept EDRP runtime and Workbench projection; resolve the PowerShell/WM43 approval and effective-state discrepancy.
7. Complete AGPT main DLL/AutoCAD acceptance and pin the APS Expert candidate separately.
8. Run integrated Lab failure injection, offline R0–R4 rebuild, restore and rollback; assemble immutable per-component packages and final R4 manifest.
9. Request owner acceptance for the exact Lab release digest. Production cutover remains a separate change request.

## 6. Explicit non-claims and boundaries

- PR #149 being merged means only that its code is now on the PR #148 branch. It does **not** mean #148 is merged or Lab is deployed.
- PR CI and synthetic package smoke tests are not proof of a real provider message, a live Control Room round, Windows deployment, AutoCAD E2E or a successful offline rebuild.
- Do not use legacy `agent_send` or local-approval fallback as a substitute for the chosen chat-approved session.
- Do not send provider messages during source integration or deployment preflight.
- Do not change Production ports 17381/17382, credentials, tunnels, browser profiles, grants, autostart or working DWGs as part of this release preparation.
- Do not enable PowerShell/WM43 execution while effective state is read-only or while the approval trust boundary is unresolved.
- Do not publish a public release/tag until G0–G8 have evidence and the owner accepts the exact Lab artifact digest; Production remains separate.

## 7. Shared chat source

User-provided reference: https://chatgpt.com/share/6b075a56-55c8-83eb-b8ac-57ac10c887aa

The share could not be read from the available connected surface because the browser host denied access to chatgpt.com. This is not treated as evidence that the share is unavailable publicly, and its contents are not inferred. R4-B10 remains OPEN until its additional acceptance criteria are supplied in accessible text and cross-walked against G0–G9.

## 8. Traceability links

- R4 architecture and gates: [EDRP PR #134](https://github.com/rinatikd/nss-engine/pull/134)
- Platform release track: [PR #110](https://github.com/rinatikd/nss-engine/pull/110)
- PowerShell Direct: [PR #138](https://github.com/rinatikd/nss-engine/pull/138)
- Consilium: [PR #131](https://github.com/rinatikd/nss-engine/pull/131)
- Integrated Bridge candidate: [PR #148](https://github.com/rinatikd/nss-engine/pull/148)
- Provider-journal hardening merge: [PR #149](https://github.com/rinatikd/nss-engine/pull/149)
- Stop/Revoke follow-ups: [PR #127](https://github.com/rinatikd/nss-engine/pull/127), [PR #128](https://github.com/rinatikd/nss-engine/pull/128)
- Workbench: [PR #111](https://github.com/rinatikd/nss-engine/pull/111)
- CCTV release track: [PR #150](https://github.com/rinatikd/nss-engine/pull/150)
- AGPT Plugin: [repository](https://github.com/rinatikd/AGPT_Plugin)
- APS Expert: [repository](https://github.com/rinatikd/APS_Expert_0_15_commit)

---

**Release verdict on 2026-11-26: NO-GO for R4-REL release / GO for continued controlled integration.** The source foundation is substantially stronger, particularly the Bridge integration stack and Windows test coverage, but G2, G3, G4, G7, G8 and G9 are not accepted. The right next deliverable is an isolated, reproducible Lab release candidate with exact per-component manifests and evidence—not a tag over the current collection of Draft branches.
