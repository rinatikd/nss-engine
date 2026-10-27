import { LedgerError } from './ledger.mjs';

/** Adapter contract: throw NotDispatched ONLY if nothing left the process (provable). Any other error = outcome unknown. */
export class NotDispatched extends Error { constructor(m = 'NOT_DISPATCHED') { super(m); this.name = 'NotDispatched'; } }

const CODE = /^[A-Z0-9_]{1,40}$/;
const safe = (fn) => { try { return fn(); } catch (e) { if (e instanceof LedgerError) return null; throw e; } };

/**
 * One scheduling step for one adapter. Order is the whole safety argument:
 *   reap -> claim (atomic) -> beginDispatch (write-ahead, committed) -> adapter.send -> complete|unknown|release
 * Nothing in here can move a task out of UNKNOWN or send a task twice.
 */
export async function runOnce({ ledger, adapter, owner, ttlMs = 30000, verify = null }) {
  ledger.reap();
  const id = ledger.next(adapter.name);
  if (!id) return { status: 'idle' };
  const claim = ledger.claim(id, owner, ttlMs);
  if (!claim.ok) return { status: 'lost', id };
  const { fence } = claim;
  const task = ledger.get(id);
  try { ledger.beginDispatch(id, owner, fence); } catch { return { status: 'lease_lost', id }; }

  let res;
  try { res = await adapter.send(task); }
  catch (e) {
    if (e?.name === 'NotDispatched') { const t = safe(() => ledger.release(id, owner, fence, { proven: true, reason: 'not_dispatched' })); return { status: 'released', id, state: t?.state }; }
    safe(() => ledger.markUnknown(id, owner, fence, 'adapter_error'));
    return { status: 'unknown', id };
  }
  if (res?.kind === 'input_required' && typeof res.question === 'string') { safe(() => ledger.requireInput(id, owner, fence, res.question)); return { status: 'input_required', id }; }
  if (res?.kind !== 'response' || typeof res.text !== 'string') { safe(() => ledger.markUnknown(id, owner, fence, 'bad_adapter_result')); return { status: 'unknown', id }; }

  const artifact = { text: res.text, meta: { invocationId: typeof res.invocationId === 'string' ? res.invocationId : null, attested: typeof res.invocationId === 'string' && res.invocationId.length > 0, adapter: adapter.name } };
  if (!safe(() => ledger.complete(id, owner, fence, artifact))) return { status: 'late_result_recorded', id };

  // Reply text is untrusted DATA. It is only ever checked by `verify`; it is never parsed for commands.
  // A corrective task is built from the sender's own task text plus whitelisted problem codes, never from reply content.
  let followUp = null;
  if (verify) {
    const v = verify(task, artifact);
    if (!v?.ok) {
      const codes = (v?.problems ?? []).filter((c) => typeof c === 'string' && CODE.test(c)).slice(0, 8);
      try {
        const r = ledger.submit({ id: `${task.id}-fix${task.depth + 1}`, contextId: task.contextId, sender: 'dispatcher', recipient: task.recipient, parentId: task.id,
          text: `Correction for task ${task.id}. Problem codes: ${codes.join(', ') || 'UNSPECIFIED'}.\nOriginal task:\n${task.text}` });
        followUp = r.result;
      } catch (e) { followUp = e instanceof LedgerError ? 'refused:' + e.code : 'error'; }
    }
  }
  return { status: 'completed', id, followUp };
}

export async function drain(opts, { maxSteps = 100 } = {}) {
  const out = [];
  for (let i = 0; i < maxSteps; i++) { const r = await runOnce(opts); if (r.status === 'idle') break; out.push(r); }
  return out;
}
