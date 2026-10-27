import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerOperator, STATE } from '../src/ledger.mjs';
import { runOnce } from '../src/dispatcher.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';
import { tmpdb, task, run, sends, sleep } from './util.mjs';

const killed = (r) => r.signal === 'SIGKILL';

test('SIGKILL right after claim: nothing was dispatched, so the task is safely re-queued and sent exactly once', async (t) => {
  const f = tmpdb(t); const l = new Ledger(f.db); t.after(() => l.close()); l.submit(task('j1'));
  assert.ok(killed(await run(['crash-after-claim', f.db, f.log, 'w1'])));
  assert.equal(l.get('j1').state, STATE.WORKING);
  await sleep(450); assert.deepEqual(l.reap(), { requeued: 1, unknown: 0 });
  const ad = new MockAdapter({ name: 'claude', logFile: f.log, behave: () => ({ text: 'ok' }) });
  assert.equal((await runOnce({ ledger: l, adapter: ad, owner: 'w2' })).status, 'completed');
  assert.deepEqual(sends(f.log), ['j1']);
});
test('SIGKILL after the write-ahead marker but before the send: state becomes UNKNOWN (cannot prove it was not sent), no resend', async (t) => {
  const f = tmpdb(t); const l = new Ledger(f.db); t.after(() => l.close()); l.submit(task('j1'));
  assert.ok(killed(await run(['crash-after-begin', f.db, f.log, 'w1'])));
  await sleep(450); assert.deepEqual(l.reap(), { requeued: 0, unknown: 1 });
  const ad = new MockAdapter({ name: 'claude', logFile: f.log, behave: () => ({ text: 'ok' }) });
  assert.equal((await runOnce({ ledger: l, adapter: ad, owner: 'w2' })).status, 'idle');
  assert.deepEqual(sends(f.log), [], 'conservative: nothing sent, and still nothing is auto-resent');
  assert.equal(l.get('j1').state, STATE.UNKNOWN);
});
test('SIGKILL after the message was sent: UNKNOWN, exactly one dispatch ever, only the operator closes it', async (t) => {
  const f = tmpdb(t); const l = new Ledger(f.db); t.after(() => l.close()); l.submit(task('j1'));
  assert.ok(killed(await run(['crash-after-send', f.db, f.log, 'w1'])));
  assert.deepEqual(sends(f.log), ['j1']);
  await sleep(450); l.reap();
  const ad = new MockAdapter({ name: 'claude', logFile: f.log, behave: () => ({ text: 'ok' }) });
  for (let i = 0; i < 3; i++) assert.equal((await runOnce({ ledger: l, adapter: ad, owner: 'w2' })).status, 'idle');
  assert.deepEqual(sends(f.log), ['j1']);
  const op = new LedgerOperator(f.db, 'rinat'); t.after(() => op.close());
  assert.equal(op.resolveUnknown('j1', 'completed', 'reply is visible in the chat').state, STATE.COMPLETED);
});
test('the committed write-ahead marker survives process death (it is on disk, not in memory)', async (t) => {
  const f = tmpdb(t); const l = new Ledger(f.db); t.after(() => l.close()); l.submit(task('j1'));
  await run(['crash-after-begin', f.db, f.log, 'w1']);
  const fresh = new Ledger(f.db); t.after(() => fresh.close());
  assert.equal(fresh.get('j1').dispatchStarted, true);
});
