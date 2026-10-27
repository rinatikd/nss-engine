import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, STATE } from '../src/ledger.mjs';
import { tmpdb, task, run, sends } from './util.mjs';

test('8 OS processes race to claim one task: exactly one wins', async (t) => {
  const f = tmpdb(t); const l = new Ledger(f.db); t.after(() => l.close()); l.submit(task('j1'));
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => run(['claim', f.db, f.log, `w${i}`, 'j1'])));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const wins = results.map((r) => JSON.parse(r.out)).filter((r) => r.ok);
  assert.equal(wins.length, 1);
  assert.equal(l.get('j1').fence, 1);
});
test('4 dispatcher processes drain 24 tasks: every task is dispatched exactly once and completed', async (t) => {
  const f = tmpdb(t); const l = new Ledger(f.db, { maxTasksPerContext: 100 }); t.after(() => l.close());
  const ids = Array.from({ length: 24 }, (_, i) => `job-${String(i).padStart(3, '0')}`);
  for (const id of ids) l.submit(task(id));
  const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => run(['drain', f.db, f.log, `d${i}`])));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const log = sends(f.log);
  assert.equal(log.length, 24, 'no duplicate dispatch');
  assert.deepEqual([...new Set(log)].sort(), ids);
  assert.ok(ids.every((id) => l.get(id).state === STATE.COMPLETED));
});
