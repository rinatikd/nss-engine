# IPC v1.6 — Recovery protocol design (draft, NO-GO for production)

## Evidence baseline
PR #103 lab acceptance v1.5.6: 4/4 suites, 19/19 assertions PASS on operator Windows at 61dae9f. This validates self-only process control and fail-closed behavior, not general process execution or recoverability.

## Threat model and invariants
- Controller crash, concurrent controller startups, partial/corrupt marker, PID reuse, late descendant creation, unexpected job handles, access denial, and a second actor attempting recovery.
- **I1:** Never start a child unless an exclusive reservation for this generation is held.
- **I2:** Never release an unclean reservation on PID disappearance, elapsed time, a stale timestamp, or a process snapshot alone.
- **I3:** Every child is created suspended and assigned to a kill-on-close Job Object before resume; any failure terminates the suspended child.
- **I4:** Recovery cannot race with a new launch; a single OS-backed lock serializes reserve, inspect, and release.
- **I5:** Unknown, ambiguous, inaccessible, or corrupted state means DENY, not auto-reset.
- **I6:** Only lab-owned executables may run until separate security review and explicit authorization.

## Proposed recovery architecture (requires validation)
1. Create a per-installation private namespace with restricted Windows DACL; no global shared namespace and no predictable unrestricted object name.
2. Allocate a cryptographically random generation ID and persist a versioned journal atomically (write, flush, rename, flush as supported). Journal includes generation, expected job identity, controller process identity (PID plus creation time), and state transitions. A journal is evidence, **not** proof of empty job.
3. Maintain an OS-backed exclusive recovery mutex/lock across each reserve/inspect/release transaction; avoid deadlock and abandoned-lock ambiguity by treating abandonment as unclean.
4. Explore a named Job Object with restrictive DACL and explicit handle-lifetime protocol. **Important:** named Job Object can disappear when all handles close; an inability to reopen is not sufficient proof that no processes ever escaped. Named-job semantics and lifecycle must be independently tested under controller crashes.
5. Verify controller identity using a retained process handle or PID + creation time; validate job accounting and membership with a race-safe shutdown protocol. Prefer a dedicated trusted broker holding the job handle and observing lifecycle over attempting to reconstruct the job after every crash.
6. Broker design: broker owns Job Object and reservation, accepts only authenticated local IPC from the controller, creates suspended children, assigns job, resumes, and observes completion. Broker failure must kill its own job and leave reservation fail-closed. Broker restart never auto-releases without independent evidence.
7. Release requires a recorded, generation-matched, OS-verified zero-members transition and no pending launch. A crash without that proof requires explicit recovery review, not a silent reset.

## Lab validation gates
- Two concurrent reserve/recovery contenders: exactly one wins.
- Kill controller during suspended-create, after assignment, during descendant creation, during journal write, and during cleanup.
- Kill broker during launch and while children/grandchildren/conhost are active; hold kernel handles to all captured members; test late-descendant race separately.
- Corrupt/truncate journal; replace generation; simulate inaccessible object and abandoned lock; deny every uncertain recovery.
- Verify Windows job accounting and durable marker before/after each crash; preserve audit log without secrets.
- Run in isolated Windows lab only; do not touch production 17381/17382, credentials, tunnel, or real Codex.
- Record repeatable evidence and a security review before any production rollout.

## Current decision
**LAB GO** for v1.5.6 self-only proof. **RECOVERY IMPLEMENTATION NOT YET APPROVED FOR PRODUCTION.** No automatic stale-marker removal and no real Codex execution. This design is an engineering proposal, not proof of safe recovery.
