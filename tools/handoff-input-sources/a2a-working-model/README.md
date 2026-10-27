# A2A-style task ledger + dispatcher (working model)

Node >= 22.13 (built-in `node:sqlite`), no dependencies.

    node --no-warnings --test tests/*.test.mjs     # 22 tests
    node --no-warnings src/demo.mjs                # ChatGPT -> Claude(mock) -> verify -> corrective task

## What it takes from A2A
Task lifecycle (submitted, working, input_required, completed, failed, canceled) + `unknown`,
contextId, parentId (corrective chains), artifacts, events (history). Not implemented: A2A transport,
Agent Card, auth, streaming -> this is the data/state model, not a conformant A2A server.

## Guarantees (and the test that proves each)
- Idempotent submit: same id+content = duplicate, same id+different content = conflict (ledger.test)
- Atomic claim: 8 OS processes, one winner (concurrency.test)
- Exactly-once dispatch: 4 processes drain 24 tasks, 24 sends (concurrency.test)
- Write-ahead marker before any send; fencing token + lease; stale owner's late result is recorded, never applied
- kill -9 after claim -> requeue; after marker/after send -> UNKNOWN, never auto-resent (crash.test)
- UNKNOWN has no exit for the dispatcher; only LedgerOperator can close it (completed/canceled); redo = new id
- Corrective tasks: bounded depth and per-context budget; built only from the sender's task text and whitelisted
  problem codes, never from reply text (flow.test)

## Not proven
- Power-loss durability (relies on SQLite WAL + synchronous=FULL; untested). kill -9 is tested.
- Real adapters: only MockAdapter exists. A real Claude/Codex/Chrome Bridge adapter must return
  {text, invocationId}, throw NotDispatched only with proof of non-delivery, otherwise the task goes UNKNOWN.
- Authentication/signing of senders; multi-host operation (SQLite is single-host).
