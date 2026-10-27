# AI Coordination Dispatcher v0.4 — local prototype

Builds upon v0.3. This is **not deployed**. No GitHub/model credentials are included. The active Chrome Bridge and CODEX_DISABLED are untouched.

## Added
- SQLite WAL outbox with states `PENDING -> SENDING -> POSTED | UNKNOWN`. Unexpected process death marks `SENDING` as `UNKNOWN`. No automatic retry of `UNKNOWN`; manual forensic reconciliation required.
- A GitHub publishing CLI requiring explicit `--live-publish` and a supplied `GITHUB_TOKEN`. Missing credentials leave tasks PENDING.
- Mock replies are not staged for GitHub; stage only authenticated model results into durable outbox.
- Atomic UTC daily provider **invocation/planned-token caps**, both defaulting to **zero**. Live model requests require `--live` PLUS `ANTHROPIC_API_KEY`, `AI_LEDGER_HMAC_KEY`, `AI_MAX_CALLS_PER_DAY`, `AI_MAX_PLANNED_TOKENS_PER_DAY`. Estimated tokens are a heuristic, **not a hard money cap**; enforce actual spend via provider account limits too.
- Quoted untrusted model text in comments, with SHA-256 and provider invocation id. Such text is not independent agent authentication or authorization.

## Safe test
`python -m unittest discover -v -p 'test_*.py'`

## Example manual flow (does not make paid calls)
1. Run `python worker.py --queue queue --db state.sqlite` with mock queue JSON items (as in v0.3).
2. For a real permitted provider run, use `python dispatcher.py --db state.sqlite --task-id EXAMPLE --prompt ... --live` with the explicit env caps. Record the result in a JSON array file (never include secrets).
3. `python stage_results.py --db state.sqlite --results-file results.json` enqueues only authenticated `RESPONDED` outcomes.
4. `python outbox.py --db state.sqlite publish --task-id EXAMPLE --live-publish` performs a **real GitHub comment POST** when valid `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_ISSUE_NUMBER` environment variables exist. Do not run this until credentials and approval are configured.
5. `python outbox.py --db state.sqlite recover` changes interrupted SENDING to UNKNOWN, **not PENDING**.

## Unresolved / do not deploy
- No hard cost cap: planned token estimates can differ from billed usage. No independent GitHub receipt verification after ambiguous network errors.
- No provider-backed end-to-end run was performed. `dispatcher.py --publish` has been disabled to prevent bypassing the durable outbox. Use the staged outbox path after further integration/review.
- No unattended scheduler installed; no backend GitHub App, signed run identity or reviewer feedback loop.
- Source-only Python tests cannot establish Windows/Codex security isolation.

## v0.5: read-only GitHub receipt reconciliation + review drafts
- `receipt.py` reads GitHub Issue comments with explicit `--live-read`, verifies exact comment body and expected GitHub author, and reconciles an ambiguous `UNKNOWN` to `POSTED` **only when exactly one match exists**. No match means `NOT_FOUND_NO_RETRY` (never automatically resend); two matches means `AMBIGUOUS`. This verifies that a GitHub comment exists, **not** that a particular model received or authored it.
- `review_loop.py` checks provider-evidence shape, SHA256 and response presence; creates an approval-required revision *draft* with max revision depth 2. It **never invokes a model**, accepts model claims as untrusted, and is not an independent quality assessment.
- `python -m unittest discover -v -p 'test_*.py'` runs local tests.
- Read-only receipt check, only if you separately authorize it and configure GITHUB_TOKEN as environment variable (do not put secrets in repo): `python receipt.py --db state.sqlite --task-id TASK --repo rinatikd/nss-engine --issue 40 --expected-login YOUR_DISPATCHER_APP --live-read`
- No external API calls were made during test. GitHub read-back cannot provide exactly-once delivery; absent comments are inconclusive. Explicit scope: `CODEX_DISABLED` and production remain unchanged.

## v0.6 — single-channel pilot (source-only, NOT deployed)
Added `pilot.py`: one command coordinates dispatcher -> local evidence validation -> durable GitHub outbox staging. **It does not publish** and cannot bypass `outbox.py --live-publish` authorization. `--live-claude` is opt-in and requires the API key, HMAC key, and budget environment limits enforced by `dispatcher.py`. By default, mock response is returned without entering the GitHub outbox.

```powershell
python -m unittest discover -v -p 'test_*.py'
python pilot.py --db .\state.sqlite --task-id dry-0001 --prompt 'Review the coordination design'
```

