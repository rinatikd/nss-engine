# PR138 — baseline refresh checkpoint

**Date:** 2026-11-26  
**PR:** [#138 — PowerShell Direct per-job workspace approval](https://github.com/rinatikd/nss-engine/pull/138)  
**PR138 head before this documentation-only checkpoint:** `73f3ad8f9ba0455ded2173bb583c6ed90c11b8c6`  
**Current target branch head:** `platform/ai-windows-control-release-20261114` at `cd29ecb6a9b037bfac432188aa784b6fcf82a281`.

## Target baseline changes

The platform target branch advanced after the shared CCTV release baseline was corrected:

- PR #110 head now includes the assertion fix: `cd29ecb6a9b037bfac432188aa784b6fcf82a281`.
- The corrected test asserts `Observe, м: 23.0`, matching the current CLI output.
- PR #110 exact-head validation on 2026-11-26: Source pull_request #45746528461 PASS (portable + Windows helper syntax); CCTV CLI guards #45746528513 PASS; AI collaboration protocol #45746528477 PASS; Source push #45746522905 PASS.
- The current PR138 synthetic merge candidate before this checkpoint was `67ef19e2992cc109fc6691c3944a5a7e22299eb3`, whose merged tree was verified to contain the corrected CCTV assertion. A new candidate will be generated for this updated PR138 head.

## Existing PR138 evidence (historical exact feature head)

PR138 head `73f3ad8f9ba0455ded2173bb583c6ed90c11b8c6` previously passed:
- Source checks #45561294815.
- AI collaboration protocol #45561294551.
- CCTV CLI guards #45561294534.

The PR body records 80/80 PowerShell Direct Node tests, Windows PowerShell 5.1 parser, 31 journal assertions / 7 transactions, and a synthetic pinned worktree/R2 stage. These are source/CI results, not proof of current-candidate Work PC deployment.

## Required revalidation

This commit is documentation-only and exists to trigger fresh PR checks against the updated target line. Verify the new PR138 merge commit, then require exact merge-candidate Source/Windows integration and named-suite checks before any merge decision.

## Boundaries

- PR #138 remains OPEN / Ready for review and NOT MERGED.
- No Work PC deployment, service or tunnel replacement, PowerShell Direct cutover, credential change or Production operation is performed.
- R2 remains diagnostics-only / execution-disabled until separate approved runtime evidence.
