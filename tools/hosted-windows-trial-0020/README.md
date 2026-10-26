# Hosted Windows trial feasibility (source only)

This package evaluates GitHub-hosted Windows 2022/2025 as a non-production venue for synthetic broker isolation probes. It is separate from PR #46 and does not change that PR's draft status.

GitHub documents that every hosted job runs in a newly provisioned VM which is decommissioned when that job completes. Windows 2022 and 2025 are standard x64 VM labels. Therefore these runners are suitable as disposable guest OS instances for controlled process/token/job/file/network probes. An observer process in the VM can independently query the broker child, but it is not an observer outside GitHub's hypervisor. See [FEASIBILITY.md](FEASIBILITY.md) for the eight-case matrix.

The included workflow is manual-only (`workflow_dispatch`) and checks source text only. It does not compile or launch the broker, worker, Codex, or any native executable. This package has not dispatched that workflow. A PR-created draft does not trigger this workflow.

## Current blocker

The PR #46 inspector does not yet bind its verified file handle to a suspended child image before `ResumeThread`. The process-identity binding design in `FEASIBILITY.md` is a required engineering gate, not implemented code. The eight isolation probes remain blocked until that implementation is separately reviewed and an operator explicitly schedules a synthetic-only trial.

## Source-only validation

```powershell
node --test .\tests\feasibility.test.mjs
```

No actual OS isolation check is represented by this source test. No secrets or user configuration are required.

## References

- [Using GitHub-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners)
- [Choosing the runner for a job](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
- [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