To perform a *real* opt-in pilot (this has NOT been run by the author): configure `ANTHROPIC_API_KEY`, a random 32+ character `AI_LEDGER_HMAC_KEY`, `AI_MAX_CALLS_PER_DAY`, `AI_MAX_PLANNED_TOKENS_PER_DAY`, plus provider spending limits; run `python pilot.py --db state.sqlite --task-id LIVE-0001 --prompt-file task.txt --live-claude`. Upon a verifiable provider response, a GitHub comment is **staged only**, not posted. Review it and separately run `python outbox.py --db state.sqlite publish --task-id LIVE-0001 --live-publish` with authorized `GITHUB_TOKEN`, `GITHUB_REPOSITORY` and `GITHUB_ISSUE_NUMBER`. Verify with `receipt.py` using the actual dispatcher GitHub login. Do not insert secrets in task JSON, prompts, or GitHub files.

Caveats: The local `review_loop.py` only checks reply metadata/hash and is **not** semantic AI quality review. Provider response IDs and any GitHub author alone do not prove autonomous Claude.ai consumer-session delivery. The optional Claude API is a separate provider channel. No automatic recursive corrections, timer installation, Windows native isolation, production deployment, or live API test has been carried out. UNKNOWN must never be automatically retried. Budget planning uses heuristic tokens and must be backed by actual provider spending limits.

## v0.7 — guarded live-pilot readiness and read-only reconciliation

New files: `readiness.py`, `reconcile_pilot.py`, `test_v07.py`.

Run `python readiness.py --check` before any paid API or GitHub write. Readiness does **not** authenticate credentials, validate provider account limits, or enable network traffic; it only checks configuration shapes and explicit operator opt-in. No credentials should be posted to chat or committed into Git.

Run `python reconcile_pilot.py --db state.sqlite --task-id TASK_ID` to read GitHub Issue comments for exact-body matches on an UNKNOWN publication. This is a read-only report (`MATCH_OBSERVED_UNVERIFIED`) and **never** changes SQLite status to POSTED automatically, never resends, and does not attest a model's identity. It relies on GitHub issue read permission and requires `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and `GITHUB_ISSUE_NUMBER` environment values.

For a dry run: `python -m unittest discover -v -p 'test_*.py'`; `python pilot.py --db state.sqlite --task-id dry-001 --prompt 'Check handshake'`.

**Known limitations:** no live Anthropic API or GitHub POST performed; no autonomous daemon, model review, actual proof-of-delivery or production validation. Existing v0.6 pilot flags remain guarded. `CODEX_DISABLED` is not modified. Operator must separately authorize, provision scoped secrets and set billing limits before any real run.

## v0.8 — persistent human review decisions and bounded correction drafts

Added `review_queue.py` and `test_v08.py`. After a response has been independently checked by a human reviewer, record an explicit `APPROVE`, `REJECT`, or `REVISE` decision bound to the exact SHA-256 of the response. An identical repeated decision is idempotent; conflicting answers or decisions are refused. `REVISE` creates a durable *draft only* for the next revision (at most two revisions). **This is not semantic automated model review** and does not submit followups or invoke providers.

Example (safe; no network):

```powershell
python -m unittest discover -v -p 'test_*.py'
python review_queue.py --db state.sqlite --task-id REVIEW-001 --response-file response.txt --decision REVISE --critique 'Cite the missing test evidence' --revision 0
```

The review queue does not read the provider's authenticated evidence itself; the reviewer must verify invocation and answer integrity using the existing evidence checks before recording a decision. Follow-up task creation is purposely not connected to an automatic dispatch path. Remains undeployed; no live provider call or GitHub publication verified.

## v0.9 — Independent advisory AI reviewer (source-only pilot)

`ai_reviewer.py` adds an independent Claude-review adapter around the existing review queue. **Default operation is offline mock only**. The model must return a strict JSON verdict (`ai-review-verdict/v1`: `APPROVE`, `REVISE`, `REJECT`, critique, evidence gaps). Invalid JSON is quarantined; valid reviews are advisory only. No review is treated as a human acceptance or sent as an autonomous revision. `REVISE` creates only a `DRAFT_REQUIRES_APPROVAL` item; maximum revision depth remains two.

### Offline trial

```powershell
python -m unittest discover -v -p "test_*.py"
Set-Content response.txt 'Answer with a citation'
Set-Content rubric.txt 'Verify cited evidence and identify unsupported claims'
python ai_reviewer.py --db state.sqlite --task-id REVIEW09 --response-file response.txt --rubric-file rubric.txt
```

### Live review is opt-in, NOT exercised in release tests

A live call requires `--live`, `AI_REVIEW_LIVE_APPROVED=YES` and properly configured `ANTHROPIC_API_KEY`; **it incurs API charges**. No provider credentials are bundled. The first live attempt reserves the task in SQLite *before* invoking Claude. The reservation stays `UNKNOWN` unless independently resolved; an identical second live attempt returns `ALREADY_ATTEMPTED`, and changed content gives `CONFLICT`. This is intentionally conservative. The v0.9 reviewer does **not** yet implement its own maximum-spend reservation; operators must not enable live calls until a validated budget gate has been integrated for review costs. No outbound GitHub posting takes place in this module.

