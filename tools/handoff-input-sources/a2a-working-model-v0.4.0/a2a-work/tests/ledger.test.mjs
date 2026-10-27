import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerOperator, STATE } from '../src/ledger.mjs';
import { tmpdb, task, sleep } from './util.mjs';

const mk = (t, opts) => { const f = tmpdb(t); const l = new Ledger(f.db, opts); t.after(() => l.close()); return { ...f, l }; };
const code = (fn) => { try { fn(); } catch (e) { return e.code ?? e.message; } return null; };

test('submit is idempotent by id; same id with different content is a conflict, never silently reused', (t) => {
  const { l } = mk(t);
  assert.equal(l.submit(task('j1')).result, 'created');
  assert.equal(l.submit(task('j1')).result, 'duplicate');
  assert.equal(l.submit(task('j1', { text: 'different' })).result, 'conflict');
  assert.equal(l.get('j1').text, 'do the thing j1');
});
test('invalid input is rejected', (t) => {
  const { l } = mk(t);
  for (const bad of [task('bad id'), task('j', { recipient: 'Claude!' }), task('j', { text: '' }), task('j', { text: 'x'.repeat(70000) }), task('j', { contextId: '' })]) assert.equal(code(() => l.submit(bad)), 'INVALID_TASK');
});
test('state machine: no completion without write-ahead dispatch, wrong fence, wrong owner or stale lease', (t) => {
  const { l } = mk(t); l.submit(task('j1'));
  const { fence } = l.claim('j1', 'w1', 60000);
  assert.equal(code(() => l.complete('j1', 'w1', fence, { text: 'x' })), 'STALE_OR_ILLEGAL');   // not dispatched yet
  l.beginDispatch('j1', 'w1', fence);
  assert.equal(code(() => l.beginDispatch('j1', 'w1', fence)), 'STALE_OR_ILLEGAL');             // marker is written once
  assert.equal(code(() => l.complete('j1', 'w2', fence, { text: 'x' })), 'STALE_OR_ILLEGAL');   // other owner
  assert.equal(code(() => l.complete('j1', 'w1', fence + 1, { text: 'x' })), 'STALE_OR_ILLEGAL'); // wrong fence
  assert.equal(l.complete('j1', 'w1', fence, { text: 'ok', meta: { invocationId: 'i1' } }).state, STATE.COMPLETED);
  assert.equal(code(() => l.complete('j1', 'w1', fence, { text: 'again' })), 'STALE_OR_ILLEGAL'); // terminal
  assert.equal(code(() => l.cancel('j1')), 'STALE_OR_ILLEGAL');
});
test('claim is single-winner; a claimed task cannot be claimed again', (t) => {
  const { l } = mk(t); l.submit(task('j1'));
  assert.equal(l.claim('j1', 'w1', 1000).ok, true);
  assert.equal(l.claim('j1', 'w2', 1000).ok, false);
});
test('release after dispatch is denied unless the adapter proved non-delivery; attempts are bounded', (t) => {
  const { l } = mk(t, { maxAttempts: 2 }); l.submit(task('j1'));
  let c = l.claim('j1', 'w1', 1000); l.beginDispatch('j1', 'w1', c.fence);
  assert.equal(code(() => l.release('j1', 'w1', c.fence)), 'RELEASE_AFTER_DISPATCH_DENIED');
  assert.equal(l.release('j1', 'w1', c.fence, { proven: true }).state, STATE.SUBMITTED);
  c = l.claim('j1', 'w1', 1000); assert.equal(c.fence, 2);
  assert.equal(l.release('j1', 'w1', c.fence, { proven: true }).state, STATE.FAILED, 'gives up after maxAttempts');
});
test('lease expiry + fencing: a stale owner cannot complete; its late result is recorded for the operator, not applied', async (t) => {
  let now = 1000; const { l } = mk(t, { now: () => now }); l.submit(task('j1'));
  const a = l.claim('j1', 'w1', 100); now += 200;
  assert.deepEqual(l.reap(), { requeued: 1, unknown: 0 });          // not dispatched => provably unsent => back to the queue
  const b = l.claim('j1', 'w2', 100); assert.equal(b.fence, a.fence + 1);
  l.beginDispatch('j1', 'w2', b.fence);
  assert.equal(code(() => l.beginDispatch('j1', 'w1', a.fence)), 'STALE_OR_ILLEGAL');
  now += 200; assert.deepEqual(l.reap(), { requeued: 0, unknown: 1 }); // dispatched, lease lost => UNKNOWN
  assert.equal(code(() => l.complete('j1', 'w2', b.fence, { text: 'late', meta: {} })), 'STALE_OR_ILLEGAL');
  assert.equal(l.get('j1').state, STATE.UNKNOWN);
  assert.ok(l.events('j1').some((e) => e.kind === 'late_result_rejected' && e.body.artifact.text === 'late'));
});
test('UNKNOWN is a trap for everything except the operator: no claim, release, reap, cancel, next', (t) => {
  let now = 0; const { l, db } = mk(t, { now: () => now }); l.submit(task('j1'));
  const c = l.claim('j1', 'w1', 100); l.beginDispatch('j1', 'w1', c.fence); l.markUnknown('j1', 'w1', c.fence, 'timeout');
  assert.equal(l.claim('j1', 'w2', 100).ok, false);
  assert.equal(code(() => l.release('j1', 'w1', c.fence, { proven: true })), 'STALE_OR_ILLEGAL');
  assert.equal(code(() => l.cancel('j1')), 'STALE_OR_ILLEGAL');
  now += 10 ** 9; assert.deepEqual(l.reap(), { requeued: 0, unknown: 0 });
  assert.equal(l.next('claude'), null, 'never offered to a dispatcher again');
  assert.equal(l.resolveUnknown, undefined, 'the dispatcher-facing handle has no way out of UNKNOWN');
  const op = new LedgerOperator(db, 'rinat'); t.after(() => op.close());
  assert.equal(code(() => op.resolveUnknown('j1', 'submitted', 'resend please')), 'INVALID_RESOLUTION', 'no operator path to a resend either: redo = new id');
  assert.equal(code(() => op.resolveUnknown('j1', 'canceled', 'x')), 'INVALID_RESOLUTION');
  const r = op.resolveUnknown('j1', 'canceled', 'checked the chat: message absent');
  assert.equal(r.state, STATE.CANCELED);
  assert.equal(code(() => op.resolveUnknown('j1', 'completed', 'second try')), 'ONLY_UNKNOWN_CAN_BE_RESOLVED');
  assert.deepEqual(l.events('j1').at(-1).body, { by: 'rinat', outcome: 'canceled', note: 'checked the chat: message absent' });
});
test('corrective-task budget: depth limit and per-context cap', (t) => {
  const { l } = mk(t, { maxDepth: 2, maxTasksPerContext: 4 });
  l.submit(task('a')); l.submit(task('a1', { parentId: 'a' })); l.submit(task('a2', { parentId: 'a1' }));
  assert.equal(code(() => l.submit(task('a3', { parentId: 'a2' }))), 'DEPTH_LIMIT');
  assert.equal(code(() => l.submit(task('b', { parentId: 'nope' }))), 'PARENT_INVALID');
  l.submit(task('c'));
  assert.equal(code(() => l.submit(task('d'))), 'BUDGET_EXCEEDED');
});
test('state survives reopening the database (restart)', (t) => {
  const f = tmpdb(t); let l = new Ledger(f.db); l.submit(task('j1'));
  const c = l.claim('j1', 'w1', 60000); l.beginDispatch('j1', 'w1', c.fence); l.markUnknown('j1', 'w1', c.fence, 'timeout'); l.close();
  l = new Ledger(f.db); t.after(() => l.close());
  assert.equal(l.get('j1').state, STATE.UNKNOWN);
  assert.equal(l.submit(task('j1')).result, 'duplicate');
});
test('fingerprints are keyed: the database holds no raw hash of the task text', (t) => {
  const { l } = mk(t); l.submit(task('j1'));
  const raw = JSON.stringify(l.get('j1'));
  assert.ok(!raw.includes('fingerprint'));
  assert.notEqual(l.fingerprint('ctx-1', 'claude', 'do the thing j1'), require_sha('ctx-1', 'claude', 'do the thing j1'));
});
import crypto from 'node:crypto';
function require_sha(c, r, x) { return crypto.createHash('sha256').update(JSON.stringify([c, r, x])).digest('hex'); }