Tests do not exercise real Claude, real GitHub, Windows VM, or production Chrome Bridge.

## v0.10 — Windows text encoding, reviewer budget and UNKNOWN containment

- `ai_reviewer.py` detects UTF-8 with/without BOM and BOM-marked UTF-16 (PowerShell 5.1 often emits UTF-16). Legacy CP1251/CP866 is **explicit**: `--input-encoding cp1251` or `cp866`. Unknown encodings fail with a readable CLI error; there is no silent fallback.
- Live review requires `--live`, `AI_REVIEW_LIVE_APPROVED=YES`, and two **positive** daily caps: `AI_REVIEW_MAX_CALLS_PER_DAY` and `AI_REVIEW_MAX_PLANNED_TOKENS_PER_DAY`. Default values are zero (blocked). Caps track **estimated** input plus a 512-token response budget, not actual billed currency or exact tokenization; they are not a hard monetary spending limit.
- One SQLite `BEGIN IMMEDIATE` transaction reserves BOTH reviewer attempt and daily reviewer quota. Failed/ambiguous provider calls remain `UNKNOWN`; no automated retries. The reviewer returns a non-secret sanitized status for invocation failures.
- No remote API requests or GitHub writes occur during tests. Live invocation requires operator-provisioned secrets and approval; this release does not deploy or activate a background scheduler.

### Windows mock proof of life

```powershell
[System.IO.File]::WriteAllText("$PWD\response.txt", "Ответ исполнителя", [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText("$PWD\rubric.txt", "Проверить полноту и доказательства", [System.Text.UTF8Encoding]::new($false))
python ai_reviewer.py --db state.sqlite --task-id REVIEW10 --response-file response.txt --rubric-file rubric.txt
python -m unittest discover -v -p "test_*.py"
```

For BOM-marked UTF-16 files produced by Windows PowerShell, no switch is required. For unmarked legacy codepages, use `--input-encoding cp1251` **only** when that is the real encoding.

## v0.11 — read-only end-to-end evidence gate

New `cycle_v11.py` is a **read-only, fail-closed** state inspection layer. It inspects the
existing SQLite ledger, durable GitHub outbox and Review Queue. For an explicit
provider response, it requires the recorded Claude adapter's `authenticated=True`
claim, a `msg_` invocation identifier, nonempty reply and exact response SHA-256.
**This is not an independent cryptographic attestation of Claude API origin**.

Before claiming a published response, it requires the outbox `POSTED` state and
separately provided GitHub API comment evidence matching comment ID, complete body
and expected GitHub bot username. A GitHub display name alone cannot authenticate
a model. A missing, duplicated or mismatched comment is rejected. A human review
must match the response's exact SHA-256; `REVISE` leaves a draft and never sends it.

The command-line inspection deliberately performs **no HTTP requests**; when no
fresh GitHub comments are supplied by an authorized read-only fetcher, it returns
`NEEDS_READONLY_GITHUB_RECONCILIATION` rather than inventing success.

```powershell
python -m unittest discover -v -p 'test_*.py'
$env:AI_LEDGER_HMAC_KEY = '<your-existing-ledger-key>'
python cycle_v11.py --db state.sqlite --task-id REVIEW10
```

Do not replace an existing ledger key: the HMAC is used for task idempotency.
Keep keys outside source control. v0.11 does not set up Claude/GitHub credentials,
run a real model, provision a scheduler, attest provider identity cryptographically,
or enable Codex. Real API, real GitHub POST and full round trip remain unverified.

## v0.12 — offline pilot evidence snapshot

New module: `pilot_evidence_v12.py` and `test_v12.py`. Creates a **read-only**, HMAC-protected evidence snapshot from the existing SQLite state and, optionally, a locally saved GitHub Issues comments JSON array. No network connections, no provider calls, no GitHub writes, no automatic followups, no changes to CODEX_DISABLED or Chrome Bridge.

```powershell
python -m unittest discover -v -p 'test_*.py'
$env:AI_LEDGER_HMAC_KEY = '<your existing secure ledger key, >=32 chars>'
python pilot_evidence_v12.py --db state.sqlite --task-id REVIEW10 --output evidence-REVIEW10.json
```

For a reconciliation snapshot, first independently collect comments via a trusted GitHub API client and securely save the JSON array of `{id,body,user:{login}}` objects locally, then:

```powershell
python pilot_evidence_v12.py --db state.sqlite --task-id REVIEW10 --comments-json comments.json --expected-login <trusted-github-app-login> --output evidence-REVIEW10.json
```

Input comments are **untrusted user-supplied data**; this does not authenticate a GitHub API response, a Claude provider invocation, or the reviewer identity. HMAC protects the snapshot against accidental alteration *on the same key-holding machine* and is not remote attestation. `cycle_v11.py` deliberately still requires a recorded `RESPONDED` task, `POSTED` outbox, exact comment id/body/username match, and a review with the correct response hash. A local fixture cannot substitute for actual cloud evidence. Do not put HMAC key, GitHub tokens, provider keys, or unredacted prompts into exported reports.

Independent tests: 94 PASS on Python 3.13 in this build environment. Windows Python 3.15, actual Claude invocation, GitHub publication and scheduled operations have **not** been verified here. To run a real end-to-end pilot requires real API credentials supplied through a secure environment, an explicit spend limit, verified GitHub App authorization, and operator approval; none is auto-enabled by this package.

---

## v0.13 — operator-gated Claude pilot

Added `pilot_v13.py` and `test_v13.py`. This release **does not** deploy a live
Claude-to-GitHub connection. All secrets remain external. The existing v0.12
modules have been retained and tested as a whole.

**Test on Windows (Python 3.13+ expected; the user uses Python 3.15):**

```powershell
python -m unittest discover -v -p 'test_*.py'
python pilot_v13.py --db state-v13.sqlite --task-id demo-v13-001 --prompt 'Review a synthetic task'
python pilot_v13.py --db state-v13.sqlite --task-id live-v13-001 --prompt 'A test' --live-claude --preflight-only
```

Mock mode sends **no provider requests and no GitHub writes**. Repeating the same
`task-id` does not invoke another model, even after a previous `UNKNOWN`.

`--live-claude` is disabled unless *all* the following environment values are
set correctly: `AI_LEDGER_HMAC_KEY` (>=32 characters), `ANTHROPIC_API_KEY`,
`GITHUB_TOKEN`, `GITHUB_REPOSITORY=rinatikd/nss-engine`,
`GITHUB_ISSUE_NUMBER=40`, `AI_MAX_CALLS_PER_DAY` and
`AI_MAX_PLANNED_TOKENS_PER_DAY` (both positive),
`AI_APPROVE_REAL_REQUEST=YES_I_APPROVE_ONE_PAID_CLAUDE_REQUEST`, and
`AI_APPROVE_GITHUB_WRITE=YES_I_APPROVE_GITHUB_ISSUE_WRITE`.
Never send API tokens in chat, commit them, or add them to logs. A positive
preflight checks only format/presence; it does not prove credentials, spending
allowance, or remote permissions. Planned-token caps are estimates, not hard
billing caps. Use a dedicated disposable test task-id and a minimal-cost task.

In live mode, an actual Claude response is **staged** in SQLite GitHub Outbox,
not published directly. Publication requires a separate reviewed operation:

```powershell
python outbox.py --db state-v13.sqlite publish --task-id live-v13-001 --live-publish
```

Only use that last command after the staged body has been reviewed and GitHub
credentials/permission are confirmed. A failed or ambiguous POST results in
`UNKNOWN` and requires manual read-only reconciliation, **not automatic retry**:

```powershell
python receipt.py --db state-v13.sqlite --task-id live-v13-001 --repo rinatikd/nss-engine --issue 40 --expected-login YOUR_GITHUB_ACTOR --live-read
```

Limitations: no independent third-party agent attestation; no autonomous
follow-up publication; no continuously running scheduler; no genuine provider
invocation was performed in the release tests; Windows-native sandbox/Codex
execution not involved. Keep the source environment isolated from production.


## v0.14 — read-only operator verification

The new `pilot_ops_v14.py` never submits a model prompt or GitHub comment. It only reports what is known.

```powershell
python -m unittest discover -v -p "test_*.py"
python pilot_ops_v14.py doctor
python pilot_ops_v14.py inspect --db state-v13.sqlite --task-id DEMO-13
```

For an **explicit live read of GitHub only**, configure `GITHUB_TOKEN` with read-only Issues permission and `GITHUB_REPOSITORY` and run:

```powershell
python pilot_ops_v14.py verify-github --db state.sqlite --task-id LIVE-13 --expected-login YOUR_GITHUB_APP_LOGIN --live-read
```

The observed exact-body comment is **not** proof of a real AI provider invocation. A local `POSTED` entry is likewise not sufficient. If GitHub is unreachable or multiple matches appear, status is `READ_FAILED` / `AMBIGUOUS` and the program never retries publishing.

Real live provider dispatch remains gated behind separate operator opt-in in `pilot_v13.py`. Do not put API keys in chat, the repository or plaintext artifacts.
